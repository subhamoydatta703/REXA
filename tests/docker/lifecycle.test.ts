import { test, expect, beforeAll, afterAll } from "bun:test";
import { chmod, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ExecutionManager } from "../../src/tools/ExecutionManager";
import { executionTools } from "../../src/tools/executeTools";
import { Workspace } from "../../src/tools/Workspace";
import { CheckpointStore } from "../../src/tools/CheckpointStore";
import { ToolRegistry } from "../../src/tools/ToolRegistry";
import { ToolDispatcher } from "../../src/tools/ToolDispatcher";
import { PermissionService } from "../../src/tools/PermissionService";
import { VerificationRunner } from "../../src/verification/VerificationRunner";
import type { CheckResult } from "../../src/verification/VerificationResults";

let root: string, manager: ExecutionManager;
beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "rexa-docker-"));
    // Linux mkdtemp creates mode 0700. The container's UID 1000 may differ
    // from the CI runner's UID, so allow it to traverse this test-only fixture.
    await chmod(root, 0o755);
    await mkdir(path.join(root, "packages"));
    await writeFile(
        path.join(root, "packages", "fixture.txt"),
        "mounted workspace",
    );
    manager = new ExecutionManager(root);
    await manager.ensureSandbox();
}, 360_000);
afterAll(async () => {
    await manager?.stop();
    if (root) await rm(root, { recursive: true, force: true });
}, 60_000);

test("real container command uses project subdirectories and bounded streamed output", async () => {
    const chunks: string[] = [];
    const result = await manager.execute(
        {
            command: "python3",
            args: ["-u", "-c", "print(open('fixture.txt').read())"],
            workdir: "/app/packages",
        },
        { onOutput: (text) => chunks.push(text) },
    );
    expect(result.success).toBe(true);
    expect(chunks.join("")).toContain("mounted workspace");
}, 30_000);

test("supervisor preserves nonzero and signal exit codes", async () => {
    const failed = await manager.execute({
        command: "python3",
        args: ["-c", "import sys; sys.exit(7)"],
    });
    expect(failed.exitCode).toBe(7);
    expect(failed.success).toBe(false);
    const signalled = await manager.execute({
        command: "python3",
        args: ["-c", "import os,signal; os.kill(os.getpid(),signal.SIGTERM)"],
    });
    expect(signalled.exitCode).toBe(143);
}, 30_000);

test("supervisor cleans up children after their parent exits normally", async () => {
    const result = await manager.execute({
        command: "python3",
        args: [
            "-c",
            "import subprocess; child=subprocess.Popen(['sleep','60']); open('/workspace/orphan-child.pid','w').write(str(child.pid))",
        ],
    });
    expect(result.success).toBe(true);
    const probe = await manager.execute({
        command: "python3",
        args: [
            "-c",
            "import os; pid=open('/workspace/orphan-child.pid').read(); p='/proc/'+pid+'/stat'; print('dead' if not os.path.exists(p) or open(p).read().split()[2]=='Z' else 'alive')",
        ],
    });
    expect(probe.stdout).toContain("dead");
}, 30_000);

test("supervisor honors cancellation recorded before command startup", async () => {
    const identifier = randomUUID();
    const supervisor = "/opt/rexa/sandbox-supervisor.ts";
    const stopped = await manager.execute({
        command: "bun",
        args: [supervisor, "stop", identifier],
    });
    expect(stopped.success).toBe(true);
    const result = await manager.execute({
        command: "bun",
        args: [
            supervisor,
            "run",
            identifier,
            "10",
            "/app",
            "echo",
            "must not run",
        ],
    });
    expect(result.exitCode).toBe(130);
    expect(result.stdout).not.toContain("must not run");
}, 30_000);

test("supervisor rejects escaped real paths and reports command startup failures", async () => {
    const result = await manager.execute({
        command: "bun",
        args: [
            "/opt/rexa/sandbox-supervisor.ts",
            "run",
            randomUUID(),
            "10",
            "/app/../tmp",
            "echo",
            "must not run",
        ],
    });
    expect(result.success).toBe(false);
    expect(result.stderr).toContain(
        "Working directory escapes sandbox workspace",
    );
    const missing = await manager.execute({
        command: "rexa-command-that-does-not-exist",
    });
    expect(missing.success).toBe(false);
    expect(missing.stderr).toContain("rexa-command-that-does-not-exist");
}, 30_000);

test("container timeout terminates child processes, not just docker client", async () => {
    const script =
        "import subprocess,time; child=subprocess.Popen(['python3','-c','import time; time.sleep(60)']); open('/workspace/timeout-child.pid','w').write(str(child.pid)); print('spawned',flush=True); time.sleep(60)";
    const result = await manager.execute({
        command: "python3",
        args: ["-u", "-c", script],
        workdir: "/workspace",
        timeoutMs: 1000,
    });
    expect(result.status).toBe("timeout");
    const probe = await manager.execute({
        command: "python3",
        args: [
            "-c",
            "import os; pid=open('/workspace/timeout-child.pid').read(); p='/proc/'+pid+'/stat'; print('dead' if not os.path.exists(p) or open(p).read().split()[2]=='Z' else 'alive')",
        ],
        workdir: "/workspace",
    });
    expect(probe.stdout).toContain("dead");
}, 30_000);

test("explicit cancellation terminates a running container process group", async () => {
    const cancellation = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
        ready = resolve;
    });
    const script =
        "import subprocess,time; child=subprocess.Popen(['python3','-c','import time; time.sleep(60)']); open('/workspace/cancel-child.pid','w').write(str(child.pid)); print('ready',flush=True); time.sleep(60)";
    const id = await manager.start(
        {
            command: "python3",
            args: ["-u", "-c", script],
            workdir: "/workspace",
        },
        {
            signal: cancellation.signal,
            onOutput: (text) => {
                if (text.includes("ready")) ready();
            },
        },
    );
    await started;
    cancellation.abort();
    expect((await manager.processes.wait(id.id)).status).toBe("cancelled");
    const probe = await manager.execute({
        command: "python3",
        args: [
            "-c",
            "import os; pid=open('/workspace/cancel-child.pid').read(); p='/proc/'+pid+'/stat'; print('dead' if not os.path.exists(p) or open(p).read().split()[2]=='Z' else 'alive')",
        ],
        workdir: "/workspace",
    });
    expect(probe.stdout).toContain("dead");
}, 30_000);

test("background stdin can be written and processes can be stopped", async () => {
    const started = await manager.start({
        command: "python3",
        args: ["-u", "-c", "print(input())"],
        workdir: "/workspace",
    });
    await manager.processes.write(started.id, "hello\n");
    expect((await manager.processes.wait(started.id)).stdout).toContain(
        "hello",
    );
    const server = await manager.start({
        command: "python3",
        args: ["-u", "-m", "http.server", "8765"],
        workdir: "/workspace",
    });
    expect(manager.processes.poll(server.id).status).toBe("running");
    expect((await manager.processes.stop(server.id)).status).toBe("cancelled");
}, 30_000);

test("verification checks use Docker commands and report real pass/fail exit codes", async () => {
    const workspace = new Workspace(root);
    const checkpoints = new CheckpointStore(
        workspace,
        path.join(root, ".rexa", "verification-checkpoints"),
    );
    const registry = new ToolRegistry();
    for (const tool of executionTools(manager, checkpoints)) {
        registry.registerTool(tool);
    }
    const dispatcher = new ToolDispatcher(
        registry,
        new PermissionService([{ effect: "command", action: "allow" }]),
    );
    const runner = new VerificationRunner(workspace, dispatcher, {});
    const checks = [
        {
            name: "workspace fixture",
            command: "python3",
            args: [
                "-c",
                "import pathlib,sys; sys.exit(0 if pathlib.Path('packages/fixture.txt').read_text() == 'mounted workspace' else 1)",
            ],
            directory: ".",
            timeoutMs: 10_000,
        },
    ];
    const before: CheckResult[] = [];
    await runner.run(checks, before);
    expect(before[0]?.status).toBe("passed");
    try {
        await writeFile(
            path.join(root, "packages", "fixture.txt"),
            "incorrect value",
        );
        const after: CheckResult[] = [];
        await runner.run(checks, after);
        expect(after[0]?.status).toBe("failed");
        expect(after[0]?.exitCode).toBe(1);
    } finally {
        await writeFile(
            path.join(root, "packages", "fixture.txt"),
            "mounted workspace",
        );
    }
}, 30_000);
