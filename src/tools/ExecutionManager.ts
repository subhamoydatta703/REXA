import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProcessManager } from "./ProcessManager";
import type { ToolExecutionContext } from "./ToolRegistry";

export const workdirSchema = z
    .string()
    .default("/app")
    .refine(
        (value) =>
            /^\/(app|workspace)(?:\/[^\\\0]*)?$/.test(value) &&
            !value.split("/").some((p) => p === ".." || p === "."),
        "Working directory must stay within /app or /workspace.",
    );
const inputSchema = z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive().max(300_000).default(60_000),
    workdir: workdirSchema,
});
export type ExecutionInput = z.input<typeof inputSchema>;
export interface ExecutionResult {
    success: boolean;
    status: string;
    command: string;
    args: string[];
    exitCode: number | null;
    stdout: string;
    stderr: string;
    workdir: string;
    truncated?: boolean;
}
const REXA_ROOT = path.resolve(import.meta.dir, "../..");
const COMPOSE_FILE = path.join(REXA_ROOT, "docker-compose.yaml");

// Pass only Docker and operating-system settings; provider credentials stay on the host.
const DOCKER_ENVIRONMENT_KEYS = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "ComSpec",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "ALLUSERSPROFILE",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
    "SystemDrive",
    "TEMP",
    "TMP",
    "OS",
    "USERNAME",
    "USERDOMAIN",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
];

/** Owns one Docker Compose project and its command processes. */
export class ExecutionManager {
    private readonly targetWorkspace: string;
    readonly composeProjectName = `rexa_${process.pid}_${randomUUID().slice(0, 8)}`;
    private startedThisSession = false;
    private starting?: Promise<void>;
    readonly processes = new ProcessManager();
    constructor(workspace = process.cwd()) {
        this.targetWorkspace = path.resolve(workspace);
    }

    private get composeArgs() {
        return ["compose", "-p", this.composeProjectName, "-f", COMPOSE_FILE];
    }

    private get dockerEnv(): Record<string, string> {
        const env: Record<string, string> = {
            REXA_WORKSPACE: this.targetWorkspace,
            REXA_SANDBOX_NETWORK: process.env.REXA_SANDBOX_NETWORK || "bridge",
            REXA_SANDBOX_MEMORY: process.env.REXA_SANDBOX_MEMORY || "1G",
            REXA_SANDBOX_CPUS: process.env.REXA_SANDBOX_CPUS || "1",
        };
        for (const key of DOCKER_ENVIRONMENT_KEYS) {
            if (process.env[key]) {
                env[key] = process.env[key]!;
            }
        }
        return env;
    }

    private async docker(args: string[], timeoutMs = 120_000) {
        const id = await this.processes.start(["docker", ...args], {
            cwd: REXA_ROOT,
            env: this.dockerEnv,
            timeoutMs,
        });
        const result = await this.processes.wait(id);
        if (!result.success) {
            throw new Error(
                `Docker operation ${result.status}: ${result.stderr || result.stdout}`,
            );
        }
        return result.stdout;
    }

    private async startSandbox(): Promise<void> {
        await this.docker(
            [...this.composeArgs, "up", "-d", "--build", "sandbox"],
            300_000,
        );
        this.startedThisSession = true;
    }

    private supervisorArgs(
        action: "run" | "stop",
        identifier: string,
    ): string[] {
        return [
            ...this.composeArgs,
            "exec",
            "-T",
            "sandbox",
            "bun",
            "/opt/rexa/sandbox-supervisor.ts",
            action,
            identifier,
        ];
    }

    private async stopContainerProcess(identifier: string): Promise<void> {
        await this.docker(this.supervisorArgs("stop", identifier), 10_000);
    }

    async ensureSandbox() {
        if (!this.starting) {
            this.starting = this.startSandbox();
        }
        try {
            await this.starting;
        } catch (e) {
            this.starting = undefined;
            throw e;
        }
    }

    async start(input: ExecutionInput, context: ToolExecutionContext = {}) {
        const parsed = inputSchema.parse(input);
        context.signal?.throwIfAborted();
        await this.ensureSandbox();
        context.signal?.throwIfAborted();
        const remoteId = randomUUID();
        const id = await this.processes.start(
            [
                "docker",
                ...this.supervisorArgs("run", remoteId),
                String(parsed.timeoutMs / 1000),
                parsed.workdir,
                parsed.command,
                ...parsed.args,
            ],
            {
                cwd: REXA_ROOT,
                env: this.dockerEnv,
                timeoutMs: parsed.timeoutMs + 5000,
                signal: context.signal,
                onOutput: context.onOutput,
                terminate: () => this.stopContainerProcess(remoteId),
            },
        );
        return { id, ...parsed };
    }

    async execute(
        input: ExecutionInput,
        context: ToolExecutionContext = {},
    ): Promise<ExecutionResult> {
        const started = await this.start(input, context);
        const result = await this.processes.wait(started.id);
        return {
            ...result,
            command: started.command,
            args: started.args,
            workdir: started.workdir,
            status: result.exitCode === 124 ? "timeout" : result.status,
            success: result.success && result.exitCode !== 124,
        };
    }

    async stop() {
        await this.processes.stopAll();
        if (!this.startedThisSession) {
            return;
        }
        await this.docker([
            ...this.composeArgs,
            "down",
            "--remove-orphans",
            "--volumes",
        ]);
        this.startedThisSession = false;
        this.starting = undefined;
    }
}
export const sandboxManager = new ExecutionManager();
