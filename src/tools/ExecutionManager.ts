import { z } from "zod";
import {logger } from "../logger/AgentLogger"
const executeCommandInputSchema = z.object({
    command: z
        .string()
        .describe(
            "The actual executable name only, such as git, bun, node, npm, npx, tsc, or python. " +
            "Do not use shell built-ins or aliases such as ls, cat, dir, type, cd, echo, mkdir, find, cmd, grep, pwd."
        ),
    args: z
        .array(z.string())
        .describe("Arguments for the executable. Each argument must be a separate string.")
        .default([]),
    timeoutMs: z
        .number()
        .int()
        .positive()
        .max(300_000) // hard cap: commands may not run for more than 5 minutes
        .optional()
        .describe("Optional hard execution timeout in milliseconds (default 60_000)."),
});

type ExecuteCommandInput = z.infer<typeof executeCommandInputSchema>;

export interface ExecutionResult {
    success: boolean;
    status: "executed" | "timeout" | "failed";
    command: string;
    args: string[];
    exitCode: number | null;
    stdout: string;
    stderr: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const SERVICE_NAME = "sandbox";

/**
 * Owns the Docker sandbox lifecycle and the structured execution of commands
 * inside it.
 *
 * Lifecycle model:
 * - A single sandbox survives for the duration of one agent task/session and is
 *   shared across every execute_command call in that task.
 * - `ensureSandbox()` checks the *real* Docker Compose state instead of trusting
 *   an in-memory boolean, and only starts the stack when it is not actually up.
 * - `stop()` tears the sandbox down and must be called exactly once when the
 *   task finishes, fails, is cancelled, or times out.
 */
export class ExecutionManager {
    /** True once this session has brought the stack up; drives stop() cleanup. */
    private startedThisSession = false;
    /** Smallest allowed unit of work: a single command run inside the sandbox. */
    async execute(input: ExecuteCommandInput): Promise<ExecutionResult> {
        const parsed = executeCommandInputSchema.parse(input);
        const timeoutMs = parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS;

        // Guardrail (blocked/safe/confirmation) happens in executeTools before
        // this method is reached. Here we only guarantee the sandbox is up.
        await this.ensureSandbox();

        logger.info(`[Docker Exec] Running: ${parsed.command} ${parsed.args.join(" ")}`);
        const dockerArgs = [
            "compose",
            "exec",
            "-T",
            SERVICE_NAME,
            parsed.command,
            ...parsed.args,
        ];

        const proc = Bun.spawn(["docker", ...dockerArgs], {
            stdout: "pipe",
            stderr: "pipe",
        });

        // Capture stdout/stderr as they stream in.
        const fullStdout = new Promise<string>((resolve) => {
            new Response(proc.stdout).text().then(resolve).catch(() => resolve(""));
        });
        const fullStderr = new Promise<string>((resolve) => {
            new Response(proc.stderr).text().then(resolve).catch(() => resolve(""));
        });

        // Hard execution timeout. A cancellable timer races the process: on
        // timeout we kill the process (so a runaway command cannot linger) and
        // resolve a sentinel; on early exit the timer is cleared so the caller
        // is never made to wait the remaining duration.
        let timedOut = false;
        let timerId: ReturnType<typeof setTimeout> | undefined;
        const timeoutSignal = new Promise<void>((resolve) => {
            timerId = setTimeout(() => {
                timedOut = true;
                try {
                    proc.kill();
                } catch {
                    // Already exited; nothing to do.
                }
                resolve();
            }, timeoutMs);
        });

        const exitCode = await Promise.race([proc.exited, timeoutSignal]).finally(
            async () => {
                if (timerId) {
                    clearTimeout(timerId);
                }
                // If the timeout won, the process was killed — still await its
                // real exit so we don't report before the kill settles.
                try {
                    await proc.exited;
                } catch {
                    // Best-effort; ignore.
                }
            },
        );

        const stdout = await fullStdout;
        const stderr = await fullStderr;

        if (timedOut) {
            return {
                success: false,
                status: "timeout" as const,
                command: parsed.command,
                args: parsed.args,
                exitCode: typeof exitCode === "number" ? exitCode : null,
                stdout,
                stderr:
                    stderr ||
                    `Command timed out after ${timeoutMs}ms and was killed. ` +
                        "The sandbox is still intact and ready for the next command.",
            };
        }

        return {
            success: exitCode === 0,
            status: "executed" as const,
            command: parsed.command,
            args: parsed.args,
            exitCode: typeof exitCode === "number" ? exitCode : 1,
            stdout,
            stderr,
        };
}

    /**
     * Ensure the sandbox service is up, inspecting the actual Docker Compose
     * state. Does nothing (and returns quickly) when it is already running, so
     * multiple execute_command calls in one task reuse the same container.
     */
    async ensureSandbox(): Promise<void> {
        // Check real state: list the container(s) for the service.
        const ps = Bun.spawn(["docker", "compose", "ps", "-q", SERVICE_NAME], {
            stdout: "pipe",
            stderr: "pipe",
        });
        const psOut = await new Response(ps.stdout).text();
        const psErr = await new Response(ps.stderr).text();
        await ps.exited;

        if (psErr.includes("no configuration file") || psErr.includes("no such file")) {
            throw new Error(
                "Docker Compose sandbox configuration is missing/unreadable. " +
                    `Cannot run "${SERVICE_NAME}". Check docker-compose.yaml exists next to the project.`,
            );
        }

        const containerId = psOut.trim().split(/\s+/)[0];
        if (containerId) {
            // Confirm the found container is actually in a running state.
            const inspect = Bun.spawn(
                ["docker", "inspect", "-f", "{{.State.Running}}", containerId],
                { stdout: "pipe", stderr: "pipe" },
            );
            const running = (await new Response(inspect.stdout).text()).trim() === "true";
            await inspect.exited;
            if (running) {
                return;
            }
        }

        // Not up (or not running): build (if needed) and start it.
        const up = Bun.spawn(["docker", "compose", "up", "-d", "--build", SERVICE_NAME], {
            stdout: "pipe",
            stderr: "pipe",
        });
        const upOut = await new Response(up.stdout).text();
        const upErr = await new Response(up.stderr).text();
        const upExit = await up.exited;

        if (upExit !== 0) {
            throw new Error(
                `Failed to start sandbox service (exit ${upExit}).\nstdout: ${upOut}\nstderr: ${upErr}`,
            );
        }
          logger.info("[Docker Sandbox] Container started successfully");
        this.startedThisSession = true;
    }

    /**
     * Stop and remove the sandbox stack — but only if this session actually
     * brought it up. Safe to call multiple times; missing / already-stopped
     * stacks, or pre-existing stacks not created here, are left untouched.
     */
    async stop(): Promise<void> {
        if (!this.startedThisSession) {
            return;
        }
        this.startedThisSession = false;
        const down = Bun.spawn(["docker", "compose", "down", "--remove-orphans"], {
            stdout: "pipe",
            stderr: "pipe",
        });
        await new Response(down.stdout).text();
        await new Response(down.stderr).text();
        await down.exited;
    }
}

/** Shared singleton used by the execute_command tool and the Agent lifecycle. */
export const sandboxManager = new ExecutionManager();