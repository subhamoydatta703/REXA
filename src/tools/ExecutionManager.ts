import { z } from "zod";
import {logger } from "../logger/AgentLogger"
import path from "node:path";
import crypto from "node:crypto";
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
        .max(300_000) 
        .optional()
        .describe("Optional hard execution timeout in milliseconds (default 60_000)."),
    workdir: z
        .enum(["/app", "/workspace"])
        .default("/app")
        .describe("Sandbox-only working directory. Use /workspace for cloned repositories."),
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
    workdir: "/app" | "/workspace";
}

const DEFAULT_TIMEOUT_MS = 60_000;
const SERVICE_NAME = "sandbox";
const REXA_ROOT = path.resolve(import.meta.dir, "../..");
const COMPOSE_FILE = path.join(REXA_ROOT, "docker-compose.yaml");


export class ExecutionManager {
    private readonly targetWorkspace = path.resolve(process.cwd());
    private readonly composeProjectName = `rexa_${crypto
        .createHash("sha256")
        .update(this.targetWorkspace)
        .digest("hex")
        .slice(0, 12)}`;
    private startedThisSession = false;

    private get composeArgs(): string[] {
        return ["compose", "--project-name", this.composeProjectName, "--file", COMPOSE_FILE];
    }

    private get dockerEnv(): Record<string, string> {
        return {
            ...Object.fromEntries(
                Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
            ),
            REXA_WORKSPACE: this.targetWorkspace,
        };
    }
    
    async execute(input: ExecuteCommandInput): Promise<ExecutionResult> {
        const parsed = executeCommandInputSchema.parse(input);
        const timeoutMs = parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS;

        // Guardrail (blocked/safe/confirmation) happens in executeTools before
        // this method is reached. Here we only guarantee the sandbox is up.
        await this.ensureSandbox();

        logger.info(`Docker exec: ${parsed.command} ${parsed.args.join(" ")}`);
        const dockerArgs = [
            ...this.composeArgs,
            "exec",
            "-T",
            "-w",
            parsed.workdir,
            SERVICE_NAME,
            parsed.command,
            ...parsed.args,
        ];

        const proc = Bun.spawn(["docker", ...dockerArgs], {
            stdout: "pipe",
            stderr: "pipe",
            cwd: REXA_ROOT,
            env: this.dockerEnv,
        });

        // Capture stdout/stderr as they stream in.
        const fullStdout = new Promise<string>((resolve) => {
            new Response(proc.stdout).text().then(resolve).catch(() => resolve(""));
        });
        const fullStderr = new Promise<string>((resolve) => {
            new Response(proc.stderr).text().then(resolve).catch(() => resolve(""));
        });

        // Hard execution timeout
        let timedOut = false;
        let timerId: ReturnType<typeof setTimeout> | undefined;
        const timeoutSignal = new Promise<void>((resolve) => {
            timerId = setTimeout(() => {
                timedOut = true;
                try {
                    proc.kill();
                } catch {
                    
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
                workdir: parsed.workdir,
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
            workdir: parsed.workdir,
        };
}

    
    //   Ensure the sandbox service is up
    async ensureSandbox(): Promise<void> {
        // Check real state: list the container(s) for the service.
        const ps = Bun.spawn(["docker", ...this.composeArgs, "ps", "-q", SERVICE_NAME], {
            stdout: "pipe",
            stderr: "pipe",
            cwd: REXA_ROOT,
            env: this.dockerEnv,
        });
        const psOut = await new Response(ps.stdout).text();
        const psErr = await new Response(ps.stderr).text();
        await ps.exited;

        if (psErr.includes("no configuration file") || psErr.includes("no such file")) {
            throw new Error(
                "Docker Compose sandbox configuration is missing/unreadable. " +
                    `Cannot run "${SERVICE_NAME}". Check REXA's bundled docker-compose.yaml is available.`,
            );
        }

        const containerId = psOut.trim().split(/\s+/)[0];
        if (containerId) {
            // Confirm the found container is actually in a running state.
            const inspect = Bun.spawn(
                ["docker", "inspect", "-f", "{{.State.Running}}", containerId],
                { stdout: "pipe", stderr: "pipe", cwd: REXA_ROOT },
            );
            const running = (await new Response(inspect.stdout).text()).trim() === "true";
            await inspect.exited;
            if (running) {
                return;
            }
        }

        // Not up (or not running): build (if needed) and start it.
        const up = Bun.spawn(["docker", ...this.composeArgs, "up", "-d", "--build", SERVICE_NAME], {
            stdout: "pipe",
            stderr: "pipe",
            cwd: REXA_ROOT,
            env: this.dockerEnv,
        });
        const upOut = await new Response(up.stdout).text();
        const upErr = await new Response(up.stderr).text();
        const upExit = await up.exited;

        if (upExit !== 0) {
            throw new Error(
                `Failed to start sandbox service (exit ${upExit}).\nstdout: ${upOut}\nstderr: ${upErr}`,
            );
        }
          logger.info("Sandbox container started");
        this.startedThisSession = true;
    }

    
    //   Stop and remove the sandbox stack — but only if this session actually
    //   brought it up
    async stop(): Promise<void> {
        if (!this.startedThisSession) {
            return;
        }
        this.startedThisSession = false;
        const down = Bun.spawn(["docker", ...this.composeArgs, "down", "--remove-orphans"], {
            stdout: "pipe",
            stderr: "pipe",
            cwd: REXA_ROOT,
            env: this.dockerEnv,
        });
        await new Response(down.stdout).text();
        await new Response(down.stderr).text();
        await down.exited;
    }
}

//   Shared singleton used by the execute_command tool and the Agent lifecycle. 
export const sandboxManager = new ExecutionManager();
