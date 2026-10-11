/** Container-side process-group ownership, timeout, and cancellation. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

function recordPath(identifier: string): string {
    if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            identifier,
        )
    ) {
        throw new Error("Process identifier must be a UUID.");
    }
    return `/tmp/rexa-process-${identifier}.json`;
}

function signalGroup(group: number, signal: NodeJS.Signals): boolean {
    try {
        // On Linux, a negative PID addresses the entire process group.
        process.kill(-group, signal);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            return false;
        }
        throw error;
    }
}

async function terminateGroup(group: number): Promise<void> {
    if (!Number.isSafeInteger(group) || group <= 1) {
        throw new Error("Invalid process group.");
    }
    if (signalGroup(group, "SIGTERM")) {
        await delay(200);
        signalGroup(group, "SIGKILL");
    }
}

async function removeIfPresent(filename: string): Promise<void> {
    try {
        await unlink(filename);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }
}

async function stop(filename: string): Promise<void> {
    // Remember cancellation even when the run process has not started yet.
    await writeFile(`${filename}.cancel`, "cancel", { mode: 0o600 });
    try {
        const record = JSON.parse(await readFile(filename, "utf8"));
        await terminateGroup(record.group);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }
}

async function run(filename: string, args: string[]): Promise<number> {
    const [timeoutText, directory, command, ...commandArgs] = args;
    const timeoutSeconds = Number(timeoutText);
    if (
        !directory ||
        !command ||
        !Number.isFinite(timeoutSeconds) ||
        timeoutSeconds <= 0
    ) {
        throw new Error(
            "Expected a positive timeout, working directory, and command.",
        );
    }
    const workingDirectory = await realpath(directory);
    if (
        !["/app", "/workspace"].some(
            (root) =>
                workingDirectory === root ||
                workingDirectory.startsWith(`${root}/`),
        )
    ) {
        throw new Error("Working directory escapes sandbox workspace.");
    }
    if (existsSync(`${filename}.cancel`)) {
        return 130;
    }

    const child = spawn(command, commandArgs, {
        cwd: workingDirectory,
        detached: true, // Linux creates a new session and process group.
        stdio: "inherit",
    });
    await once(child, "spawn");
    const group = child.pid!;
    const exited = once(child, "exit").then(
        ([code, signal]) =>
            code ?? 128 + constants.signals[signal as NodeJS.Signals],
    );
    let cancel!: () => void;
    const cancelled = new Promise<number>((resolve) => {
        cancel = () => resolve(130);
    });
    process.on("SIGTERM", cancel);
    process.on("SIGINT", cancel);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let recorded = false;
    try {
        await writeFile(filename, JSON.stringify({ group }), {
            flag: "wx",
            mode: 0o600,
        });
        recorded = true;
        if (existsSync(`${filename}.cancel`)) {
            return 130;
        }
        const timedOut = new Promise<number>((resolve) => {
            timeout = setTimeout(() => resolve(124), timeoutSeconds * 1000);
        });
        return await Promise.race([exited, cancelled, timedOut]);
    } finally {
        clearTimeout(timeout);
        try {
            // Clean up descendants even if their parent has already exited.
            await terminateGroup(group);
            await exited;
        } finally {
            process.off("SIGTERM", cancel);
            process.off("SIGINT", cancel);
            if (recorded) {
                await removeIfPresent(filename);
                await removeIfPresent(`${filename}.cancel`);
            }
        }
    }
}

async function main(): Promise<number> {
    const [action, identifier, ...args] = process.argv.slice(2);
    if (!identifier || (action !== "run" && action !== "stop")) {
        throw new Error(
            "Usage: sandbox-supervisor.ts run|stop <UUID> [timeout directory command ...args]",
        );
    }
    const filename = recordPath(identifier);
    if (action === "stop") {
        await stop(filename);
        return 0;
    }
    return run(filename, args);
}

try {
    process.exitCode = await main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
