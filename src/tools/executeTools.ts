import { z } from "zod";
import type { Tool, ToolExecutionContext } from "./ToolRegistry";
import {
    sandboxManager,
    workdirSchema,
    type ExecutionManager,
} from "./ExecutionManager";
import { getGitOperation, validateSandboxedGitClone } from "./CommandPolicy";
import { permissions } from "./PermissionService";
import { editor } from "./SafeEditor";
import type { ProcessResult } from "./ProcessManager";
import type { Checkpoint, CheckpointStore } from "./CheckpointStore";

const schema = z.object({
    command: z
        .string()
        .min(1)
        .regex(
            /^[a-zA-Z0-9_.+-]+$/,
            "Use an executable name, not a path or shell expression.",
        ),
    args: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive().max(300_000).default(60_000),
    workdir: workdirSchema,
    background: z.boolean().default(false),
});

interface CompletedCommand extends ProcessResult {
    checkpointScope: string;
    checkpoint?: string;
    changedFiles?: string[];
    diff?: string;
}

export function executionTools(
    manager: ExecutionManager = sandboxManager,
    checkpoints: CheckpointStore = editor.checkpoints,
): Tool[] {
    const completions = new Map<string, Promise<CompletedCommand>>();
    const idSchema = z.object({ id: z.string().uuid() });
    const writeSchema = idSchema.extend({ input: z.string().max(8192) });

    async function completeCommand(
        id: string,
        checkpoint?: Checkpoint,
    ): Promise<CompletedCommand> {
        const result = await manager.processes.wait(id);
        const snapshot = checkpoint
            ? await checkpoints.finishCommand(checkpoint)
            : {
                  checkpointScope:
                      "Private /workspace clones are not checkpointed.",
              };
        return {
            ...result,
            status: result.exitCode === 124 ? "timeout" : result.status,
            ...snapshot,
        };
    }

    const execute: Tool = {
        name: "execute_command",
        effect: "command",
        description:
            "Run an executable in Docker after permission approval. Streams bounded output. Supports /app/subdirectory or /workspace/repo working directories, timeoutMs <=300000, and background:true. Background handles last until REXA exits; poll_process/write_process/stop_process manage them. Checkpoints cover eligible /app text files only.",
        parameters: schema,
        execute: async (input, context: ToolExecutionContext = {}) => {
            const parsed = schema.parse(input);
            if (
                !context.approved &&
                !(await permissions.authorize(execute, parsed))
            ) {
                return { success: false, status: "rejected" };
            }
            if (
                parsed.command === "git" &&
                getGitOperation(parsed.args) === "clone"
            ) {
                const error = validateSandboxedGitClone(parsed.args);
                if (error) {
                    return { success: false, status: "rejected", error };
                }
                parsed.workdir = "/workspace";
            }
            context.signal?.throwIfAborted();
            const checkpoint = parsed.workdir.startsWith("/app")
                ? await checkpoints.beginCommand()
                : undefined;
            try {
                const started = await manager.start(parsed, context);
                const completion = completeCommand(started.id, checkpoint);
                completions.set(started.id, completion);
                // Attach a rejection handler immediately even when the caller chooses background mode.
                void completion.catch(() => {});
                if (parsed.background) {
                    return {
                        success: true,
                        status: "running",
                        id: started.id,
                        checkpoint: checkpoint?.id,
                        timeoutMs: parsed.timeoutMs,
                    };
                }
                return await completion;
            } catch (error) {
                // A failed launch may still have touched files; close its snapshot if possible.
                if (checkpoint && checkpoint.status === "recording") {
                    await checkpoints.finishCommand(checkpoint);
                }
                throw error;
            }
        },
    };
    return [
        execute,
        {
            name: "poll_process",
            effect: "read",
            description:
                "Inspect a background process handle and its bounded output. Completed processes also report command checkpoint results.",
            parameters: idSchema,
            execute: async (input) => {
                const { id } = idSchema.parse(input);
                const state = manager.processes.poll(id);
                if (state.status === "running") {
                    return state;
                }
                return (await completions.get(id)) ?? state;
            },
        },
        {
            name: "write_process",
            effect: "command",
            description: "Send text to a running background process's stdin.",
            parameters: writeSchema,
            execute: async (input) => {
                const request = writeSchema.parse(input);
                await manager.processes.write(request.id, request.input);
                return { success: true };
            },
        },
        {
            name: "stop_process",
            effect: "command",
            description:
                "Stop an owned background process and its container process group.",
            parameters: idSchema,
            execute: async (input) => {
                const { id } = idSchema.parse(input);
                const result = await manager.processes.stop(id);
                return (await completions.get(id)) ?? result;
            },
        },
    ];
}
export const defaultExecutionTools = executionTools();
export const executeCommand = defaultExecutionTools[0]!;
