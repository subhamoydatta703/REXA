import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import chalk from "chalk";
import { password } from "@inquirer/prompts";
import keytar from "keytar";

const CONFIG_DIR = path.join(os.homedir(), ".rexa");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const CONFIG_KEY_FILE = path.join(CONFIG_DIR, "config.key");
const KEYTAR_SERVICE = "rexa";
const GEMINI_ACCOUNT = "gemini-api-key";
const TAVILY_ACCOUNT = "tavily-api-key";

// Kept only to read configurations written by the old implementation.
const LEGACY_MACHINE_KEY = crypto
    .createHash("sha256")
    .update(`rexa::${os.hostname()}::${os.userInfo().username}`)
    .digest();

function loadConfigKey(): Buffer {
    const configuredKey = process.env.REXA_CONFIG_KEY?.trim();
    if (configuredKey) {
        const key = Buffer.from(configuredKey, "base64");
        if (key.length !== 32) {
            throw new Error("REXA_CONFIG_KEY must be a base64-encoded 32-byte key");
        }
        return key;
    }

    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    if (fs.existsSync(CONFIG_KEY_FILE)) {
        const key = fs.readFileSync(CONFIG_KEY_FILE);
        if (key.length !== 32) throw new Error("Invalid REXA config key file");
        enforcePermissions(CONFIG_KEY_FILE, 0o600);
        return key;
    }

    const key = crypto.randomBytes(32);
    fs.writeFileSync(CONFIG_KEY_FILE, key, { mode: 0o600, flag: "wx" });
    enforcePermissions(CONFIG_KEY_FILE, 0o600);
    return key;
}

const CONFIG_KEY = loadConfigKey();

const IV_LENGTH = 16;
const ALGORITHM = "aes-256-gcm";
const AUTH_TAG_LENGTH = 16;

export interface RexaConfig {
    geminiApiKey?: string;
    tavilyApiKey?: string;
    updatedAt?: string;
}

/**
 * Encrypts a string using AES-256-GCM with a randomly generated key.
 * Output format: gcm:<hex_iv>:<hex_auth_tag>:<hex_encrypted>
 */
function encrypt(text: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, CONFIG_KEY, iv, { authTagLength: AUTH_TAG_LENGTH });
    let encrypted = cipher.update(text, "utf-8", "hex");
    encrypted += cipher.final("hex");
    return "gcm:" + iv.toString("hex") + ":" + cipher.getAuthTag().toString("hex") + ":" + encrypted;
}

/**
 * Decrypts the current AES-256-GCM format and reads legacy formats during migration.
 */
function decrypt(text: string): string {
    try {
        const [version, ivHex, tagHex, encryptedHex] = text.split(":");
        if (version === "gcm" && ivHex && tagHex && encryptedHex) {
            const iv = Buffer.from(ivHex, "hex");
            for (const key of [CONFIG_KEY, LEGACY_MACHINE_KEY]) {
                try {
                    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
                    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
                    let decrypted = decipher.update(encryptedHex, "hex", "utf-8");
                    decrypted += decipher.final("utf-8");
                    return decrypted;
                } catch {
                    // Try the legacy key before treating the value as invalid.
                }
            }
        }
        // Read the previous unauthenticated AES-CBC format during migration.
        const legacyParts = text.split(":");
        if (legacyParts.length === 2 && legacyParts[0] && legacyParts[1]) {
            const decipher = crypto.createDecipheriv("aes-256-cbc", LEGACY_MACHINE_KEY, Buffer.from(legacyParts[0], "hex"));
            let decrypted = decipher.update(legacyParts[1], "hex", "utf-8");
            decrypted += decipher.final("utf-8");
            return decrypted;
        }
        if (/^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length % 4 === 0) {
            return Buffer.from(text, "base64").toString("utf-8");
        }
        throw new Error("Unsupported encrypted config value");
    } catch {
        // If decryption fails entirely, return as-is (plain text fallback)
        return "";
    }
}

/**
 * Enforces strict file/directory permissions.
 * On Windows, chmod is a no-op but we still call it for cross-platform compat.
 */
function enforcePermissions(filePath: string, mode: number): void {
    try {
        fs.chmodSync(filePath, mode);
    } catch {
        // Windows NTFS doesn't support Unix permissions; silently ignored
    }
}

export class ConfigManager {
    /**
     * Reads and decrypts config from ~/.rexa/config.json
     */
    static async getConfig(): Promise<RexaConfig> {
        try {
            const [geminiApiKey, tavilyApiKey] = await Promise.all([
                keytar.getPassword(KEYTAR_SERVICE, GEMINI_ACCOUNT),
                keytar.getPassword(KEYTAR_SERVICE, TAVILY_ACCOUNT),
            ]);
            if (geminiApiKey || tavilyApiKey) {
                return { geminiApiKey: geminiApiKey || undefined, tavilyApiKey: tavilyApiKey || undefined };
            }
        } catch {
            // Fall back to the encrypted legacy file if the OS vault is unavailable.
        }

        try {
            if (fs.existsSync(CONFIG_FILE)) {
                const content = fs.readFileSync(CONFIG_FILE, "utf-8");
                const parsed = JSON.parse(content);
                if (parsed.geminiApiKey) {
                    parsed.geminiApiKey = decrypt(parsed.geminiApiKey);
                }
                if (parsed.tavilyApiKey) {
                    parsed.tavilyApiKey = decrypt(parsed.tavilyApiKey);
                }
                return parsed;
            }
        } catch {
            // Config corrupted or key mismatch — return empty
        }
        return {};
    }

    /**
     * Encrypts and saves config to ~/.rexa/config.json with strict permissions.
     */
    static saveConfig(config: RexaConfig): boolean {
        try {
            // Create directory with owner-only access
            if (!fs.existsSync(CONFIG_DIR)) {
                fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
            }
            enforcePermissions(CONFIG_DIR, 0o700);

            const dataToSave = {
                geminiApiKey: config.geminiApiKey ? encrypt(config.geminiApiKey) : undefined,
                tavilyApiKey: config.tavilyApiKey ? encrypt(config.tavilyApiKey) : undefined,
                updatedAt: config.updatedAt,
            };

            // Write with owner-only read/write
            const tempFile = `${CONFIG_FILE}.${process.pid}.tmp`;
            fs.writeFileSync(tempFile, JSON.stringify(dataToSave, null, 2), {
                encoding: "utf-8",
                mode: 0o600,
            });
            enforcePermissions(tempFile, 0o600);
            fs.renameSync(tempFile, CONFIG_FILE);
            enforcePermissions(CONFIG_FILE, 0o600);
            return true;
        } catch (error: any) {
            console.error(chalk.red(`  ✗ Failed to save config: ${error.message}`));
            return false;
        }
    }

    /**
     * Sets Gemini API key (encrypted on disk).
     */
    static async setGeminiApiKey(key: string): Promise<void> {
        const trimmed = key.trim();
        if (!trimmed) {
            console.log(chalk.red("  ✗ Gemini API Key cannot be empty."));
            return;
        }
        try {
            await keytar.setPassword(KEYTAR_SERVICE, GEMINI_ACCOUNT, trimmed);
        } catch (error) {
            console.error(chalk.red(`  ✗ Failed to store Gemini API key in the OS credential vault: ${error instanceof Error ? error.message : String(error)}`));
            return;
        }
        console.log(chalk.green("  ✓ Gemini API Key securely saved to ") + chalk.gray(CONFIG_FILE));
    }

    /**
     * Sets Tavily API key (encrypted on disk).
     */
    static async setTavilyApiKey(key: string): Promise<void> {
        const trimmed = key.trim();
        if (!trimmed) {
            console.log(chalk.red("  ✗ Tavily API Key cannot be empty."));
            return;
        }
        try {
            await keytar.setPassword(KEYTAR_SERVICE, TAVILY_ACCOUNT, trimmed);
        } catch (error) {
            console.error(chalk.red(`  ✗ Failed to store Tavily API key in the OS credential vault: ${error instanceof Error ? error.message : String(error)}`));
            return;
        }
        console.log(chalk.green("  ✓ Tavily Search API Key securely saved to ") + chalk.gray(CONFIG_FILE));
    }

    /**
     * Gets Gemini API Key from env vars or encrypted config.
     */
    static async getGeminiApiKey(): Promise<string | undefined> {
        const envKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY;
        if (envKey && envKey.trim()) return envKey.trim();

        const config = await this.getConfig();
        if (config.geminiApiKey && config.geminiApiKey.trim()) return config.geminiApiKey.trim();

        return undefined;
    }

    /**
     * Gets Tavily Search API Key from env vars or encrypted config.
     */
    static async getTavilyApiKey(): Promise<string | undefined> {
        const envKey = process.env.TVLY_API_KEY || process.env.TAVILY_API_KEY;
        if (envKey && envKey.trim()) return envKey.trim();

        const config = await this.getConfig();
        if (config.tavilyApiKey && config.tavilyApiKey.trim()) return config.tavilyApiKey.trim();

        return undefined;
    }

    /**
     * Ensures Gemini API key is present. Shows setup instructions if missing.
     */
    static async ensureApiKey(): Promise<string> {
        let key = await this.getGeminiApiKey();

        if (!key) {
            console.log("\n" + chalk.yellow.bold("  ⚠  Gemini API Key missing!"));
            console.log(chalk.gray("  ─────────────────────────────────────────────────────────"));
            console.log(chalk.white("  You can set your API key anytime using either method:"));
            console.log("");
            console.log(chalk.cyan("    1. Command:  ") + chalk.bold.white("rexa config set-key <YOUR_GEMINI_API_KEY>"));
            console.log(chalk.cyan("    2. Env Var:  ") + chalk.bold.white("export GEMINI_API_KEY=\"your_key_here\""));
            console.log(chalk.gray("  ─────────────────────────────────────────────────────────\n"));

            try {
                key = await password({
                    message: chalk.bold.yellow("  ❯ Enter your Gemini API Key now:"),
                    mask: "*",
                });
            } catch {
                console.log(chalk.gray("\n  peace out.\n"));
                process.exit(0);
            }

            key = key?.trim();

            if (!key) {
                console.log(chalk.red("\n  ✗ No API key provided. REXA cannot run without it.\n"));
                process.exit(1);
            }

            await this.setGeminiApiKey(key);
            console.log("");
        }

        return key;
    }
}
