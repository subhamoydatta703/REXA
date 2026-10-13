import { expect, mock, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GenerateContentResponse, type Part } from "@google/genai";
import {
    assistantMessage,
    messageSchema,
    toolResultMessage,
    type Message,
} from "../../src/agent/Message";
import { Agent } from "../../src/agent/Agent";
import { ToolRegistry } from "../../src/tools/ToolRegistry";
import { z } from "zod";
import { recoverInterruptedMessages } from "../../src/sessions/SessionRecovery";
import { SessionStore } from "../../src/sessions/SessionStore";
import { GeminiProvider } from "../../src/providers/gemini/GeminiProvider";
import {
    DEFAULT_GEMINI_MODEL,
    geminiContents,
    geminiResponse,
    migrateLegacyMessages,
} from "../../src/providers/gemini/GeminiProtocol";
import { ModelCatalog } from "../../src/providers/ModelCatalog";
import type { ModelDefinition } from "../../src/providers/ProviderSettings";

const repeatedCalls: Part[] = [
    {
        thoughtSignature: "opaque-signature",
        functionCall: {
            id: "first",
            name: "read_file",
            args: { path: "a.ts" },
        },
    },
    {
        functionCall: {
            id: "second",
            name: "read_file",
            args: { path: "b.ts" },
        },
    },
];

test("Gemini preserves signed parts and pairs repeated names by ID, even out of order", () => {
    const original = structuredClone(repeatedCalls);
    const response = geminiResponse(
        repeatedCalls,
        "Reading files",
        DEFAULT_GEMINI_MODEL,
    );
    const first = response.toolcalls![0]!;
    const second = response.toolcalls![1]!;
    const messages = [
        assistantMessage(response),
        toolResultMessage(second, { result: "file b" }),
        toolResultMessage(first, { result: "file a" }),
    ];
    const contents = geminiContents(messages, DEFAULT_GEMINI_MODEL);
    expect(contents[0]?.parts).toEqual(original);
    expect(contents[1]?.parts?.[0]?.functionResponse).toEqual({
        id: "second",
        name: "read_file",
        response: { result: "file b" },
    });
    expect(contents[2]?.parts?.[0]?.functionResponse?.id).toBe("first");
    expect(repeatedCalls).toEqual(original);
    expect(messages[0]).not.toHaveProperty("parts");
});

test("calls without native IDs get unique internal IDs without changing signed wire parts", () => {
    const parts: Part[] = [
        {
            thoughtSignature: "signature",
            functionCall: { name: "read_file", args: {} },
        },
        { functionCall: { name: "read_file", args: {} } },
    ];
    const response = geminiResponse(parts, "", DEFAULT_GEMINI_MODEL);
    expect(new Set(response.toolcalls?.map((call) => call.id)).size).toBe(2);
    const contents = geminiContents(
        [
            assistantMessage(response),
            ...response.toolcalls!.map((call) =>
                toolResultMessage(call, { result: "ok" }),
            ),
        ],
        DEFAULT_GEMINI_MODEL,
    );
    expect(contents[0]?.parts).toEqual(parts);
    expect(contents[1]?.parts?.[0]?.functionResponse).not.toHaveProperty("id");
});

test("shared schema and Gemini translation reject ambiguous or incompatible conversations", () => {
    const response = geminiResponse(repeatedCalls, "", DEFAULT_GEMINI_MODEL);
    const turn = assistantMessage(response);
    expect(() =>
        geminiResponse(
            [repeatedCalls[0]!, repeatedCalls[0]!],
            "",
            DEFAULT_GEMINI_MODEL,
        ),
    ).toThrow("unique");
    expect(() =>
        messageSchema.parse({ role: "user", toolCalls: response.toolcalls }),
    ).toThrow();
    expect(() =>
        geminiResponse(
            [{ functionCall: { name: "read_file", willContinue: true } }],
            "",
            DEFAULT_GEMINI_MODEL,
        ),
    ).toThrow("Incomplete");
    expect(() => geminiContents([turn], DEFAULT_GEMINI_MODEL)).toThrow(
        "unanswered",
    );
    expect(() =>
        geminiContents(
            [turn, { role: "user", content: "continue" }],
            DEFAULT_GEMINI_MODEL,
        ),
    ).toThrow("followed");
    expect(() =>
        geminiContents(
            [
                {
                    role: "model",
                    native: { provider: "openai", model: "gpt-5", data: [] },
                },
            ],
            DEFAULT_GEMINI_MODEL,
        ),
    ).toThrow("Incompatible");
    expect(() => geminiContents([turn], "another-model")).toThrow(
        "Incompatible",
    );
    const changed = structuredClone(turn);
    changed.toolCalls![0]!.params = { path: "wrong.ts" };
    expect(() => geminiContents([changed], DEFAULT_GEMINI_MODEL)).toThrow(
        "identity",
    );
});

test("recovery closes only the missing call ID and rejects mismatched results", () => {
    const response = geminiResponse(repeatedCalls, "", DEFAULT_GEMINI_MODEL);
    const messages = [
        assistantMessage(response),
        toolResultMessage(response.toolcalls![1]!, { result: "b" }),
    ];
    const recovered = recoverInterruptedMessages(messages);
    expect(recovered[2]?.toolResults?.[0]?.callId).toBe("first");
    expect(JSON.stringify(recovered[2])).toContain("outcome unknown");
    expect(recoverInterruptedMessages(recovered)).toEqual(recovered);
    const incorrect = structuredClone(messages);
    incorrect[1]!.toolResults![0]!.name = "different_tool";
    expect(() => recoverInterruptedMessages(incorrect)).toThrow("identity");
    expect(() =>
        recoverInterruptedMessages([...messages, messages[1]!]),
    ).toThrow("duplicate");
});

test("old session snapshots load in memory without losing signatures or rewriting history", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rexa-protocol-"));
    try {
        const store = new SessionStore(root, path.join(root, "sessions"));
        const session = await store.create();
        const filename = path.join(store.directory, `${session.id}.jsonl`);
        const legacy = {
            ...session,
            messages: [
                { role: "model", parts: repeatedCalls },
                {
                    role: "tool",
                    parts: [
                        {
                            functionResponse: {
                                id: "second",
                                name: "read_file",
                                response: { result: "b" },
                            },
                        },
                    ],
                },
            ],
        };
        await appendFile(filename, JSON.stringify(legacy) + "\n");
        const originalBytes = await readFile(filename, "utf8");
        const loaded = await store.load(session.id);
        expect(loaded.messages[0]?.native?.data[0]?.thoughtSignature).toBe(
            "opaque-signature",
        );
        expect(loaded.messages[1]?.toolResults?.[0]?.callId).toBe("second");
        expect(await readFile(filename, "utf8")).toBe(originalBytes);
        loaded.messages = recoverInterruptedMessages(loaded.messages);
        await store.save(loaded);
        const restarted = await store.load(session.id);
        expect(restarted.messages).toEqual(loaded.messages);
        expect(
            (await readFile(filename, "utf8")).startsWith(originalBytes),
        ).toBe(true);
        expect(
            geminiContents(restarted.messages, DEFAULT_GEMINI_MODEL)[0]?.parts,
        ).toEqual(repeatedCalls);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("legacy calls without IDs migrate deterministically and never infer a root cause", () => {
    const legacy = [
        {
            role: "model",
            parts: [
                { functionCall: { name: "read_file", args: {} } },
                { functionCall: { name: "read_file", args: {} } },
            ],
        },
        {
            role: "tool",
            parts: [
                {
                    functionResponse: {
                        name: "read_file",
                        response: { result: "a" },
                    },
                },
            ],
        },
    ];
    const migrated = migrateLegacyMessages(legacy);
    expect(migrateLegacyMessages(legacy)).toEqual(migrated);
    expect(
        recoverInterruptedMessages(migrated)[2]?.toolResults?.[0]?.callId,
    ).toBe("legacy-0-1");
    expect(() =>
        migrateLegacyMessages([
            {
                role: "tool",
                parts: [{ functionResponse: { name: "missing" } }],
            },
        ]),
    ).toThrow("matching");
});

test("actual Gemini adapter translates streamed chunks once and forwards cancellation", async () => {
    const signal = new AbortController().signal;
    const tokens: string[] = [];
    const generateContentStream = mock(async (request) => {
        expect(request.model).toBe(DEFAULT_GEMINI_MODEL);
        expect(request.config.abortSignal).toBe(signal);
        expect(request.contents).toEqual([
            { role: "user", parts: [{ text: "inspect" }] },
        ]);
        return (async function* () {
            const text = new GenerateContentResponse();
            text.candidates = [{ content: { parts: [{ text: "Looking" }] } }];
            yield text;
            const tools = new GenerateContentResponse();
            tools.candidates = [{ content: { parts: repeatedCalls } }];
            yield tools;
        })();
    });
    const provider = new GeminiProvider("fixture", {
        models: { generateContentStream },
    });
    const response = await provider.generate(
        [{ role: "user", content: "inspect" }],
        [],
        undefined,
        undefined,
        {
            signal,
            onToken: (token) => tokens.push(token),
        },
    );
    expect(response.error).toBeUndefined();
    expect(response.text).toBe("Looking");
    expect(response.toolcalls?.map((call) => call.id)).toEqual([
        "first",
        "second",
    ]);
    expect(response.native?.data).toHaveLength(3);
    expect(tokens).toEqual(["Looking"]);
});

test("main agent returns distinct results for repeated tools through the shared protocol", async () => {
    const registry = new ToolRegistry();
    registry.registerTool({
        name: "read_file",
        effect: "read",
        description: "fixture",
        parameters: z.object({ path: z.string() }),
        execute: async ({ path }) => path,
    });
    let requests = 0;
    const agent = new Agent(
        {
            generate: async (messages) => {
                requests++;
                if (requests === 1) {
                    return geminiResponse(
                        repeatedCalls,
                        "",
                        DEFAULT_GEMINI_MODEL,
                    );
                }
                if (requests === 2) {
                    return { role: "assistant", text: '{"isGood":true}' };
                }
                const results = messages.flatMap(
                    (message) => message.toolResults ?? [],
                );
                expect(
                    results.map((result) => [
                        result.callId,
                        result.output.result,
                    ]),
                ).toEqual([
                    ["first", "a.ts"],
                    ["second", "b.ts"],
                ]);
                expect(
                    geminiContents(messages, DEFAULT_GEMINI_MODEL).length,
                ).toBe(4);
                return { role: "assistant", text: "Inspected both" };
            },
        },
        registry,
        3,
        "REXA",
        { stop: async () => {} },
    );
    Object.assign(agent, {
        inputGuardrails: { validate: async () => ({ isSafe: true }) },
        outputGuardrails: { outputValidation: async () => ({ isSafe: true }) },
    });
    expect((await agent.run("inspect files", "plan")).text).toBe(
        "Inspected both",
    );
});

test("catalog validates provider/model/effort combinations without claiming adapter availability", () => {
    const catalog = new ModelCatalog();
    expect(catalog.list("gemini").map((model) => model.id)).toEqual([
        DEFAULT_GEMINI_MODEL,
    ]);
    expect(
        catalog.validateSettings({
            provider: "gemini",
            model: DEFAULT_GEMINI_MODEL,
        }).reasoning,
    ).toBe("default");
    expect(
        catalog.validateSettings({
            provider: "openai",
            model: "gpt-5",
            reasoning: "minimal",
        }).reasoning,
    ).toBe("minimal");
    expect(
        catalog.validateSettings({
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            reasoning: "max",
        }).reasoning,
    ).toBe("max");
    for (const input of [
        {
            provider: "gemini",
            model: DEFAULT_GEMINI_MODEL,
            reasoning: "minimal",
        },
        { provider: "openai", model: "gpt-5", reasoning: "max" },
        { provider: "openai", model: DEFAULT_GEMINI_MODEL },
        { provider: "unknown", model: "anything" },
        { provider: "gemini", model: "made-up-model" },
    ]) {
        expect(() => catalog.validateSettings(input)).toThrow();
    }
    const copy = catalog.list("gemini");
    copy[0]!.reasoning.levels.length = 0;
    expect(catalog.list("gemini")[0]?.reasoning.levels).toEqual([
        "low",
        "medium",
        "high",
    ]);
});

test("fixed reasoning and incomplete coding capabilities cannot expose invalid options", () => {
    const model: ModelDefinition = {
        provider: "gemini",
        id: "fixture-fixed",
        displayName: "Fixture",
        tools: true,
        streaming: true,
        reasoning: { kind: "fixed", levels: [] },
        sources: ["https://example.com/fixture"],
        reviewedAt: "2026-10-13",
    };
    const catalog = new ModelCatalog([model]);
    expect(
        catalog.validateSettings({ provider: "gemini", model: model.id })
            .reasoning,
    ).toBe("default");
    expect(() =>
        catalog.validateSettings({
            provider: "gemini",
            model: model.id,
            reasoning: "high",
        }),
    ).toThrow();
    expect(() => new ModelCatalog([model, model])).toThrow("Duplicate");
    expect(
        () =>
            new ModelCatalog([
                { ...model, reasoning: { kind: "fixed", levels: ["high"] } },
            ]),
    ).toThrow();
    expect(() =>
        new ModelCatalog([{ ...model, tools: false }]).validateSettings({
            provider: "gemini",
            model: model.id,
        }),
    ).toThrow("capabilities");
});

test("discovery filters unknown IDs, caches visibility, expires and refreshes without inventing capabilities", async () => {
    let now = 0;
    const catalog = new ModelCatalog(undefined, () => now);
    const discover = mock(async () => [
        DEFAULT_GEMINI_MODEL,
        "unknown-future-model",
        "gpt-5",
    ]);
    const first = await catalog.discover("gemini", discover);
    expect(first.models.map((model) => model.id)).toEqual([
        DEFAULT_GEMINI_MODEL,
    ]);
    expect(first.source).toBe("discovery");
    expect((await catalog.discover("gemini", discover)).source).toBe("cache");
    expect(discover).toHaveBeenCalledTimes(1);
    now = 16 * 60 * 1000;
    await catalog.discover("gemini", discover);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(
        (await catalog.discover("gemini", async () => [], { refresh: true }))
            .models,
    ).toEqual([]);
});

test("discovery failure uses verified fallback and cancellation never becomes fallback", async () => {
    const catalog = new ModelCatalog();
    const fail = async (): Promise<string[]> => {
        throw new Error("offline");
    };
    const fallback = await catalog.discover("openai", fail);
    expect(fallback.source).toBe("catalog");
    expect(fallback.warning).toContain("not confirmed");
    await catalog.discover("openai", async () => ["gpt-5"]);
    expect(
        (await catalog.discover("openai", fail, { refresh: true })).source,
    ).toBe("cache");
    const cancelled = new AbortController();
    await expect(
        catalog.discover(
            "gemini",
            async (signal) => {
                cancelled.abort(new Error("user cancelled"));
                expect(signal.aborted).toBe(true);
                return new Promise<string[]>(() => {});
            },
            { signal: cancelled.signal },
        ),
    ).rejects.toThrow("user cancelled");
    const oversized = await catalog.discover("anthropic", async () =>
        Array.from({ length: 501 }, (_, index) => `model-${index}`),
    );
    expect(oversized.source).toBe("catalog");
});
