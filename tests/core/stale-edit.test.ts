import { afterEach, beforeEach, expect, test } from "bun:test";
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Agent } from "../../src/agent/Agent";
import type { Message } from "../../src/agent/Message";
import type { LLMProvider } from "../../src/providers/LLMProvider";
import { SessionStore } from "../../src/sessions/SessionStore";
import { atomicText, CheckpointStore } from "../../src/tools/CheckpointStore";
import {
    PermissionService,
    permissions,
    setPermissions,
} from "../../src/tools/PermissionService";
import { ProcessManager } from "../../src/tools/ProcessManager";
import { repositoryTools } from "../../src/tools/RepositoryTools";
import { SafeEditor } from "../../src/tools/SafeEditor";
import { StaleEditRecovery } from "../../src/tools/StaleEditRecovery";
import { ToolDispatcher } from "../../src/tools/ToolDispatcher";
import { ToolRegistry } from "../../src/tools/ToolRegistry";
import { contentHash, Workspace } from "../../src/tools/Workspace";

let root: string;
let workspace: Workspace;
let editor: SafeEditor;
let recovery: StaleEditRecovery;
let previousPermissions: PermissionService;

const original = "export const count = 1;\n// initial comment\n";
const userChange = "export const count = 1;\n// keep the user's note\n";
const editCount = {
    operation: "edit",
    path: "a.ts",
    changes: [{ type: "replace", target: "count = 1", content: "count = 2" }],
};

beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "rexa-stale-edit-"));
    await mkdir(path.join(root, "project"));
    workspace = new Workspace(path.join(root, "project"));
    editor = new SafeEditor(
        workspace,
        new CheckpointStore(workspace, path.join(root, "checkpoints")),
    );
    recovery = new StaleEditRecovery();
    await writeFile(path.join(workspace.root, "a.ts"), original);
    await workspace.read("a.ts");
    previousPermissions = permissions;
    setPermissions(new PermissionService([{ action: "allow" }]));
});

afterEach(async () => {
    setPermissions(previousPermissions);
    await rm(root, { recursive: true, force: true });
});

const contents = () => readFile(path.join(workspace.root, "a.ts"), "utf8");
const execute = (request: unknown = editCount) =>
    editor.execute(request, { editRecovery: recovery });

test("stale errors are structured; a supplied hash or empty read cannot bypass rereading", async () => {
    await writeFile(path.join(workspace.root, "a.ts"), userChange);
    await expect(execute()).rejects.toMatchObject({
        code: "STALE_FILE",
        path: "a.ts",
        retrySafe: true,
    });
    await expect(
        execute({ ...editCount, expected_hash: contentHash(userChange) }),
    ).rejects.toMatchObject({ code: "FRESH_READ_REQUIRED" });
    await workspace.read("a.ts", 999, 1000);
    await expect(execute()).rejects.toMatchObject({
        code: "FRESH_READ_REQUIRED",
    });
    expect(await contents()).toBe(userChange);
    expect(await editor.checkpoints.list()).toEqual([]);
});

test("fresh inspection allows a revised edit and preserves unrelated user changes", async () => {
    await writeFile(path.join(workspace.root, "a.ts"), userChange);
    await expect(execute()).rejects.toMatchObject({ code: "STALE_FILE" });
    const latest = await workspace.read("a.ts");
    const result = await execute({ ...editCount, expected_hash: latest.hash });
    expect(result.success).toBe(true);
    expect(await contents()).toBe(userChange.replace("count = 1", "count = 2"));
    expect(recovery.unresolvedNotice()).toBe("");
    await editor.checkpoints.undo(result.checkpoint);
    expect(await contents()).toBe(userChange);
});

test("an explicit hash cannot replace inspecting a newer concurrent change", async () => {
    await writeFile(path.join(workspace.root, "a.ts"), userChange);
    await expect(execute()).rejects.toMatchObject({ code: "STALE_FILE" });
    await workspace.read("a.ts");
    const newerChange = `${userChange}// another user change\n`;
    await writeFile(path.join(workspace.root, "a.ts"), newerChange);
    await expect(
        execute({ ...editCount, expected_hash: contentHash(newerChange) }),
    ).rejects.toMatchObject({ code: "FRESH_READ_REQUIRED" });
    expect(await contents()).toBe(newerChange);
    const inspected = await workspace.read("a.ts");
    await execute({ ...editCount, expected_hash: inspected.hash });
    expect(await contents()).toBe(
        newerChange.replace("count = 1", "count = 2"),
    );
});

test("two recovery attempts are the limit; reads and path spellings do not reset it", async () => {
    await writeFile(path.join(workspace.root, "a.ts"), userChange);
    await expect(execute()).rejects.toMatchObject({ code: "STALE_FILE" });
    for (let attempt = 1; attempt <= 2; attempt++) {
        await workspace.read("a.ts");
        await writeFile(
            path.join(workspace.root, "a.ts"),
            `${userChange}// concurrent change ${attempt}\n`,
        );
        await expect(execute()).rejects.toMatchObject({
            code: attempt === 2 ? "STALE_RETRY_LIMIT" : "STALE_FILE",
        });
    }
    await workspace.read("a.ts");
    await workspace.read("a.ts");
    await expect(
        execute({ ...editCount, path: "./a.ts" }),
    ).rejects.toMatchObject({ code: "STALE_RETRY_LIMIT", retrySafe: false });
    expect(await contents()).toContain("count = 1");
    // A new user task receives its own budget.
    await editor.execute(editCount, { editRecovery: new StaleEditRecovery() });
    expect(await contents()).toContain("count = 2");
});

test("a previously successful recovery does not reset the task's attempt budget", async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
        await writeFile(
            path.join(workspace.root, "a.ts"),
            `${original}// user change ${attempt}\n`,
        );
        await expect(execute()).rejects.toMatchObject({ code: "STALE_FILE" });
        await workspace.read("a.ts");
        await execute();
    }
    await writeFile(
        path.join(workspace.root, "a.ts"),
        `${original}// third change\n`,
    );
    await expect(execute()).rejects.toMatchObject({
        code: "STALE_RETRY_LIMIT",
    });
    await workspace.read("a.ts");
    await expect(execute()).rejects.toMatchObject({
        code: "STALE_RETRY_LIMIT",
    });
});

test("a stale member of a batch prevents every write", async () => {
    await writeFile(path.join(workspace.root, "a.ts"), userChange);
    await expect(
        execute({
            operations: [
                {
                    operation: "create",
                    path: "new.ts",
                    content: "must not appear",
                },
                editCount,
            ],
        }),
    ).rejects.toMatchObject({ code: "STALE_FILE" });
    expect(await Bun.file(path.join(workspace.root, "new.ts")).exists()).toBe(
        false,
    );
    expect(await contents()).toBe(userChange);
    expect(await editor.checkpoints.list()).toEqual([]);
});

test("fresh reads keep missing and ambiguous targets as errors", async () => {
    await writeFile(
        path.join(workspace.root, "a.ts"),
        "count = 9; count = 9;\n",
    );
    await expect(execute()).rejects.toMatchObject({ code: "STALE_FILE" });
    await workspace.read("a.ts");
    await expect(execute()).rejects.toThrow("TARGET_NOT_FOUND");
    await workspace.read("a.ts");
    await expect(
        execute({
            ...editCount,
            changes: [
                { type: "replace", target: "count = 9", content: "count = 2" },
            ],
        }),
    ).rejects.toThrow("AMBIGUOUS_TARGET");
    expect(await contents()).toBe("count = 9; count = 9;\n");
});

test("commit validation reports a change occurring after edit preparation", async () => {
    class RacingCheckpointStore extends CheckpointStore {
        override async commit(
            changes: Parameters<CheckpointStore["commit"]>[0],
            signal?: AbortSignal,
        ) {
            await writeFile(path.join(workspace.root, "a.ts"), userChange);
            return super.commit(changes, signal);
        }
    }
    const racingEditor = new SafeEditor(
        workspace,
        new RacingCheckpointStore(workspace, path.join(root, "race")),
    );
    await expect(
        racingEditor.execute(editCount, { editRecovery: recovery }),
    ).rejects.toMatchObject({ code: "STALE_FILE", retrySafe: true });
    expect(await contents()).toBe(userChange);
});

test("rollback conflicts retain the checkpoint and block further editing in the task", async () => {
    await writeFile(path.join(workspace.root, "b.ts"), "before");
    await workspace.read("b.ts");
    let writes = 0;
    const store = new CheckpointStore(
        workspace,
        path.join(root, "conflict"),
        async (target, text, mode) => {
            await atomicText(target, text, mode);
            if (++writes === 1)
                await writeFile(
                    path.join(workspace.root, "b.ts"),
                    "concurrent user work",
                );
        },
    );
    const conflictingEditor = new SafeEditor(workspace, store);
    await expect(
        conflictingEditor.execute(
            {
                operations: [
                    editCount,
                    { operation: "write", path: "b.ts", content: "after" },
                ],
            },
            { editRecovery: recovery },
        ),
    ).rejects.toMatchObject({
        code: "RECOVERY_CONFLICT",
        path: "b.ts",
        retrySafe: false,
    });
    expect(await readFile(path.join(workspace.root, "b.ts"), "utf8")).toBe(
        "concurrent user work",
    );
    expect((await store.list())[0]?.status).toBe("pending");
    await expect(
        conflictingEditor.execute(
            { operation: "create", path: "new.ts", content: "blocked" },
            { editRecovery: recovery },
        ),
    ).rejects.toMatchObject({ code: "RECOVERY_CONFLICT" });
    expect(await Bun.file(path.join(workspace.root, "new.ts")).exists()).toBe(
        false,
    );
});

test("cancellation during a batch rolls back completed writes", async () => {
    await writeFile(path.join(workspace.root, "b.ts"), "before");
    await workspace.read("b.ts");
    const cancellation = new AbortController();
    const store = new CheckpointStore(
        workspace,
        path.join(root, "cancel"),
        async (target, text, mode) => {
            await atomicText(target, text, mode);
            cancellation.abort(new Error("fixture cancellation"));
        },
    );
    await expect(
        new SafeEditor(workspace, store).execute(
            {
                operations: [
                    editCount,
                    { operation: "write", path: "b.ts", content: "after" },
                ],
            },
            { signal: cancellation.signal, editRecovery: recovery },
        ),
    ).rejects.toThrow("fixture cancellation");
    expect(await contents()).toBe(original);
    expect(await readFile(path.join(workspace.root, "b.ts"), "utf8")).toBe(
        "before",
    );
    expect((await store.list())[0]?.status).toBe("rolled_back");
});

test("recovery reads and limits use the real file behind directory symlinks", async () => {
    await symlink(
        workspace.root,
        path.join(workspace.root, "alias"),
        process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(path.join(workspace.root, "a.ts"), userChange);
    await expect(execute()).rejects.toMatchObject({ code: "STALE_FILE" });
    await expect(
        execute({
            ...editCount,
            path: "alias/a.ts",
            expected_hash: contentHash(userChange),
        }),
    ).rejects.toMatchObject({ code: "FRESH_READ_REQUIRED" });
    await workspace.read("alias/a.ts");
    await execute({ operation: "delete", path: "alias/a.ts" });
    expect(await Bun.file(path.join(workspace.root, "a.ts")).exists()).toBe(
        false,
    );
    expect(recovery.unresolvedNotice()).toBe("");
});

function latestToolResult(messages: Message[]): Record<string, unknown> {
    const message = messages.at(-1);
    const result = message?.toolResults?.[0]?.output.result;
    if (!result || typeof result !== "object")
        throw new Error("Expected a structured tool result");
    return result as Record<string, unknown>;
}

function fixtureAgent(llm: LLMProvider, registry: ToolRegistry): Agent {
    const agent = new Agent(llm, registry, 15, "REXA", {
        stop: async () => {},
    });
    Object.assign(agent, {
        inputGuardrails: { validate: async () => ({ isSafe: true }) },
        outputGuardrails: { outputValidation: async () => ({ isSafe: true }) },
    });
    return agent;
}

test("agent persists the failure, reads again, revises the edit, and runs a real fixture test", async () => {
    const processes = new ProcessManager();
    const registry = new ToolRegistry();
    for (const tool of repositoryTools(workspace)) registry.registerTool(tool);
    registry.registerTool(editor.tool());
    registry.registerTool({
        name: "execute_command",
        effect: "command",
        description: "Run the fixture tests locally",
        parameters: z.object({ args: z.array(z.string()) }),
        execute: async (input: { args: string[] }) => {
            const id = await processes.start(
                [process.execPath, ...input.args],
                { cwd: workspace.root, timeoutMs: 5000 },
            );
            return processes.wait(id);
        },
    });
    await writeFile(
        path.join(workspace.root, "a.test.ts"),
        "import { expect, test } from 'bun:test'; import { count } from './a'; test('count', () => expect(count).toBe(2));\n",
    );
    await writeFile(path.join(workspace.root, "a.ts"), userChange);
    const latestUserCode = userChange.replace("count = 1", "count = 100");
    await writeFile(path.join(workspace.root, "a.ts"), latestUserCode);
    const sessions = new SessionStore(
        workspace.root,
        path.join(root, "sessions"),
    );
    let turn = 0;
    const llm: LLMProvider = {
        generate: async (messages, _tools, systemPrompt) => {
            if (messages.at(-1)?.content?.includes("Review this plan")) {
                return { role: "assistant", text: '{"isGood":true}' };
            }
            expect(systemPrompt).toContain("Preserve user changes");
            switch (turn++) {
                case 0:
                    return {
                        role: "model",
                        text: "",
                        toolcalls: [{ id: "fixture-14781", name: "code_tool", params: editCount }],
                    };
                case 1: {
                    expect(latestToolResult(messages).code).toBe("STALE_FILE");
                    const saved = (await sessions.list())[0]!;
                    expect(JSON.stringify(saved.messages)).toContain(
                        '"code":"STALE_FILE"',
                    );
                    return {
                        role: "model",
                        text: "",
                        toolcalls: [
                            { id: "fixture-15323", name: "read_file", params: { path: "a.ts" } },
                        ],
                    };
                }
                case 2:
                    expect(latestToolResult(messages).content).toContain(
                        "keep the user's note",
                    );
                    expect(latestToolResult(messages).content).toContain(
                        "count = 100",
                    );
                    return {
                        role: "model",
                        text: "",
                        toolcalls: [
                            {
                                id: "fixture-15912",
                                name: "code_tool",
                                params: {
                                    ...editCount,
                                    changes: [
                                        {
                                            type: "replace",
                                            target: "count = 100",
                                            content: "count = 2",
                                        },
                                    ],
                                },
                            },
                        ],
                    };
                case 3:
                    expect(latestToolResult(messages).success).toBe(true);
                    return {
                        role: "model",
                        text: "",
                        toolcalls: [
                            {
                                id: "fixture-16804",
                                name: "execute_command",
                                params: { args: ["test"] },
                            },
                        ],
                    };
                default:
                    expect(latestToolResult(messages).success).toBe(true);
                    return {
                        role: "assistant",
                        text: "Updated the count, preserved your note, and the fixture test passed.",
                    };
            }
        },
    };
    const agent = fixtureAgent(llm, registry);
    agent.enableSessions(sessions);
    try {
        const response = await agent.run("Change count to 2 and test it.");
        expect(response.text).not.toContain("Unresolved edit conflicts");
        expect(await contents()).toBe(
            userChange.replace("count = 1", "count = 2"),
        );
        expect((await sessions.list())[0]?.status).toBe("complete");
    } finally {
        await agent.closeSession();
        await processes.stopAll();
    }
});

test("cancelling after a stale result stops recovery and saves an interrupted session", async () => {
    await writeFile(path.join(workspace.root, "a.ts"), userChange);
    const registry = new ToolRegistry();
    for (const tool of repositoryTools(workspace)) {
        registry.registerTool(tool);
    }
    registry.registerTool(editor.tool());
    const cancellation = new AbortController();
    let turn = 0;
    const llm: LLMProvider = {
        generate: async (messages) => {
            if (messages.at(-1)?.content?.includes("Review this plan")) {
                return { role: "assistant", text: '{"isGood":true}' };
            }
            if (turn++ === 0) {
                return {
                    role: "model",
                    text: "",
                    toolcalls: [{ id: "fixture-18650", name: "code_tool", params: editCount }],
                };
            }
            expect(latestToolResult(messages).code).toBe("STALE_FILE");
            cancellation.abort(new Error("fixture cancelled recovery"));
            return {
                role: "model",
                text: "",
                toolcalls: [{ id: "fixture-18977", name: "read_file", params: { path: "a.ts" } }],
            };
        },
    };
    const agent = fixtureAgent(llm, registry);
    const sessions = new SessionStore(
        workspace.root,
        path.join(root, "cancelled-sessions"),
    );
    agent.enableSessions(sessions);
    try {
        await expect(
            agent.run("Change count to 2", "act", {
                signal: cancellation.signal,
            }),
        ).rejects.toThrow("fixture cancelled recovery");
        expect(await contents()).toBe(userChange);
        expect((await workspace.lastRead("a.ts"))?.revision).toBe(1);
        expect((await sessions.list())[0]?.status).toBe("interrupted");
    } finally {
        await agent.closeSession();
    }
});

test("unresolved conflicts appear in the final response; permission denial still blocks retries", async () => {
    await writeFile(path.join(workspace.root, "a.ts"), userChange);
    const registry = new ToolRegistry();
    registry.registerTool(editor.tool());
    let turn = 0;
    const agent = fixtureAgent(
        {
            generate: async (messages) => {
                if (messages.at(-1)?.content?.includes("Review this plan"))
                    return { role: "assistant", text: '{"isGood":true}' };
                if (turn++ === 0)
                    return {
                        role: "model",
                        text: "",
                        toolcalls: [{ id: "fixture-20408", name: "code_tool", params: editCount }],
                    };
                return {
                    role: "assistant",
                    text: "The edit could not finish.",
                };
            },
        },
        registry,
    );
    expect((await agent.run("Change count to 2")).text).toContain(
        "Unresolved edit conflicts: a.ts",
    );
    await workspace.read("a.ts");
    const dispatcher = new ToolDispatcher(
        registry,
        new PermissionService([{ action: "deny" }]),
    );
    const denied = await dispatcher.execute("code_tool", editCount, "act", {
        editRecovery: recovery,
    });
    expect(denied.status).toBe("rejected");
    expect(await contents()).toBe(userChange);
});
