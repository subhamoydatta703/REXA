import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm, appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
    SessionStore,
    recoverInterruptedMessages,
} from "../../src/sessions/SessionStore";
import { ContextManager } from "../../src/sessions/ContextManager";
import { LocalCommands } from "../../src/cli/LocalCommands";
import { Agent } from "../../src/agent/Agent";
import { ToolRegistry } from "../../src/tools/ToolRegistry";
import { CheckpointStore } from "../../src/tools/CheckpointStore";
import { Workspace } from "../../src/tools/Workspace";
import type { Message } from "../../src/agent/Message";

let root: string, store: SessionStore;
beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "rexa-session-"));
    store = new SessionStore(root, path.join(root, "sessions"));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

test("restart restores session, ignores incomplete tail, and can append afterward", async () => {
    const session = await store.create();
    session.messages = [{ role: "user", content: "Keep existing edits" }];
    session.status = "running";
    await store.save(session);
    await appendFile(
        path.join(store.directory, session.id + ".jsonl"),
        '{"partial":',
    );
    const restarted = new SessionStore(root, store.directory);
    const loaded = await restarted.load(session.id);
    expect(loaded.messages[0]?.content).toBe("Keep existing edits");
    expect(loaded.status).toBe("running");
    loaded.status = "complete";
    await restarted.save(loaded);
    expect((await restarted.load(session.id)).status).toBe("complete");
    await expect(
        new SessionStore(path.join(root, "other"), store.directory).load(
            session.id,
        ),
    ).rejects.toThrow("mismatch");
});
test("corruption in committed records is reported", async () => {
    const session = await store.create();
    await appendFile(
        path.join(store.directory, session.id + ".jsonl"),
        "invalid\n",
    );
    await expect(store.load(session.id)).rejects.toThrow();
});
test("known credentials are not persisted and provider signatures survive", async () => {
    const previous = process.env.REXA_TEST_API_KEY;
    process.env.REXA_TEST_API_KEY = "fixture-credential-value";
    try {
        const session = await store.create();
        session.messages = [
            {
                role: "model",
                content: "fixture-credential-value",
                parts: [
                    {
                        thoughtSignature: "provider-signature",
                        functionCall: {
                            name: "example",
                            args: { api_key: "other-value" },
                        },
                    },
                ],
            },
        ];
        await store.save(session);
        const bytes = await readFile(
            path.join(store.directory, session.id + ".jsonl"),
            "utf8",
        );
        expect(bytes).not.toContain("fixture-credential-value");
        expect(bytes).not.toContain("other-value");
        expect(bytes).toContain("provider-signature");
    } finally {
        if (previous === undefined) delete process.env.REXA_TEST_API_KEY;
        else process.env.REXA_TEST_API_KEY = previous;
    }
});
test("recovery completes only missing tool results without executing anything", () => {
    const messages: Message[] = [
        {
            role: "model",
            parts: [
                { functionCall: { name: "read_file", args: {} } },
                { functionCall: { name: "code_tool", args: {} } },
            ],
        },
        {
            role: "tool",
            parts: [
                {
                    functionResponse: {
                        name: "read_file",
                        response: { result: "read" },
                    },
                },
            ],
        },
    ];
    const recovered = recoverInterruptedMessages(messages);
    expect(recovered).toHaveLength(3);
    expect(JSON.stringify(recovered[2])).toContain("outcome unknown");
    expect(recoverInterruptedMessages(recovered)).toEqual(recovered);
});
test("compaction preserves original requirements and recent call/result structure", async () => {
    const messages: Message[] = [
        {
            role: "user",
            content: "Preserve user changes and add authentication tests.",
        },
    ];
    for (let i = 0; i < 8; i++)
        messages.push(
            {
                role: "model",
                parts: [
                    {
                        functionCall: {
                            name: "read_file",
                            args: { path: "a.ts" },
                        },
                    },
                ],
            },
            {
                role: "tool",
                parts: [
                    {
                        functionResponse: {
                            name: "read_file",
                            response: { result: "fixture ".repeat(2000) },
                        },
                    },
                ],
            },
        );
    const manager = new ContextManager(100_000, 2);
    const compacted = await manager.compact(messages, {
        generate: async () => ({
            role: "assistant",
            text: "Changed a.ts; tests failed; still need to fix login. Preserve user edits.",
        }),
    });
    expect(compacted[0]?.content).toContain(
        "Preserve user changes and add authentication tests.",
    );
    expect(compacted[0]?.content).toContain("tests failed");
    expect(compacted.slice(1)).toEqual(messages.slice(-4));
    await expect(
        manager.compact(messages, {
            generate: async () => ({
                role: "assistant",
                text: "",
                error: { type: "failed", message: "fixture" },
            }),
        }),
    ).rejects.toThrow("failed");
    expect(messages).toHaveLength(17);
});
test("agent saves, restarts, resumes, and local slash commands don't call the model", async () => {
    const generate = mock(async (messages: Message[]) => ({
        role: "assistant",
        text: messages.some((m) => m.content === "original task")
            ? "Original task remains available."
            : "missing",
    }));
    const makeAgent = () => {
        const a = new Agent({ generate }, new ToolRegistry(), 2, "REXA", {
            stop: async () => {},
        });
        a.enableSessions(store);
        (a as any).inputGuardrails = {
            validate: async () => ({ isSafe: true }),
        };
        (a as any).outputGuardrails = {
            outputValidation: async () => ({ isSafe: true }),
        };
        return a;
    };
    const firstAgent = makeAgent();
    await firstAgent.run("original task", "plan");
    await firstAgent.closeSession();
    const restarted = makeAgent();
    const commands = new LocalCommands(
        restarted,
        new CheckpointStore(
            new Workspace(root),
            path.join(root, "checkpoints"),
        ),
    );
    const count = generate.mock.calls.length;
    const resumed = await commands.handle("/continue");
    expect(resumed?.mode).toBe("plan");
    expect(generate.mock.calls.length).toBe(count);
    expect((await restarted.run("continue task", "act")).text).toContain(
        "Original task",
    );
    expect((await commands.handle("/nonexistent"))?.text).toContain(
        "Unknown local command",
    );
    expect(await commands.handle("ordinary input")).toBeNull();
    await commands.handle("/new");
    expect((await restarted.run("new task")).text).toBe("missing");
    await restarted.closeSession();
});
