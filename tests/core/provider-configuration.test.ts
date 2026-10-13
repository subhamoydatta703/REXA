import { expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { ProviderSetup } from "../../src/cli/ProviderSetup";
import { ModelCatalog } from "../../src/providers/ModelCatalog";
import type {
    ProviderId,
    ProviderPreferences,
    ProviderSettings,
} from "../../src/providers/ProviderSettings";

function setupFixture(
    options: { key?: string; interactive?: boolean; answer?: string } = {},
) {
    const preferences: ProviderPreferences = { remembered: {} };
    const getKey = mock(async (_provider: ProviderId) => options.key);
    const readKey = mock(
        async (_provider: ProviderId) => options.answer ?? "fixture-new-key",
    );
    const saveKey = mock(async (_provider: ProviderId, _key: string) => {});
    const saveSettings = mock(async (_settings: ProviderSettings) => {});
    const dependencies = {
        interactive: options.interactive ?? true,
        getPreferences: async () => preferences,
        getKey,
        readKey,
        saveKey,
        saveSettings,
    };
    return {
        preferences,
        dependencies,
        getKey,
        readKey,
        saveKey,
        saveSettings,
    };
}

test("OpenAI configuration prompts only for its key and validates settings before saving", async () => {
    const state = setupFixture();
    const result = await new ProviderSetup(state.dependencies).configure(
        "openai",
        { reasoning: "high" },
    );
    expect(result).toEqual({
        status: "saved",
        settings: { provider: "openai", model: "gpt-5", reasoning: "high" },
    });
    expect(state.getKey.mock.calls).toEqual([["openai"]]);
    expect(state.readKey.mock.calls).toEqual([["openai"]]);
    expect(state.saveKey.mock.calls).toEqual([["openai", "fixture-new-key"]]);
    expect(state.saveSettings).toHaveBeenCalledTimes(1);
});

test("Claude alias and configured credentials avoid unrelated or duplicate key prompts", async () => {
    const state = setupFixture({ key: "existing-key" });
    await new ProviderSetup(state.dependencies).configure("Claude");
    expect(state.getKey.mock.calls).toEqual([["anthropic"]]);
    expect(state.readKey).not.toHaveBeenCalled();
    expect(state.saveKey).not.toHaveBeenCalled();
    expect(state.saveSettings.mock.calls[0]?.[0].provider).toBe("anthropic");
});

test("switching back restores remembered model/effort and explicit overrides are validated", async () => {
    const state = setupFixture({ key: "existing-key" });
    state.preferences.remembered.openai = {
        provider: "openai",
        model: "gpt-5",
        reasoning: "high",
    };
    const setup = new ProviderSetup(state.dependencies);
    expect(await setup.configure("openai")).toEqual({
        status: "saved",
        settings: state.preferences.remembered.openai,
    });
    await setup.configure("openai", { reasoning: "default" });
    expect(state.saveSettings.mock.calls[1]?.[0].reasoning).toBe("default");
    await expect(
        setup.configure("openai", { reasoning: "max" }),
    ).rejects.toThrow("does not support");
    expect(state.saveSettings).toHaveBeenCalledTimes(2);
});

test("invalid candidates do not read or write any credentials", async () => {
    const state = setupFixture();
    const setup = new ProviderSetup(state.dependencies);
    await expect(
        setup.configure("openai", { model: "gemini-3.8-flash" }),
    ).rejects.toThrow("Unknown model");
    await expect(setup.configure("made-up-provider")).rejects.toThrow();
    expect(state.getKey).not.toHaveBeenCalled();
    expect(state.saveKey).not.toHaveBeenCalled();
    expect(state.saveSettings).not.toHaveBeenCalled();
});

test("a model switch resets an unsupported remembered effort but rejects an explicit invalid override", async () => {
    const state = setupFixture({ key: "existing-key" });
    state.preferences.remembered.openai = {
        provider: "openai",
        model: "gpt-5",
        reasoning: "high",
    };
    const seed = new ModelCatalog().list("openai")[0]!;
    const catalog = new ModelCatalog([
        seed,
        {
            ...seed,
            id: "fixture-low-only",
            reasoning: { kind: "levels", levels: ["low"] },
        },
    ]);
    const setup = new ProviderSetup(state.dependencies, catalog);
    const switched = await setup.configure("openai", {
        model: "fixture-low-only",
    });
    expect(switched).toEqual({
        status: "saved",
        settings: {
            provider: "openai",
            model: "fixture-low-only",
            reasoning: "default",
        },
    });
    await expect(
        setup.configure("openai", {
            model: "fixture-low-only",
            reasoning: "high",
        }),
    ).rejects.toThrow("does not support");
    expect(state.saveSettings).toHaveBeenCalledTimes(1);
});

test("empty or cancelled masked input leaves the active configuration untouched", async () => {
    const state = setupFixture({ answer: "   " });
    expect(
        await new ProviderSetup(state.dependencies).configure("openai"),
    ).toEqual({ status: "cancelled" });
    state.readKey.mockImplementation(async () => {
        throw new Error("prompt cancelled");
    });
    expect(
        await new ProviderSetup(state.dependencies).configure("anthropic"),
    ).toEqual({ status: "cancelled" });
    expect(state.saveKey).not.toHaveBeenCalled();
    expect(state.saveSettings).not.toHaveBeenCalled();
});

test("noninteractive missing keys fail without a prompt; configured keys work", async () => {
    const state = setupFixture({ interactive: false });
    await expect(
        new ProviderSetup(state.dependencies).configure("openai"),
    ).rejects.toThrow("set-provider-key openai");
    expect(state.readKey).not.toHaveBeenCalled();
    const configured = setupFixture({ interactive: false, key: "env-key" });
    expect(
        (await new ProviderSetup(configured.dependencies).configure("openai"))
            .status,
    ).toBe("saved");
});

test("failed credential storage prevents a preference change", async () => {
    const state = setupFixture();
    state.saveKey.mockImplementation(async () => {
        throw new Error("storage failed");
    });
    await expect(
        new ProviderSetup(state.dependencies).configure("openai"),
    ).rejects.toThrow("storage failed");
    expect(state.saveSettings).not.toHaveBeenCalled();
});

test("failed preference persistence is reported, not treated as successful selection", async () => {
    const state = setupFixture({ key: "existing-key" });
    state.saveSettings.mockImplementation(async () => {
        throw new Error("preference storage failed");
    });
    await expect(
        new ProviderSetup(state.dependencies).configure("openai"),
    ).rejects.toThrow("preference storage failed");
    expect(state.saveKey).not.toHaveBeenCalled();
});

test("real encrypted config migrates existing fields, preserves selections, isolates keys, and rejects failed saves", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "rexa-provider-config-"));
    const moduleUrl = (relative: string) =>
        pathToFileURL(path.resolve(import.meta.dir, relative)).href;
    const script = `
        import assert from "node:assert/strict";
        import os from "node:os";
        import fs from "node:fs";
        import path from "node:path";
        import { mock } from "bun:test";
        const vault = new Map();
        let vaultAvailable = false;
        let failOpenAIRead = false;
        mock.module("keytar", () => ({ default: {
            getPassword: async (_service, account) => {
                if (!vaultAvailable || (failOpenAIRead && account === "openai-api-key")) throw new Error("vault unavailable");
                return vault.get(account) ?? null;
            },
            setPassword: async (_service, account, value) => {
                if (!vaultAvailable) throw new Error("vault unavailable");
                vault.set(account, value);
            },
        } }));
        assert.equal(path.resolve(os.homedir()), path.resolve(process.env.TEST_CONFIG_HOME));
        const directory = path.join(os.homedir(), ".rexa");
        const filename = path.join(directory, "config.json");
        fs.mkdirSync(directory);
        const encodeLegacy = value => Buffer.from(value).toString("base64");
        fs.writeFileSync(filename, JSON.stringify({
            geminiApiKey: encodeLegacy("legacy-gemini-fixture"),
            tavilyApiKey: encodeLegacy("legacy-tavily-fixture"),
            brightDataApiKey: encodeLegacy("legacy-brightdata-fixture"),
            cliAuthToken: encodeLegacy("legacy-auth-fixture"),
            cliUserId: encodeLegacy("legacy-user-fixture"),
            optionalApiSetup: { tavily: true, brightData: true },
        }));
        const { ConfigManager } = await import(${JSON.stringify(moduleUrl("../../src/config/ConfigManager.ts"))});
        const { SecretScanner } = await import(${JSON.stringify(moduleUrl("../../src/guardrails/types/SecretScanner.ts"))});
        const { sanitizeStored } = await import(${JSON.stringify(moduleUrl("../../src/utils/SanitizeStored.ts"))});
        assert.deepEqual(await ConfigManager.getProviderPreferences(), { remembered: {} });
        await ConfigManager.setProviderApiKey("openai", "stored-openai-fixture");
        await ConfigManager.setProviderApiKey("anthropic", "stored-anthropic-fixture");
        delete process.env.OPENAI_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;
        assert.equal(await ConfigManager.getProviderApiKey("openai"), "stored-openai-fixture");
        assert.equal(await ConfigManager.getProviderApiKey("anthropic"), "stored-anthropic-fixture");
        assert.equal(process.env.OPENAI_API_KEY, undefined);
        assert.equal(SecretScanner.redact("failure: stored-openai-fixture"), "failure: [REDACTED]");
        assert.equal(SecretScanner.containsSecret("stored-anthropic-fixture"), true);
        assert.equal(JSON.stringify(sanitizeStored({ error: "stored-openai-fixture stored-anthropic-fixture" })).includes("stored-openai-fixture"), false);
        assert.equal(sanitizeStored({ thoughtSignature: "opaque-signature" }).thoughtSignature, "opaque-signature");
        const { logger } = await import(${JSON.stringify(moduleUrl("../../src/logger/AgentLogger.ts"))});
        const logLines = [];
        const originalLog = console.log;
        console.log = (...values) => logLines.push(values.join(" "));
        logger.error("stored-openai-fixture", "stored-anthropic-fixture");
        console.log = originalLog;
        assert.equal(logLines.join(" ").includes("stored-openai-fixture"), false);
        assert.equal(logLines.join(" ").includes("stored-anthropic-fixture"), false);
        const { SessionStore } = await import(${JSON.stringify(moduleUrl("../../src/sessions/SessionStore.ts"))});
        const sessions = new SessionStore(os.homedir(), path.join(os.homedir(), "sessions"));
        const session = await sessions.create();
        session.messages = [{ role: "assistant", content: "stored-openai-fixture stored-anthropic-fixture" }];
        await sessions.save(session);
        assert.equal(fs.readFileSync(path.join(sessions.directory, session.id + ".jsonl"), "utf8").includes("stored-openai-fixture"), false);
        const { verificationReport } = await import(${JSON.stringify(moduleUrl("../../src/verification/VerificationResults.ts"))});
        const report = verificationReport({ source: "fixture", notices: ["stored-openai-fixture"], baseline: [], runs: [], changedFiles: [], repairRounds: 0, pendingProcesses: [], dirty: false });
        assert.equal(report.includes("stored-openai-fixture"), false);
        const openai = { provider: "openai", model: "gpt-5", reasoning: "high" };
        const anthropic = { provider: "anthropic", model: "claude-sonnet-4-6", reasoning: "max" };
        await ConfigManager.setProviderSettings(openai);
        await ConfigManager.setProviderSettings(anthropic);
        const prefs = await ConfigManager.getProviderPreferences();
        assert.deepEqual(prefs.active, anthropic);
        assert.deepEqual(prefs.remembered.openai, openai);
        assert.deepEqual(prefs.remembered.anthropic, anthropic);
        const config = await ConfigManager.getConfig();
        assert.equal(config.geminiApiKey, "legacy-gemini-fixture");
        assert.equal(config.tavilyApiKey, "legacy-tavily-fixture");
        assert.equal(config.brightDataApiKey, "legacy-brightdata-fixture");
        assert.equal(config.cliAuthToken, "legacy-auth-fixture");
        assert.equal(config.cliUserId, "legacy-user-fixture");
        assert.deepEqual(config.optionalApiSetup, { tavily: true, brightData: true });
        const raw = fs.readFileSync(filename, "utf8");
        for (const value of ["stored-openai-fixture", "stored-anthropic-fixture", "legacy-auth-fixture", "legacy-gemini-fixture"]) assert.equal(raw.includes(value), false);
        assert.equal(JSON.parse(raw).providerPreferences.active.provider, "anthropic");
        process.env.OPENAI_API_KEY = "environment-openai-fixture";
        assert.equal(await ConfigManager.getProviderApiKey("openai"), "environment-openai-fixture");
        delete process.env.OPENAI_API_KEY;
        process.env.GOOGLE_GEMINI_API_KEY = "alias-gemini-fixture";
        assert.equal(await ConfigManager.getProviderApiKey("gemini"), "alias-gemini-fixture");
        process.env.GEMINI_API_KEY = "primary-gemini-fixture";
        assert.equal(await ConfigManager.getProviderApiKey("gemini"), "primary-gemini-fixture");
        const save = ConfigManager.saveConfig;
        ConfigManager.saveConfig = () => false;
        await assert.rejects(ConfigManager.setProviderApiKey("openai", "unsaved-fixture"), /Could not save/);
        assert.equal(process.env.OPENAI_API_KEY, undefined);
        await assert.rejects(ConfigManager.setProviderSettings(openai), /previous selection is unchanged/);
        assert.equal(fs.readFileSync(filename, "utf8"), raw);
        vaultAvailable = true;
        await ConfigManager.setProviderApiKey("openai", "vault-openai-fixture");
        assert.equal(vault.get("openai-api-key"), "vault-openai-fixture");
        delete process.env.OPENAI_API_KEY;
        assert.equal(await ConfigManager.getProviderApiKey("openai"), "vault-openai-fixture");
        vault.set("anthropic-api-key", "vault-anthropic-fixture");
        failOpenAIRead = true;
        assert.equal((await ConfigManager.getConfig()).anthropicApiKey, "vault-anthropic-fixture");
        assert.equal((await ConfigManager.getConfig()).openaiApiKey, "stored-openai-fixture");
        ConfigManager.saveConfig = save;
        const invalid = JSON.parse(raw);
        invalid.providerPreferences.active = { provider: "unknown", model: "anything" };
        fs.writeFileSync(filename, JSON.stringify(invalid));
        await assert.rejects(ConfigManager.getProviderPreferences(), /preferences are invalid/);
    `;
    try {
        const child = Bun.spawn([process.execPath, "-e", script], {
            cwd: path.resolve(import.meta.dir, "../.."),
            env: {
                ...process.env,
                HOME: home,
                USERPROFILE: home,
                TEST_CONFIG_HOME: home,
                REXA_CONFIG_KEY: Buffer.alloc(32, 8).toString("base64"),
                GEMINI_API_KEY: "",
                GOOGLE_GEMINI_API_KEY: "",
                OPENAI_API_KEY: "",
                ANTHROPIC_API_KEY: "",
                TAVILY_API_KEY: "",
                TVLY_API_KEY: "",
                BRIGHTDATA_API_KEY: "",
                REXA_CLI_TOKEN: "",
            },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [exit, stderr] = await Promise.all([
            child.exited,
            new Response(child.stderr).text(),
            new Response(child.stdout).text(),
        ]);
        expect(stderr).toBe("");
        expect(exit).toBe(0);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("CLI saves and displays provider settings, preserves legacy commands, and rejects unavailable runtime without Gemini setup", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "rexa-provider-cli-"));
    const indexUrl = pathToFileURL(
        path.resolve(import.meta.dir, "../../src/index.ts"),
    ).href;
    const configUrl = pathToFileURL(
        path.resolve(import.meta.dir, "../../src/config/ConfigManager.ts"),
    ).href;
    async function run(args: string[]) {
        const script = `
            import { mock } from "bun:test";
            mock.module("keytar", () => ({ default: {
                getPassword: async () => null,
                setPassword: async () => { throw new Error("fixture vault unavailable"); },
            } }));
            const { ConfigManager } = await import(${JSON.stringify(configUrl)});
            ConfigManager.ensureCliAuth = async () => { throw new Error("UNEXPECTED_LOGIN"); };
            ConfigManager.ensureApiKey = async () => { throw new Error("UNEXPECTED_GEMINI_SETUP"); };
            process.argv = [process.execPath, "rexa", ...${JSON.stringify(args)}];
            await import(${JSON.stringify(indexUrl)});
        `;
        const child = Bun.spawn([process.execPath, "-e", script], {
            cwd: path.resolve(import.meta.dir, "../.."),
            env: {
                ...process.env,
                HOME: home,
                USERPROFILE: home,
                REXA_CONFIG_KEY: Buffer.alloc(32, 9).toString("base64"),
                OPENAI_API_KEY: "fixture-cli-openai-key",
                ANTHROPIC_API_KEY: "fixture-cli-anthropic-key",
                GEMINI_API_KEY: "fixture-cli-gemini-key",
            },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [exit, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        expect(stdout + stderr).not.toContain("fixture-cli-openai-key");
        expect(stdout + stderr).not.toContain("fixture-cli-anthropic-key");
        expect(stdout + stderr).not.toContain("UNEXPECTED_LOGIN");
        expect(stdout + stderr).not.toContain("UNEXPECTED_GEMINI_SETUP");
        return { exit, stdout, stderr };
    }
    try {
        const selected = await run([
            "config",
            "set-provider",
            "openai",
            "--reasoning",
            "high",
        ]);
        expect(selected.exit).toBe(0);
        expect(selected.stdout).toContain("Saved provider: openai");
        expect(selected.stdout).toContain("does not yet have");
        const shown = await run(["config", "show-provider"]);
        expect(shown.exit).toBe(0);
        expect(JSON.parse(shown.stdout).active).toEqual({
            provider: "openai",
            model: "gpt-5",
            reasoning: "high",
        });
        const startup = await run([]);
        expect(startup.exit).toBe(1);
        expect(startup.stderr).toContain("runtime adapter is not available");
        expect((await run(["config", "set-provider-key", "openai"])).exit).toBe(
            1,
        );
        expect(
            (await run(["config", "set-key", "fixture-legacy-gemini-key"]))
                .exit,
        ).toBe(0);
        expect(
            JSON.parse((await run(["config", "show-provider"])).stdout).active
                .provider,
        ).toBe("openai");
        expect((await run(["config", "set-provider", "claude"])).exit).toBe(0);
        expect(
            JSON.parse((await run(["config", "show-provider"])).stdout).active
                .provider,
        ).toBe("anthropic");
        expect((await run(["config", "set-provider", "openai"])).exit).toBe(0);
        expect(
            JSON.parse((await run(["config", "show-provider"])).stdout).active
                .reasoning,
        ).toBe("high");
        expect(
            (
                await run([
                    "config",
                    "set-provider",
                    "gemini",
                    "--reasoning",
                    "default",
                ])
            ).exit,
        ).toBe(0);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
}, 20000);
