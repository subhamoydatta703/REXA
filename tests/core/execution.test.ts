import { test, expect, mock } from "bun:test";
import { z } from "zod";
import { ProcessManager } from "../../src/tools/ProcessManager";
import { PermissionService } from "../../src/tools/PermissionService";
import { ToolDispatcher } from "../../src/tools/ToolDispatcher";
import { ToolRegistry } from "../../src/tools/ToolRegistry";
import type { ToolExecutionContext } from "../../src/tools/ToolRegistry";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { executionTools } from "../../src/tools/executeTools";
import { CheckpointStore } from "../../src/tools/CheckpointStore";
import { Workspace } from "../../src/tools/Workspace";
import type { ExecutionInput } from "../../src/tools/ExecutionManager";
import {
    workdirSchema,
    ExecutionManager,
} from "../../src/tools/ExecutionManager";

test("denial blocks dispatch; exact grants do not approve changed arguments or workdir", async () => {
    const execute = mock(async () => ({ success: true }));
    const ask = mock(async () => "session" as const);
    const tool = {
        name: "execute_command",
        effect: "command" as const,
        description: "fixture",
        parameters: z.object({
            command: z.string(),
            args: z.array(z.string()),
            workdir: z.string(),
        }),
        execute,
    };
    const registry = new ToolRegistry();
    registry.registerTool(tool);
    const deny = new ToolDispatcher(
        registry,
        new PermissionService(
            [{ tool: "execute_command", action: "deny" }],
            ask,
        ),
    );
    expect(
        (
            await deny.execute(
                tool.name,
                { command: "bun", args: ["test"], workdir: "/app" },
                "act",
            )
        ).status,
    ).toBe("rejected");
    expect(execute).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    const dispatcher = new ToolDispatcher(
        registry,
        new PermissionService([], ask),
    );
    const params = { command: "bun", args: ["test"], workdir: "/app" };
    await dispatcher.execute(tool.name, params, "act");
    await dispatcher.execute(tool.name, params, "act");
    expect(ask).toHaveBeenCalledTimes(1);
    await dispatcher.execute(
        tool.name,
        { ...params, args: ["run", "other"] },
        "act",
    );
    await dispatcher.execute(
        tool.name,
        { ...params, workdir: "/app/sub" },
        "act",
    );
    expect(ask).toHaveBeenCalledTimes(3);
    expect((await dispatcher.execute(tool.name, params, "plan")).status).toBe(
        "blocked",
    );
});
test("batch path permissions require every edited path to match", async () => {
    const permissions = new PermissionService(
        [{ tool: "code_tool", path: "src/**", action: "allow" }],
        async () => "deny",
    );
    const tool = {
        name: "code_tool",
        effect: "edit" as const,
        description: "fixture",
        parameters: z.object({}),
        execute: async () => ({}),
    };
    expect(
        await permissions.authorize(tool, {
            operations: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
        }),
    ).toBe(true);
    expect(
        await permissions.authorize(tool, {
            operations: [{ path: "src/a.ts" }, { path: "outside.ts" }],
        }),
    ).toBe(false);
});
test("process output streams before completion, is bounded, and redacts split credentials", async () => {
    const manager = new ProcessManager(100);
    const previous = process.env.REXA_FIXTURE_API_KEY;
    process.env.REXA_FIXTURE_API_KEY = "fixture-credential-value";
    try {
        let ready!: () => void;
        const emitted = new Promise<void>((resolve) => {
            ready = resolve;
        });
        const output: string[] = [];
        const id = await manager.start(
            [
                process.execPath,
                "-e",
                "process.stdout.write('fixture-credential-'); setTimeout(()=>process.stdout.write('value\\n'), 50); setTimeout(()=>console.log('ready'),100); setTimeout(()=>console.log('x'.repeat(300)),250);",
            ],
            {
                cwd: process.cwd(),
                onOutput: (text) => {
                    output.push(text);
                    if (text.includes("ready")) ready();
                },
            },
        );
        await emitted;
        expect(manager.poll(id).status).toBe("running");
        const result = await manager.wait(id);
        expect(result.success).toBe(true);
        expect(result.stdout.length).toBeLessThanOrEqual(100);
        expect(result.truncated).toBe(true);
        expect(output.join("")).not.toContain("fixture-credential-value");
        expect(output.join("")).toContain("[REDACTED]");
    } finally {
        await manager.stopAll();
        if (previous === undefined) delete process.env.REXA_FIXTURE_API_KEY;
        else process.env.REXA_FIXTURE_API_KEY = previous;
    }
});
test("background stdin, cancellation, and timeout produce explicit process states", async () => {
    const manager = new ProcessManager();
    const id = await manager.start(
        [
            process.execPath,
            "-e",
            "process.stdin.on('data', d => { console.log(d.toString().trim()); process.exit(0); });",
        ],
        { cwd: process.cwd(), timeoutMs: 2000 },
    );
    await manager.write(id, "input\n");
    expect((await manager.wait(id)).stdout).toContain("input");
    const cancelled = new AbortController();
    const stop = mock(async () => {});
    const active = await manager.start(
        [process.execPath, "-e", "setInterval(()=>{},1000)"],
        { cwd: process.cwd(), signal: cancelled.signal, terminate: stop },
    );
    cancelled.abort();
    expect((await manager.wait(active)).status).toBe("cancelled");
    expect(stop).toHaveBeenCalledTimes(1);
    const timed = await manager.start(
        [process.execPath, "-e", "setInterval(()=>{},1000)"],
        { cwd: process.cwd(), timeoutMs: 100 },
    );
    expect((await manager.wait(timed)).status).toBe("timeout");
    await manager.stopAll();
});
test("workdir boundary validation and sandbox ownership", () => {
    expect(workdirSchema.parse("/app/packages/api")).toBe("/app/packages/api");
    for (const dir of [
        "/app/../etc",
        "/etc",
        "/workspace/../../app",
        "C:\\temp",
        "/app\\escape",
    ])
        expect(workdirSchema.safeParse(dir).success).toBe(false);
    expect(new ExecutionManager().composeProjectName).not.toBe(
        new ExecutionManager().composeProjectName,
    );
});

test("command tools preserve foreground and background checkpoint results", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rexa-command-refactor-"));
    const checkpoints = new CheckpointStore(
        new Workspace(root),
        path.join(root, ".rexa", "checkpoints"),
    );
    // Exercise the real process and checkpoint code without needing Docker for this fixture.
    class LocalExecutionManager extends ExecutionManager {
        override async start(
            input: ExecutionInput,
            context: ToolExecutionContext = {},
        ) {
            const parsed = {
                command: input.command,
                args: input.args ?? [],
                timeoutMs: input.timeoutMs ?? 60_000,
                workdir: input.workdir ?? "/app",
            };
            const id = await this.processes.start(
                [process.execPath, ...parsed.args],
                {
                    cwd: root,
                    timeoutMs: parsed.timeoutMs,
                    signal: context.signal,
                    onOutput: context.onOutput,
                },
            );
            return { id, ...parsed };
        }
    }
    const manager = new LocalExecutionManager(root);
    const tools = executionTools(manager, checkpoints);
    const execute = tools.find((tool) => tool.name === "execute_command")!;
    const poll = tools.find((tool) => tool.name === "poll_process")!;
    try {
        await writeFile(path.join(root, "fixture.txt"), "before");
        const foreground = await execute.execute(
            {
                command: "bun",
                args: [
                    "-e",
                    "require('node:fs').writeFileSync('fixture.txt', 'foreground'); console.log('done');",
                ],
            },
            { approved: true },
        );
        expect(foreground.success).toBe(true);
        expect(foreground.stdout).toContain("done");
        expect(foreground.changedFiles).toEqual(["fixture.txt"]);
        await checkpoints.undo(foreground.checkpoint);
        expect(await readFile(path.join(root, "fixture.txt"), "utf8")).toBe(
            "before",
        );

        const background = await execute.execute(
            {
                command: "bun",
                args: [
                    "-e",
                    "require('node:fs').writeFileSync('fixture.txt', 'background');",
                ],
                background: true,
            },
            { approved: true },
        );
        expect(background.status).toBe("running");
        await manager.processes.wait(background.id);
        const completed = await poll.execute({ id: background.id });
        expect(completed.success).toBe(true);
        expect(completed.checkpoint).toBe(background.checkpoint);
        expect(completed.changedFiles).toEqual(["fixture.txt"]);
        await checkpoints.undo(completed.checkpoint);
        expect(await readFile(path.join(root, "fixture.txt"), "utf8")).toBe(
            "before",
        );
    } finally {
        await manager.processes.stopAll();
        await rm(root, { recursive: true, force: true });
    }
});
