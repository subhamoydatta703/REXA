import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import chalk from "chalk";
import { password } from "@inquirer/prompts";
import keytar from "keytar";

const CONFIG_DIR = path.join(os.homedir(), ".rexa");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const CONFIG_KEY_FILE = path.join(CONFIG_DIR, "config.key");
const KEYTAR_SERVICE = "rexa";
const GEMINI_ACCOUNT = "gemini-api-key";
const TAVILY_ACCOUNT = "tavily-api-key";
const CLI_AUTH_ACCOUNT = "cli-auth-token";

export const REXA_WEB_URL = process.env.REXA_WEB_URL?.trim() || "https://rexa-agent-web.vercel.app/";
export const REXA_VERIFY_URL =
    process.env.REXA_VERIFY_URL?.trim() || "https://rexa-server.onrender.com/api/cli/verify";

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
    cliAuthToken?: string;
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
        const fromVault: RexaConfig = {};
        try {
            const [geminiApiKey, tavilyApiKey, cliAuthToken] = await Promise.all([
                keytar.getPassword(KEYTAR_SERVICE, GEMINI_ACCOUNT),
                keytar.getPassword(KEYTAR_SERVICE, TAVILY_ACCOUNT),
                keytar.getPassword(KEYTAR_SERVICE, CLI_AUTH_ACCOUNT),
            ]);
            if (geminiApiKey) fromVault.geminiApiKey = geminiApiKey;
            if (tavilyApiKey) fromVault.tavilyApiKey = tavilyApiKey;
            if (cliAuthToken) fromVault.cliAuthToken = cliAuthToken;
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
                if (parsed.cliAuthToken) {
                    parsed.cliAuthToken = decrypt(parsed.cliAuthToken);
                }
                return {
                    geminiApiKey: fromVault.geminiApiKey || parsed.geminiApiKey,
                    tavilyApiKey: fromVault.tavilyApiKey || parsed.tavilyApiKey,
                    cliAuthToken: fromVault.cliAuthToken || parsed.cliAuthToken,
                    updatedAt: parsed.updatedAt,
                };
            }
        } catch {
            // Config corrupted or key mismatch — return vault-only
        }
        return fromVault;
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
                cliAuthToken: config.cliAuthToken ? encrypt(config.cliAuthToken) : undefined,
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
     * Sets Gemini API key (encrypted on disk and stored in OS vault).
     */
    static async setGeminiApiKey(key: string): Promise<void> {
        const trimmed = key.trim();
        if (!trimmed) {
            console.log(chalk.red("  ✗ Gemini API Key cannot be empty."));
            return;
        }
        process.env.GEMINI_API_KEY = trimmed;
        try {
            await keytar.setPassword(KEYTAR_SERVICE, GEMINI_ACCOUNT, trimmed);
        } catch (error) {
            // Ignore keytar failures (e.g. headless environment) and fall back to file storage
        }
        const currentConfig = await this.getConfig().catch(() => ({}));
        this.saveConfig({
            ...currentConfig,
            geminiApiKey: trimmed,
            updatedAt: new Date().toISOString(),
        });
        console.log(chalk.green("  ✓ Gemini API Key securely saved to ") + chalk.gray(CONFIG_FILE));
    }

    /**
     * Sets Tavily API key (encrypted on disk and stored in OS vault).
     */
    static async setTavilyApiKey(key: string): Promise<void> {
        const trimmed = key.trim();
        if (!trimmed) {
            console.log(chalk.red("  ✗ Tavily API Key cannot be empty."));
            return;
        }
        process.env.TAVILY_API_KEY = trimmed;
        try {
            await keytar.setPassword(KEYTAR_SERVICE, TAVILY_ACCOUNT, trimmed);
        } catch (error) {
            // Ignore keytar failures and fall back to file storage
        }
        const currentConfig = await this.getConfig().catch(() => ({}));
        this.saveConfig({
            ...currentConfig,
            tavilyApiKey: trimmed,
            updatedAt: new Date().toISOString(),
        });
        console.log(chalk.green("  ✓ Tavily Search API Key securely saved to ") + chalk.gray(CONFIG_FILE));
    }

    /**
     * Gets Gemini API Key from env vars or encrypted config.
     */
    static async getGeminiApiKey(): Promise<string | undefined> {
        const envKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY;
        if (envKey && envKey.trim()) {
            const trimmed = envKey.trim();
            process.env.GEMINI_API_KEY = trimmed;
            return trimmed;
        }

        const config = await this.getConfig();
        if (config.geminiApiKey && config.geminiApiKey.trim()) {
            const trimmed = config.geminiApiKey.trim();
            process.env.GEMINI_API_KEY = trimmed;
            return trimmed;
        }

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
            console.log(chalk.cyan("    1. Command:  ") + chalk.bold.white("rexa config set-key"));
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

    static async setCliAuthToken(token: string): Promise<void> {
        const trimmed = token.trim();
        if (!trimmed) {
            console.log(chalk.red("  ✗ Auth token cannot be empty."));
            return;
        }
        try {
            await keytar.setPassword(KEYTAR_SERVICE, CLI_AUTH_ACCOUNT, trimmed);
        } catch {
            // Ignore keytar failures and fall back to file storage
        }
        const currentConfig = await this.getConfig().catch(() => ({} as RexaConfig));
        this.saveConfig({
            ...currentConfig,
            cliAuthToken: trimmed,
            updatedAt: new Date().toISOString(),
        });
        console.log(chalk.green("  ✓ Auth token securely saved to ") + chalk.gray(CONFIG_FILE));
    }

    static async clearCliAuthToken(options?: { silent?: boolean }): Promise<void> {
        try {
            await keytar.deletePassword(KEYTAR_SERVICE, CLI_AUTH_ACCOUNT);
        } catch {
            // Vault may be unavailable
        }
        const currentConfig = await this.getConfig().catch(() => ({} as RexaConfig));
        this.saveConfig({
            ...currentConfig,
            cliAuthToken: undefined,
            updatedAt: new Date().toISOString(),
        });
        if (!options?.silent) {
            console.log(chalk.green("  ✓ Logged out. Auth token removed."));
        }
    }

    static async getCliAuthToken(): Promise<string | undefined> {
        const envToken = process.env.REXA_CLI_TOKEN;
        if (envToken && envToken.trim()) {
            return envToken.trim();
        }

        const config = await this.getConfig();
        if (config.cliAuthToken && config.cliAuthToken.trim()) {
            return config.cliAuthToken.trim();
        }

        return undefined;
    }

    static async verifyCliToken(token: string): Promise<{ ok: boolean; networkError?: boolean }> {
        try {
            const response = await fetch(REXA_VERIFY_URL, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json",
                },
                signal: AbortSignal.timeout(90_000),
            });

            if (!response.ok) {
                return { ok: false };
            }

            const contentType = response.headers.get("content-type") || "";
            if (contentType.includes("application/json")) {
                const body = (await response.json()) as { ok?: boolean; success?: boolean };
                if (typeof body.success === "boolean") {
                    return { ok: body.success };
                }
                if (typeof body.ok === "boolean") {
                    return { ok: body.ok };
                }
            }

            return { ok: true };
        } catch {
            return { ok: false, networkError: true };
        }
    }

    static openAuthWebsite(): void {
        const url = REXA_WEB_URL;
        try {
            if (process.platform === "win32") {
                spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
            } else if (process.platform === "darwin") {
                spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
            } else {
                spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
            }
        } catch {
            // User can open the printed URL manually
        }
    }

    /**
     * Ensures a website auth token is present and accepted by the Render verify API.
     * Prompts with a masked input (same as Gemini) so the agent secret scanner never sees it.
     */
    static async ensureCliAuth(): Promise<string> {
        let token = await this.getCliAuthToken();

        if (token) {
            const result = await this.verifyCliToken(token);
            if (result.ok) {
                return token;
            }
            if (result.networkError) {
                console.log(chalk.red("\n  ✗ Could not reach the REXA server to verify your token."));
                console.log(chalk.gray(`    ${REXA_VERIFY_URL}`));
                console.log(chalk.gray("    The server may be waking up. Try again in a moment.\n"));
                process.exit(1);
            }
            await this.clearCliAuthToken({ silent: true });
            token = undefined;
            console.log(chalk.yellow("\n  ⚠  Saved auth token is invalid or expired.\n"));
        }

        this.openAuthWebsite();

        console.log("\n" + chalk.yellow.bold("  ⚠  REXA account login required"));
        console.log(chalk.gray("  ─────────────────────────────────────────────────────────"));
        console.log(chalk.white("  Sign in and generate a CLI token:"));
        console.log("");
        console.log(chalk.cyan("    ") + chalk.bold.white(REXA_WEB_URL));
        console.log("");
        console.log(chalk.white("  Then paste the token below. Tokens expire; generate a new one if needed."));
        console.log(chalk.gray("  ─────────────────────────────────────────────────────────\n"));

        try {
            token = await password({
                message: chalk.bold.yellow("  ❯ Paste your authentication token:"),
                mask: "*",
            });
        } catch {
            console.log(chalk.gray("\n  peace out.\n"));
            process.exit(0);
        }

        token = token?.trim();

        if (!token) {
            console.log(chalk.red("\n  ✗ No auth token provided. REXA cannot run without it.\n"));
            process.exit(1);
        }

        console.log(chalk.gray("  Verifying token with REXA server..."));
        const result = await this.verifyCliToken(token);
        if (result.networkError) {
            console.log(chalk.red("\n  ✗ Could not reach the REXA server to verify your token."));
            console.log(chalk.gray(`    ${REXA_VERIFY_URL}`));
            console.log(chalk.gray("    The server may be waking up. Try again in a moment.\n"));
            process.exit(1);
        }
        if (!result.ok) {
            console.log(chalk.red("\n  ✗ Token is invalid or expired. Generate a new one on the website and try again.\n"));
            process.exit(1);
        }

        await this.setCliAuthToken(token);
        console.log(chalk.green("  ✓ Authenticated.\n"));
        return token;
    }
}
