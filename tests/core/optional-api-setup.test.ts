import { expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
    OptionalApiSetup,
    validateOptionalApiAnswer,
    type OptionalApiProvider,
    type OptionalApiSetupDependencies,
} from "../../src/cli/OptionalApiSetup";

function fixture(
    answers = ["N", "N"],
    overrides: Partial<OptionalApiSetupDependencies> = {},
) {
    const keys = new Map<OptionalApiProvider, string>();
    const completed = new Set<OptionalApiProvider>();
    const messages: string[] = [];
    const events: string[] = [];
    const dependencies: OptionalApiSetupDependencies = {
        interactive: true,
        getKey: mock(async (provider) => keys.get(provider)),
        isComplete: mock(async (provider) => completed.has(provider)),
        markComplete: mock(async (provider) => {
            events.push(`complete:${provider}`);
            completed.add(provider);
        }),
        saveKey: mock(async (provider, key) => {
            events.push(`save:${provider}`);
            keys.set(provider, key);
        }),
        ask: mock(async (message) => {
            events.push("ask");
            messages.push(message);
            const answer = answers.shift();
            if (answer === undefined) {
                throw new Error("Unexpected extra prompt");
            }
            return answer;
        }),
        readKey: mock(async () => "  fixture-secret  "),
        print: mock((message) => messages.push(message)),
        ...overrides,
    };
    return {
        dependencies,
        keys,
        completed,
        messages,
        events,
        setup: new OptionalApiSetup(dependencies),
    };
}

test("accepts only uppercase Y and N without a default answer", () => {
    expect(validateOptionalApiAnswer("Y")).toBe(true);
    expect(validateOptionalApiAnswer("N")).toBe(true);
    for (const answer of ["", "y", "n", "yes", "no", " Y", "N ", "YN", "1"]) {
        expect(validateOptionalApiAnswer(answer)).toBe("Please enter Y or N.");
    }
});

test("N skips both secret prompts and persists independent decisions across launches", async () => {
    const state = fixture();
    await state.setup.run();
    expect(state.dependencies.readKey).not.toHaveBeenCalled();
    expect(state.dependencies.saveKey).not.toHaveBeenCalled();
    expect([...state.completed]).toEqual(["tavily", "brightData"]);
    await new OptionalApiSetup(state.dependencies).run();
    expect(state.dependencies.ask).toHaveBeenCalledTimes(2);
});

test("Y saves trimmed keys before marking each provider complete", async () => {
    const state = fixture(["Y", "Y"]);
    await state.setup.run();
    expect(state.keys.get("tavily")).toBe("fixture-secret");
    expect(state.keys.get("brightData")).toBe("fixture-secret");
    expect(state.events).toEqual([
        "ask",
        "save:tavily",
        "complete:tavily",
        "ask",
        "save:brightData",
        "complete:brightData",
    ]);
    expect(state.messages.join("\n")).not.toContain("fixture-secret");
});

test("shows optional labels, benefits, fallback behavior, and later commands before asking", async () => {
    const state = fixture();
    await state.setup.run();
    const text = state.messages.join("\n");
    expect(text).toContain("Tavily API key — Optional");
    expect(text).toContain("DuckDuckGo");
    expect(text).toContain("page-extraction fallback");
    expect(text).toContain("Bright Data API key — Optional");
    expect(text).toContain("LinkedIn personal profiles");
    expect(text).toContain("credits are required");
    expect(text).toContain("rexa config set-tavily-key");
    expect(text).toContain("rexa config set-brightdata-key");
    expect(state.messages[0]).toContain("Tavily API key — Optional");
    expect(state.messages[1]).toContain("[Y/N]");
    expect(state.messages[2]).toContain("Bright Data API key — Optional");
});

test("invalid answers repeat the question without opening secret input", async () => {
    const state = fixture(["", "yes", "y", "N", "N"]);
    await state.setup.run();
    expect(state.dependencies.ask).toHaveBeenCalledTimes(5);
    expect(state.dependencies.readKey).not.toHaveBeenCalled();
    expect(
        state.messages.filter((message) => message === "Please enter Y or N."),
    ).toHaveLength(3);
});

test("existing environment or saved keys skip onboarding without changing storage", async () => {
    const state = fixture([], { getKey: async () => "existing-key" });
    await state.setup.run();
    expect(state.dependencies.ask).not.toHaveBeenCalled();
    expect(state.dependencies.readKey).not.toHaveBeenCalled();
    expect(state.dependencies.saveKey).not.toHaveBeenCalled();
    expect(state.dependencies.markComplete).not.toHaveBeenCalled();
});

test("one configured provider does not suppress setup of the other", async () => {
    const state = fixture(["N"], {
        getKey: async (provider) =>
            provider === "tavily" ? "existing-key" : undefined,
    });
    await state.setup.run();
    expect([...state.completed]).toEqual(["brightData"]);
    expect(state.dependencies.ask).toHaveBeenCalledTimes(1);
});

test("noninteractive startup performs no optional configuration reads or prompts", async () => {
    const state = fixture([], { interactive: false });
    await state.setup.run();
    expect(state.dependencies.getKey).not.toHaveBeenCalled();
    expect(state.dependencies.ask).not.toHaveBeenCalled();
    expect(state.dependencies.saveKey).not.toHaveBeenCalled();
});

test("empty keys are not saved or marked complete", async () => {
    const state = fixture(["Y", "N"], { readKey: async () => "   " });
    await state.setup.run();
    expect(state.dependencies.saveKey).not.toHaveBeenCalled();
    expect([...state.completed]).toEqual(["brightData"]);
    expect(state.messages.join("\n")).toContain("Nothing was saved");
});

test("cancelling secret entry continues to the next optional provider", async () => {
    const state = fixture(["Y", "N"], {
        readKey: async () => {
            throw new Error("cancelled");
        },
    });
    await state.setup.run();
    expect(state.dependencies.saveKey).not.toHaveBeenCalled();
    expect([...state.completed]).toEqual(["brightData"]);
    expect(state.messages.join("\n")).toContain("key entry cancelled");
});

test("cancelling a Y/N prompt neither saves a decision nor blocks the next provider", async () => {
    let prompts = 0;
    const state = fixture([], {
        ask: async () => {
            if (prompts++ === 0) {
                throw new Error("cancelled");
            }
            return "N";
        },
    });
    await state.setup.run();
    expect([...state.completed]).toEqual(["brightData"]);
    expect(state.dependencies.readKey).not.toHaveBeenCalled();
});

test("failed key storage stays incomplete and does not expose error details or secrets", async () => {
    const state = fixture(["Y", "N"], {
        saveKey: async () => {
            throw new Error("fixture-secret");
        },
    });
    await state.setup.run();
    expect([...state.completed]).toEqual(["brightData"]);
    expect(state.messages.join("\n")).toContain(
        "Could not save the Tavily API key",
    );
    expect(state.messages.join("\n")).not.toContain("fixture-secret");
});

test("failed decision storage warns and allows future prompts", async () => {
    const state = fixture(["N", "N"], {
        markComplete: async () => {
            throw new Error("fixture storage error");
        },
    });
    await state.setup.run();
    expect(state.completed.size).toBe(0);
    expect(state.messages.join("\n")).toContain("You may be asked again");
});

test("configuration read failure skips only the affected provider", async () => {
    const state = fixture(["N"], {
        getKey: async (provider) => {
            if (provider === "tavily") {
                throw new Error("unavailable");
            }
            return undefined;
        },
    });
    await state.setup.run();
    expect([...state.completed]).toEqual(["brightData"]);
});

test("real config round-trips setup decisions without losing encrypted keys and rejects failed saves", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "rexa-optional-setup-"));
    try {
        const configUrl = pathToFileURL(
            path.resolve(import.meta.dir, "../../src/config/ConfigManager.ts"),
        ).href;
        // Isolate the real config file and fake vault in a subprocess so the
        // developer's credentials and other tests' module imports are untouched.
        const script = `
            import assert from "node:assert/strict";
            import os from "node:os";
            import path from "node:path";
            import fs from "node:fs";
            import { mock } from "bun:test";
            assert.equal(path.resolve(os.homedir()), path.resolve(process.env.TEST_CONFIG_HOME));
            mock.module("keytar", () => ({ default: {
                getPassword: async () => null,
                setPassword: async () => { throw new Error("vault unavailable"); }
            } }));
            const { runOptionalApiSetup } = await import(${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "../../src/cli/OptionalApiSetup.ts")).href)});
            assert.equal(Boolean(process.stdin.isTTY), false);
            await runOptionalApiSetup();
            assert.equal(fs.existsSync(path.join(os.homedir(), ".rexa", "config.json")), false);
            const { ConfigManager } = await import(${JSON.stringify(configUrl)});
            assert.equal(await ConfigManager.isOptionalApiSetupComplete("tavily"), false);
            await ConfigManager.setTavilyApiKey("fixture-tavily-secret");
            await ConfigManager.completeOptionalApiSetup("tavily");
            await ConfigManager.setBrightDataApiKey("fixture-brightdata-secret");
            await ConfigManager.completeOptionalApiSetup("brightData");
            delete process.env.TAVILY_API_KEY;
            delete process.env.TVLY_API_KEY;
            delete process.env.BRIGHTDATA_API_KEY;
            assert.equal(await ConfigManager.getTavilyApiKey(), "fixture-tavily-secret");
            assert.equal(await ConfigManager.getBrightDataApiKey(), "fixture-brightdata-secret");
            assert.equal(await ConfigManager.isOptionalApiSetupComplete("tavily"), true);
            assert.equal(await ConfigManager.isOptionalApiSetupComplete("brightData"), true);
            const raw = fs.readFileSync(path.join(os.homedir(), ".rexa", "config.json"), "utf8");
            assert.equal(raw.includes("fixture-tavily-secret"), false);
            assert.equal(raw.includes("fixture-brightdata-secret"), false);
            process.env.TVLY_API_KEY = "environment-tavily";
            process.env.BRIGHTDATA_API_KEY = "environment-brightdata";
            assert.equal(await ConfigManager.getTavilyApiKey(), "environment-tavily");
            assert.equal(await ConfigManager.getBrightDataApiKey(), "environment-brightdata");
            delete process.env.TVLY_API_KEY;
            delete process.env.BRIGHTDATA_API_KEY;
            ConfigManager.saveConfig = () => false;
            await assert.rejects(ConfigManager.setTavilyApiKey("unsaved-key"), /Could not save/);
            await assert.rejects(ConfigManager.setBrightDataApiKey("unsaved-key"), /Could not save/);
            await assert.rejects(ConfigManager.completeOptionalApiSetup("tavily"), /Could not save/);
            assert.equal(process.env.TAVILY_API_KEY, undefined);
            assert.equal(process.env.BRIGHTDATA_API_KEY, undefined);
        `;
        const child = Bun.spawn([process.execPath, "-e", script], {
            cwd: path.resolve(import.meta.dir, "../.."),
            env: {
                ...process.env,
                HOME: home,
                USERPROFILE: home,
                TEST_CONFIG_HOME: home,
                REXA_CONFIG_KEY: Buffer.alloc(32, 7).toString("base64"),
            },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [exitCode, stderr] = await Promise.all([
            child.exited,
            new Response(child.stderr).text(),
            new Response(child.stdout).text(),
        ]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
