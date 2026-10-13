import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
    mkdtemp,
    mkdir,
    rm,
    writeFile,
    readFile,
    readdir,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { Workspace } from "../../src/tools/Workspace";
import { ToolRegistry, type Tool } from "../../src/tools/ToolRegistry";
import {
    PermissionService,
    permissions,
    setPermissions,
} from "../../src/tools/PermissionService";
import { ToolDispatcher } from "../../src/tools/ToolDispatcher";
import { VerificationRunner } from "../../src/verification/VerificationRunner";
import { VerificationWorkflow } from "../../src/verification/VerificationWorkflow";
import {
    verificationEvidenceSchema,
    debuggingSubmissionSchema,
    type CheckResult,
    type DebuggingSubmission,
    type VerificationCheck,
} from "../../src/verification/VerificationResults";
import { DebuggingAgent } from "../../src/agent/DebuggingAgent";
import { Agent } from "../../src/agent/Agent";
import type { LLMProvider } from "../../src/providers/LLMProvider";
import type { LLMResponse } from "../../src/providers/LLMResponse";
import { repositoryTools } from "../../src/tools/RepositoryTools";
import { SafeEditor } from "../../src/tools/SafeEditor";
import { CheckpointStore } from "../../src/tools/CheckpointStore";
import { ProcessManager } from "../../src/tools/ProcessManager";
import { SessionStore } from "../../src/sessions/SessionStore";
import { StaleEditRecovery } from "../../src/tools/StaleEditRecovery";

let temporary: string;
let workspace: Workspace;
let previousPermissions: PermissionService;
const check: VerificationCheck = {
    name: "login",
    command: "bun",
    args: ["test", "login.test.ts"],
    directory: ".",
    timeoutMs: 10_000,
};
const edit: Tool = {
    name: "code_tool",
    effect: "edit",
    description: "fixture",
    parameters: z.object({}),
    execute: async () => ({}),
};

beforeEach(async () => {
    previousPermissions = permissions;
    setPermissions(new PermissionService([{ action: "allow" }]));
    temporary = await mkdtemp(path.join(tmpdir(), "rexa-debugging-"));
    const root = path.join(temporary, "project");
    await mkdir(root);
    workspace = new Workspace(root);
    await writeFile(
        path.join(root, "login.ts"),
        "export const allowsWrongPassword = true;\n",
    );
    await writeFile(path.join(root, "login.test.ts"), "// fixture test\n");
});
afterEach(async () => {
    setPermissions(previousPermissions);
    await rm(temporary, { recursive: true, force: true });
});

function commandResult(exitCode = 0) {
    return {
        success: exitCode === 0,
        status: exitCode === 0 ? "executed" : "failed",
        exitCode,
        stdout: "fixture output",
        stderr: "",
    };
}
function commandRegistry(execute: Tool["execute"]) {
    const registry = new ToolRegistry();
    registry.registerTool({
        name: "execute_command",
        effect: "command",
        description: "fixture",
        parameters: z.object({
            command: z.string(),
            args: z.array(z.string()),
            workdir: z.string(),
            timeoutMs: z.number(),
            background: z.boolean(),
        }),
        execute,
    });
    return registry;
}
function submission(): DebuggingSubmission {
    return {
        coverage: [
            {
                behavior: "wrong passwords are rejected",
                testFiles: ["login.test.ts"],
                checkNames: ["login"],
            },
        ],
        checks: [check],
        findings: [],
        testChangesReason: "",
        blockedReason: "",
    };
}
async function configure(checks: VerificationCheck[]) {
    await writeFile(
        path.join(workspace.root, "rexa.verify.json"),
        JSON.stringify({ version: 1, checks }),
    );
}
async function changedWorkflow(
    execute: Tool["execute"] = async () => commandResult(),
) {
    const workflow = await VerificationWorkflow.create(
        workspace,
        new ToolDispatcher(commandRegistry(execute)),
        {},
    );
    workflow.observe(edit, { success: true, changedFiles: ["login.ts"] });
    return workflow;
}
function fixtureAgent(llm: LLMProvider, registry: ToolRegistry) {
    const agent = new Agent(llm, registry, 40, "fixture", {
        stop: async () => {},
    });
    Object.assign(agent, {
        inputGuardrails: { validate: async () => ({ isSafe: true }) },
        outputGuardrails: { outputValidation: async () => ({ isSafe: true }) },
    });
    agent.enableVerification(workspace);
    return agent;
}

test("verification directory contains exactly the three agreed files", async () => {
    expect((await readdir(path.resolve("src/verification"))).sort()).toEqual([
        "VerificationResults.ts",
        "VerificationRunner.ts",
        "VerificationWorkflow.ts",
    ]);
});

test("command validation rejects traversal, invalid timeouts, duplicate names, missing directories, watch, and autofix", async () => {
    const runner = new VerificationRunner(
        workspace,
        new ToolDispatcher(commandRegistry(async () => commandResult())),
        {},
    );
    for (const invalid of [
        { ...check, directory: "../outside" },
        { ...check, directory: "/tmp" },
        { ...check, directory: "C:/tmp" },
        { ...check, timeoutMs: 300_001 },
        { ...check, directory: "missing" },
        { ...check, args: ["--watch"] },
        { ...check, args: ["--fix"] },
    ]) {
        await expect(runner.validateChecks([invalid])).rejects.toThrow();
    }
    await expect(runner.validateChecks([check, check])).rejects.toThrow(
        "unique",
    );
    await expect(runner.validateChecks([])).rejects.toThrow();
    await mkdir(path.join(workspace.root, "tests"));
    expect(
        (await runner.validateChecks([{ ...check, directory: "tests" }]))[0]
            ?.directory,
    ).toBe("tests");
});

test("optional discovery avoids ambiguous managers, watchers, autofix, and plain test scripts", async () => {
    const runner = new VerificationRunner(
        workspace,
        new ToolDispatcher(commandRegistry(async () => commandResult())),
        {},
    );
    await writeFile(
        path.join(workspace.root, "package.json"),
        JSON.stringify({
            scripts: {
                typecheck: "tsc --noEmit",
                lint: "eslint --fix .",
                "test:run": "vitest --watch",
                test: "vitest",
            },
        }),
    );
    expect((await runner.discoverChecks()).checks).toHaveLength(0);
    await writeFile(path.join(workspace.root, "bun.lock"), "");
    expect(
        (await runner.discoverChecks()).checks.map((item) => item.name),
    ).toEqual(["typecheck"]);
    await writeFile(path.join(workspace.root, "package-lock.json"), "{}");
    expect((await runner.discoverChecks()).checks).toHaveLength(0);
    await configure([check]);
    expect((await runner.discoverChecks()).checks).toEqual([check]);
    await writeFile(path.join(workspace.root, "rexa.verify.json"), "{");
    expect((await runner.discoverChecks()).notices.join(" ")).toContain(
        "invalid",
    );
});

test("runner preserves failure messages and locations without inventing root causes", async () => {
    const runner = new VerificationRunner(
        workspace,
        new ToolDispatcher(
            commandRegistry(async () => ({
                ...commandResult(1),
                stderr: "FAIL rejects wrong password\nExpected: 401\nReceived: 200\n at tests/login.test.ts:84:9",
            })),
        ),
        {},
    );
    const results: CheckResult[] = [];
    await runner.run([check], results);
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.stderr).toContain("Expected: 401");
    expect(results[0]?.locations).toEqual(["tests/login.test.ts:84:9"]);
    expect(results[0]?.detail).toBeUndefined();
});

test("runner separates completed failures, timeouts, denial, cancellation, and missing executables", async () => {
    for (const [result, expected] of [
        [commandResult(), "passed"],
        [commandResult(7), "failed"],
        [{ status: "timeout", exitCode: 124 }, "timed_out"],
        [{ status: "rejected" }, "denied"],
        [{ status: "cancelled" }, "cancelled"],
        [{ status: "failed", exitCode: 127, stderr: "ENOENT" }, "unavailable"],
    ] as const) {
        const runner = new VerificationRunner(
            workspace,
            new ToolDispatcher(commandRegistry(async () => result)),
            {},
        );
        const results: CheckResult[] = [];
        await runner.run([check], results);
        expect(results[0]?.status).toBe(expected);
    }
});

test("actual command permission denial prevents execution", async () => {
    const execute = mock(async () => commandResult());
    const dispatcher = new ToolDispatcher(
        commandRegistry(execute),
        new PermissionService([{ effect: "command", action: "deny" }]),
    );
    const results: CheckResult[] = [];
    await new VerificationRunner(workspace, dispatcher, {}).run(
        [check],
        results,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(results[0]?.status).toBe("denied");
});

test("new feature failures trigger repair without passing baselines and always rerun afterward", async () => {
    let calls = 0;
    const workflow = await changedWorkflow(async () =>
        commandResult(calls++ === 0 ? 1 : 0),
    );
    const phases: string[] = [];
    await workflow.finish(
        {
            execute: async (request) => {
                phases.push(request.phase);
                if (request.phase === "repair") {
                    expect(request.evidence.runs[0]?.[0]?.status).toBe(
                        "failed",
                    );
                    expect(request.evidence.debuggingMessages).toEqual([]);
                    await writeFile(
                        path.join(workspace.root, "login.ts"),
                        "fixed implementation",
                    );
                    workflow.observe(edit, {
                        success: true,
                        changedFiles: ["login.ts"],
                    });
                }
                return submission();
            },
        },
        "create login",
        "created login",
    );
    expect(phases).toEqual(["prepare", "repair"]);
    expect(calls).toBe(2);
    expect(workflow.snapshot().stage).toBe("completed");
    expect(workflow.snapshot().repairRounds).toBe(1);
});

test("passing tests complete, but missing coverage, missing files, and unknown check names block completion", async () => {
    const good = await changedWorkflow();
    await good.finish(
        { execute: async () => submission() },
        "create login",
        "done",
    );
    expect(good.snapshot().stage).toBe("completed");
    for (const bad of [
        { ...submission(), coverage: [] },
        {
            ...submission(),
            coverage: [
                {
                    ...submission().coverage[0]!,
                    testFiles: ["missing.test.ts"],
                },
            ],
        },
        {
            ...submission(),
            coverage: [
                { ...submission().coverage[0]!, checkNames: ["invented"] },
            ],
        },
    ]) {
        const workflow = await changedWorkflow();
        await workflow.finish(
            { execute: async () => bad },
            "create login",
            "done",
        );
        expect(workflow.snapshot().stage).toBe("blocked");
        expect(workflow.snapshot().runs).toHaveLength(0);
    }
});

test("repair stops after two rounds and new tasks receive a fresh budget", async () => {
    const execute = mock(async () => commandResult(1));
    const workflow = await changedWorkflow(execute);
    const debug = mock(async () => submission());
    await workflow.finish({ execute: debug }, "create login", "done");
    expect(debug).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(workflow.snapshot().repairRounds).toBe(2);
    expect(workflow.snapshot().stage).toBe("blocked");
    expect((await changedWorkflow()).snapshot().repairRounds).toBe(0);
});

test("existing failures remain separate and focused tests cannot remove baseline checks", async () => {
    const baseline = {
        ...check,
        name: "existing",
        args: ["test", "existing.test.ts"],
    };
    await configure([baseline]);
    const execute = mock(async (args) =>
        commandResult(args.args.includes("existing.test.ts") ? 1 : 0),
    );
    const workflow = await VerificationWorkflow.create(
        workspace,
        new ToolDispatcher(commandRegistry(execute)),
        {},
    );
    await workflow.beforeMutation();
    workflow.observe(edit, { success: true, changedFiles: ["login.ts"] });
    const debug = mock(async () => submission());
    await workflow.finish({ execute: debug }, "create login", "done");
    expect(
        workflow.snapshot().runs[0]?.map((result) => result.check.name),
    ).toEqual(["login", "existing"]);
    expect(workflow.snapshot().repairRounds).toBe(0);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(workflow.report()).toContain("failed at baseline");
});

test("incomplete checks prevent repair even when another test fails", async () => {
    for (const status of ["rejected", "timeout", "cancelled"]) {
        let calls = 0;
        const workflow = await changedWorkflow(async () =>
            calls++ === 0 ? commandResult(1) : { status, exitCode: null },
        );
        const debug = mock(async () => ({
            ...submission(),
            checks: [check, { ...check, name: "other" }],
        }));
        await workflow.finish({ execute: debug }, "create login", "done");
        expect(debug).toHaveBeenCalledTimes(1);
        expect(workflow.snapshot().stage).toBe("blocked");
    }
});

test("repair cannot silently replace commands or coverage", async () => {
    const workflow = await changedWorkflow(async () => commandResult(1));
    await workflow.finish(
        {
            execute: async (request) =>
                request.phase === "prepare"
                    ? submission()
                    : {
                          ...submission(),
                          checks: [{ ...check, args: ["--version"] }],
                      },
        },
        "create login",
        "done",
    );
    expect(workflow.snapshot().stage).toBe("blocked");
    expect(workflow.report()).toContain("changed selected checks");
    expect(workflow.snapshot().runs).toHaveLength(1);
});

test("test edits during repair need an explanation and then get fresh execution", async () => {
    for (const explained of [false, true]) {
        let calls = 0;
        const workflow = await changedWorkflow(async () =>
            commandResult(calls++ === 0 ? 1 : 0),
        );
        await workflow.finish(
            {
                execute: async (request) => {
                    if (request.phase === "repair")
                        await writeFile(
                            path.join(workspace.root, "login.test.ts"),
                            explained
                                ? "corrected fixture setup"
                                : "changed expectation",
                        );
                    return {
                        ...submission(),
                        testChangesReason:
                            request.phase === "repair" && explained
                                ? "The fixture omitted required setup; corrected fixture only."
                                : "",
                    };
                },
            },
            "create login",
            "done",
        );
        expect(workflow.snapshot().stage).toBe(
            explained ? "completed" : "blocked",
        );
        expect(calls).toBe(explained ? 2 : 1);
    }
});

test("source changes during or after checks invalidate their results", async () => {
    const during = await changedWorkflow(async () => {
        await writeFile(
            path.join(workspace.root, "login.ts"),
            "concurrent edit during tests",
        );
        return commandResult();
    });
    await during.finish(
        { execute: async () => submission() },
        "create login",
        "done",
    );
    expect(during.snapshot().runs[0]?.[0]?.status).toBe("invalidated");
    const after = await changedWorkflow();
    await after.finish(
        { execute: async () => submission() },
        "create login",
        "done",
    );
    await writeFile(
        path.join(workspace.root, "login.ts"),
        "user edit after tests",
    );
    await after.confirmCurrent();
    expect(after.snapshot().runs[0]?.[0]?.status).toBe("invalidated");
    expect(after.snapshot().stage).toBe("blocked");
});

test("unfinished background work, recovery conflicts, and denied edits stop debugging", async () => {
    for (const outcome of [
        { status: "running", id: "background" },
        { code: "RECOVERY_CONFLICT" },
        { status: "rejected" },
    ]) {
        const workflow = await changedWorkflow();
        workflow.observe(edit, outcome);
        const debug = mock(async () => submission());
        await workflow.finish({ execute: debug }, "create login", "done");
        expect(debug).not.toHaveBeenCalled();
        expect(workflow.snapshot().stage).toBe("blocked");
    }
});

test("cancellation preserves the in-flight outcome and stops later checks", async () => {
    const controller = new AbortController();
    const results: CheckResult[] = [];
    const execute = mock(async () => {
        controller.abort(new Error("cancel checks"));
        throw controller.signal.reason;
    });
    const runner = new VerificationRunner(
        workspace,
        new ToolDispatcher(commandRegistry(execute)),
        { signal: controller.signal },
    );
    await expect(
        runner.run([check, { ...check, name: "second" }], results),
    ).rejects.toThrow("cancel checks");
    expect(results[0]?.status).toBe("cancelled");
    expect(execute).toHaveBeenCalledTimes(1);
});

test("unknown command tools and unsupported snapshots are unavailable", async () => {
    const missing: CheckResult[] = [];
    await new VerificationRunner(
        workspace,
        new ToolDispatcher(new ToolRegistry()),
        {},
    ).run([check], missing);
    expect(missing[0]?.status).toBe("unavailable");
    await writeFile(
        path.join(workspace.root, "large.ts"),
        "x".repeat(2_000_001),
    );
    const execute = mock(async () => commandResult());
    const oversized: CheckResult[] = [];
    await new VerificationRunner(
        workspace,
        new ToolDispatcher(commandRegistry(execute)),
        {},
    ).run([check], oversized);
    expect(oversized[0]?.status).toBe("unavailable");
    expect(execute).not.toHaveBeenCalled();
});

test("missing host ripgrep reports the snapshot dependency before any command dispatch", async () => {
    const emptyPath = path.join(temporary, "empty-path");
    await mkdir(emptyPath);
    const moduleUrl = (filename: string) =>
        JSON.stringify(new URL(`../../src/${filename}`, import.meta.url).href);
    const script = `
        import { Workspace } from ${moduleUrl("tools/Workspace.ts")};
        import { ToolRegistry } from ${moduleUrl("tools/ToolRegistry.ts")};
        import { ToolDispatcher } from ${moduleUrl("tools/ToolDispatcher.ts")};
        import { VerificationRunner } from ${moduleUrl("verification/VerificationRunner.ts")};
        const dispatcher = new ToolDispatcher(new ToolRegistry());
        let calls = 0;
        dispatcher.execute = async () => { calls++; throw new Error("Must not execute"); };
        const results = [];
        await new VerificationRunner(new Workspace(process.cwd()), dispatcher, {}).run(${JSON.stringify([check])}, results);
        console.log(JSON.stringify({ result: results[0], calls }));
    `;
    // Isolate PATH in a child so other tests keep their normal discovery tools.
    const child = Bun.spawn([process.execPath, "-e", script], {
        cwd: workspace.root,
        env: { ...process.env, PATH: emptyPath, Path: emptyPath },
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    const observed = JSON.parse(stdout);
    expect(observed.calls).toBe(0);
    expect(observed.result.status).toBe("unavailable");
    expect(observed.result.detail).toContain("ripgrep");
});

test("documentation-only changes and conversation skip debugging, while explicit testing does not", async () => {
    const debug = mock(async () => submission());
    const docs = await VerificationWorkflow.create(
        workspace,
        new ToolDispatcher(commandRegistry(async () => commandResult())),
        {},
    );
    docs.observe(edit, { changedFiles: ["README.md"] });
    await docs.finish({ execute: debug }, "update documentation", "done");
    const chat = await VerificationWorkflow.create(
        workspace,
        new ToolDispatcher(commandRegistry(async () => commandResult())),
        {},
    );
    await chat.finish({ execute: debug }, "explain login", "explanation");
    expect(debug).not.toHaveBeenCalled();
    const testing = await VerificationWorkflow.create(
        workspace,
        new ToolDispatcher(commandRegistry(async () => commandResult())),
        {},
    );
    await testing.finish({ execute: debug }, "test login", "done");
    expect(debug).toHaveBeenCalledTimes(1);
});

test("debugging agent cannot execute commands directly and requires structured submission", async () => {
    const execute = mock(async () => commandResult());
    const calls: LLMResponse[] = [
        {
            role: "assistant",
            text: "",
            toolcalls: [
                {
                    id: "fixture-22150",
                    name: "execute_command",
                    params: { command: "bun", args: ["test"] },
                },
            ],
        },
        { role: "assistant", text: "all passed" },
        {
            role: "assistant",
            text: "",
            toolcalls: [{ id: "fixture-22444", name: "submit_debugging", params: submission() }],
        },
    ];
    const history: unknown[] = [];
    const llm: LLMProvider = {
        generate: async (messages, tools) => {
            expect(tools?.some((tool) => tool.name === "execute_command")).toBe(
                false,
            );
            history.push(structuredClone(messages));
            return calls.shift()!;
        },
    };
    const agent = new DebuggingAgent(llm, commandRegistry(execute), {
        context: {},
        onToolResult: async () => {},
        onMessage: async () => {},
    });
    const workflow = await changedWorkflow();
    expect(
        await agent.execute({
            phase: "prepare",
            userRequest: "create login",
            implementationSummary: "done",
            evidence: workflow.snapshot(),
        }),
    ).toEqual(submission());
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(history)).toContain("Tool unavailable");
});

test("debugging agent applies editing permissions", async () => {
    const registry = new ToolRegistry();
    const mutate = mock(async () => ({ success: true }));
    registry.registerTool({ ...edit, execute: mutate });
    const llm: LLMProvider = {
        generate: async () => ({
            role: "assistant",
            text: "",
            toolcalls: [{ id: "fixture-23790", name: "code_tool", params: {} }],
        }),
    };
    setPermissions(new PermissionService([{ effect: "edit", action: "deny" }]));
    const agent = new DebuggingAgent(llm, registry, {
        context: { editRecovery: new StaleEditRecovery() },
        onToolResult: async () => {},
        onMessage: async () => {},
    });
    const workflow = await changedWorkflow();
    await expect(
        agent.execute({
            phase: "prepare",
            userRequest: "create login",
            implementationSummary: "done",
            evidence: workflow.snapshot(),
        }),
    ).rejects.toThrow("permission");
    expect(mutate).not.toHaveBeenCalled();
});

test("agent writes a real test, repairs source, reruns Bun tests, persists evidence, and verifies afresh on resume", async () => {
    await rm(path.join(workspace.root, "login.test.ts"));
    await writeFile(
        path.join(workspace.root, "middleware.ts"),
        'import { allowsWrongPassword } from "./login"; export function authorize(request: Request) { return request.headers.get("password") === "correct" || allowsWrongPassword; }',
    );
    await writeFile(
        path.join(workspace.root, "routes.ts"),
        'import { authorize } from "./middleware"; export function handleRequest(request: Request) { return new Response("profile", { status: authorize(request) ? 200 : 401 }); }',
    );
    const editor = new SafeEditor(
        workspace,
        new CheckpointStore(workspace, path.join(temporary, "checkpoints")),
    );
    const processes = new ProcessManager();
    const events: string[] = [];
    const registry = commandRegistry(async (args) => {
        events.push("test");
        const running = await processes.start(
            [process.execPath, ...args.args],
            {
                cwd: workspace.root,
                timeoutMs: args.timeoutMs,
            },
        );
        return processes.wait(running);
    });
    for (const tool of repositoryTools(workspace)) registry.registerTool(tool);
    registry.registerTool(editor.tool());
    const call = (
        name: string,
        params: Record<string, unknown>,
    ): LLMResponse => ({
        role: "assistant",
        text: "",
        toolcalls: [{ id: "fixture-26026", name, params }],
    });
    const testCode =
        'import { test, expect } from "bun:test"; import { handleRequest } from "./routes"; test("wrong passwords are rejected", () => expect(handleRequest(new Request("https://fixture.test/profile", { headers: { password: "wrong" } })).status).toBe(401)); test("correct passwords work", () => expect(handleRequest(new Request("https://fixture.test/profile", { headers: { password: "correct" } })).status).toBe(200));';
    const responses: LLMResponse[] = [
        call("read_file", { path: "login.ts" }),
        { role: "assistant", text: '{"isGood":true}' },
        call("code_tool", {
            operation: "edit",
            path: "login.ts",
            changes: [
                { type: "replace", target: "true", content: "Boolean(1)" },
            ],
        }),
        { role: "assistant", text: '{"isGood":true}' },
        { role: "assistant", text: "Login feature is ready for checking." },
        call("read_file", { path: "login.ts" }),
        call("code_tool", {
            operation: "create",
            path: "login.test.ts",
            content: testCode,
        }),
        call("submit_debugging", submission()),
        call("read_file", { path: "login.ts" }),
        call("code_tool", {
            operation: "edit",
            path: "login.ts",
            changes: [
                { type: "replace", target: "Boolean(1)", content: "false" },
            ],
        }),
        call("submit_debugging", {
            ...submission(),
            findings: [
                {
                    explanation: "Wrong passwords were allowed.",
                    files: ["login.ts"],
                    evidence:
                        "The test failed and inspected source allowed wrong passwords.",
                    changes:
                        "Changed implementation to reject wrong passwords.",
                },
            ],
        }),
    ];
    const prompts: string[] = [];
    const llm: LLMProvider = {
        generate: async (messages, _tools, prompt) => {
            prompts.push(prompt ?? "");
            if (responses.length === 3) {
                expect(JSON.stringify(messages)).toContain("Expected: 401");
                expect(JSON.stringify(messages)).toContain("login.test.ts");
            }
            const response = responses.shift();
            if (!response) throw new Error("Unexpected model call");
            return response;
        },
    };
    const sessions = new SessionStore(
        workspace.root,
        path.join(temporary, "sessions"),
    );
    const agent = fixtureAgent(llm, registry);
    agent.enableSessions(sessions);
    try {
        const response = await agent.run(
            "Fix login so wrong passwords are rejected",
        );
        expect(response.text).toContain("login: passed");
        expect(response.text).toContain("1 of 2");
        expect(
            await readFile(path.join(workspace.root, "login.ts"), "utf8"),
        ).toContain("false");
        expect(
            await readFile(path.join(workspace.root, "login.test.ts"), "utf8"),
        ).toBe(testCode);
        expect(events).toEqual(["test", "test"]);
        const saved = (await sessions.list())[0]!;
        expect(saved.verification?.runs.map((run) => run[0]?.status)).toEqual([
            "failed",
            "passed",
        ]);
        expect(saved.verification?.debuggingMessages?.length).toBeGreaterThan(
            0,
        );
        expect(
            prompts.some((prompt) => prompt.includes("debugging agent")),
        ).toBe(true);
        await agent.closeSession();
        const resumedResponses: LLMResponse[] = [
            { role: "assistant", text: "Check current login" },
            call("read_file", { path: "login.test.ts" }),
            call("submit_debugging", submission()),
        ];
        const resumed = fixtureAgent(
            { generate: async () => resumedResponses.shift()! },
            registry,
        );
        resumed.enableSessions(sessions);
        await resumed.resumeSession(saved.id);
        try {
            const fresh = await resumed.run("check current state");
            expect(fresh.text).toContain("login: passed");
            expect(events).toHaveLength(3);
            expect(
                (await sessions.load(saved.id)).verification?.repairRounds,
            ).toBe(0);
        } finally {
            await resumed.closeSession();
        }
    } finally {
        await agent.closeSession();
    }
});

test("agent does not start debugging or tests in plan mode", async () => {
    const execute = mock(async () => commandResult());
    const generate = mock(async () => ({
        role: "assistant" as const,
        text: "Read and plan the authentication change.",
    }));
    const result = await fixtureAgent(
        { generate },
        commandRegistry(execute),
    ).run("create login", "plan");
    expect(result.text).not.toContain("Verification (recorded results)");
    expect(execute).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
});

test("old verification session records remain readable", () => {
    expect(
        verificationEvidenceSchema.parse({
            source: "old",
            notices: [],
            baseline: [],
            runs: [],
            changedFiles: [],
            repairRounds: 0,
            pendingProcesses: [],
            dirty: false,
        }).stage,
    ).toBeUndefined();
});

test("debugging submission is representable in the provider's tool JSON schema", () => {
    const schema = z.toJSONSchema(debuggingSubmissionSchema);
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("coverage");
    expect(schema.properties).toHaveProperty("checks");
});

test("the shared command budget stops scheduling checks after ten minutes", async () => {
    let now = 1_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const execute = mock(async () => {
        now += 600_001;
        return commandResult();
    });
    try {
        const runner = new VerificationRunner(
            workspace,
            new ToolDispatcher(commandRegistry(execute)),
            {},
        );
        const results: CheckResult[] = [];
        await runner.run([check, { ...check, name: "second" }], results);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(results[1]?.status).toBe("unavailable");
        expect(results[1]?.detail).toContain("budget");
    } finally {
        clock.mockRestore();
    }
});

test("debugging model cancellation is forwarded and shared recovery context reaches edits", async () => {
    const controller = new AbortController();
    const recovery = new StaleEditRecovery();
    const registry = new ToolRegistry();
    registry.registerTool({
        ...edit,
        execute: async (_args, context) => {
            expect(context?.signal).toBe(controller.signal);
            expect(context?.editRecovery).toBe(recovery);
            return { success: true };
        },
    });
    let calls = 0;
    const llm: LLMProvider = {
        generate: async (_messages, _tools, _prompt, _memory, callbacks) => {
            expect(callbacks?.signal).toBe(controller.signal);
            if (calls++ === 0)
                return {
                    role: "assistant",
                    text: "",
                    toolcalls: [{ id: "fixture-33473", name: "code_tool", params: {} }],
                };
            controller.abort(new Error("cancel debugging"));
            throw controller.signal.reason;
        },
    };
    const beforeEdit = mock(async () => {});
    const agent = new DebuggingAgent(llm, registry, {
        context: { signal: controller.signal, editRecovery: recovery },
        beforeEdit,
        onToolResult: async () => {},
        onMessage: async () => {},
    });
    await expect(
        agent.execute({
            phase: "prepare",
            userRequest: "fix login",
            implementationSummary: "done",
            evidence: (await changedWorkflow()).snapshot(),
        }),
    ).rejects.toThrow("cancel debugging");
    expect(beforeEdit).toHaveBeenCalledTimes(1);
});

test("model claims cannot replace test execution and debugging steps are bounded", async () => {
    const generate = mock(async () => ({
        role: "assistant" as const,
        text: "Everything passed perfectly",
    }));
    const debugging = new DebuggingAgent(
        { generate },
        new ToolRegistry(),
        {
            context: {},
            onToolResult: async () => {},
            onMessage: async () => {},
        },
        2,
    );
    const workflow = await changedWorkflow();
    await workflow.finish(debugging, "create login", "done");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(workflow.snapshot().stage).toBe("blocked");
    expect(workflow.snapshot().runs).toHaveLength(0);
});

test("final reporting invalidates a pass when user code changes during output validation", async () => {
    const answers: LLMResponse[] = [
        { role: "assistant", text: "Everything is fixed" },
        {
            role: "assistant",
            text: "",
            toolcalls: [{ id: "fixture-35268", name: "submit_debugging", params: submission() }],
        },
    ];
    const agent = fixtureAgent(
        { generate: async () => answers.shift()! },
        commandRegistry(async () => commandResult()),
    );
    Object.assign(agent, {
        outputGuardrails: {
            outputValidation: async () => {
                await writeFile(
                    path.join(workspace.root, "login.ts"),
                    "user change after check",
                );
                return { isSafe: true };
            },
        },
    });
    const result = await agent.run("test login");
    expect(result.text).toContain("invalidated");
    expect(result.text).toContain("could not be fully verified");
    expect(result.text).not.toContain("Everything is fixed");
});
