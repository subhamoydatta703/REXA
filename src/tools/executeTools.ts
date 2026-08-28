import { z } from "zod";
import type { Tool } from "./ToolRegistry";
import { createInterface } from "node:readline/promises";
import { sandboxManager } from "./ExecutionManager";

const executeSchema = z.object({
    command: z
        .string()
        .describe(
            "The actual executable name only, such as git, bun, node, npm, npx, tsc, or python. " +
            "Do not use shell built-ins or aliases such as ls, cat, dir, type, cd, echo, mkdir, find, cmd, grep, pwd."
        ),

    args: z
        .array(z.string())
        .describe(
            "Arguments for the executable. Each argument must be a separate string."
        )
        .default([]),

    timeoutMs: z
        .number()
        .int()
        .positive()
        .max(300_000)
        .optional()
        .describe(
            "Optional hard execution timeout in milliseconds. Defaults to 60_000 (1 minute). " +
            "Exceeding the timeout kills the command and returns a clear timeout error."
        ),
});

export type CommandPolicy = {
    // Executables that run without confirmation.
    safe: string[];
    // Shell built-ins / aliases that don't exist as standalone executables
    // (or behave differently when spawned without a shell). Always rejected,
    // never even offered for confirmation.
    blocked: string[];
};

const commandPolicy: CommandPolicy = {
    safe: [
        "git",
        "bun",
        "bunx",
        "node",
        "npm",
        "npx",
        "tsc",
        "python",
        "tail",
    ],
    blocked: [
        "ls",
        "cat",
        "dir",
        "type",
        "cd",
        "echo",
        "mkdir",
        "rmdir",
        "find",
        "cmd",
        "grep",
        "pwd",
        "rm",
        "cp",
        "mv",
        "touch",
        "which",
        "where",
    ],
};

type Validation = "safe" | "blocked" | "confirmation_required";

function validateCommand(command: string, args: string[] = []): Validation {
    const cmd = command.trim().toLowerCase();

    if (commandPolicy.blocked.includes(cmd)) {
        return "blocked";
    }
    const hasEvalFlag = args.some(arg => 
        ["-e", "-c", "--eval", "--print", "-p"].includes(arg.trim())
    );
    if (hasEvalFlag) {
        return "confirmation_required";
    }
    
    if (commandPolicy.safe.includes(cmd)) {
        return "safe";
    }

    return "confirmation_required";
}

import { confirm } from "@inquirer/prompts";

async function askForConfirmation(command: string, args: string[]): Promise<boolean> {
    const display = [command, ...args].join(" ");
    try {
        return await confirm({
            message: `Run "${display}"?`,
            default: true,
        });
    } catch {
        return false;
    }
}

function blockedResponse(command: string) {
    return {
        success: false,
        status: "blocked" as const,
        command,
        error:
            `"${command}" is not usable here — it's a shell built-in or alias that does not run ` +
            `as a standalone executable on this platform. Do not retry this command or a similar ` +
            `shell alternative (ls/cat/dir/type/find/cmd/grep/etc are all blocked). ` +
            `Use find_file to locate a file, read_file or read_multiple_files to read contents, ` +
            `read_directory to read an entire directory recursively, or list_files to enumerate ` +
            `file paths without reading contents.`,
    };
}

function rejectedResponse(command: string) {
    return {
        success: false,
        status: "rejected" as const,
        command,
        error: "Command execution was rejected by the user.",
    };
}

export const executeCommand: Tool = {
    name: "execute_command",

    description:
        "Execute a real, standalone executable directly (in a Docker sandbox). " +
        "USE THIS only for build/run/package-manager/VCS tools such as git, bun, node, npm, npx, tsc, python. " +
        "DO NOT use this for file inspection or shell built-ins/aliases " +
        "(ls, cat, dir, type, cd, echo, mkdir, rmdir, find, cmd, grep, pwd, rm, cp, mv, touch, which, where) " +
        "— these are blocked and will always return an error instead of running. " +
        "To inspect files instead, use find_file, read_file, read_multiple_files, read_directory, or list_files. " +
        "command must be the executable name only; put every argument as a separate string in args.",

    parameters: executeSchema,

    execute: async (args: z.infer<typeof executeSchema>) => {
        const parsed = executeSchema.parse(args);
        const command = parsed.command.trim();
        const validation = validateCommand(command);

        if (validation === "blocked") {
            return blockedResponse(command);
        }

        if (validation === "confirmation_required") {
            const confirmed = await askForConfirmation(command, parsed.args);
            if (!confirmed) {
                return rejectedResponse(command);
            }
        }

        try {
            // The terminal command guardrail (blocked / safe / confirmation) has
            // already run above. Delegating the actual Docker execution to the
            // shared ExecutionManager:
            //  - It only starts the sandbox when Compose reports it down,
            //  - runs the command with `docker compose exec -T sandbox ...`,
            //  - enforces a hard timeout and kills the process on timeout,
            //  - and does NOT stop the sandbox after this single command (it is
            //    torn down once by the Agent when the task finishes).
            const result = await sandboxManager.execute({
                command,
                args: parsed.args,
                timeoutMs: parsed.timeoutMs,
            });

            return {
                success: result.success,
                status: result.status,
                command,
                args: parsed.args,
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
                hint:
                    result.status === "timeout"
                        ? "The command was killed because it exceeded the execution timeout. " +
                          "If a longer run is genuinely required, retry with an explicit timeoutMs and keep it within bounds."
                        : undefined,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const looksLikeMissingBinary = /ENOENT|not recognized|not found|no such file/i.test(message);

            return {
                success: false,
                status: "failed" as const,
                command,
                args: parsed.args,
                exitCode: null,
                stdout: "",
                stderr: message,
                hint: looksLikeMissingBinary
                    ? `"${command}" was not found as an executable on this system. If you were trying to ` +
                      `inspect files or directories, use find_file / read_file / read_multiple_files / ` +
                      `read_directory / list_files instead of a shell command.`
                    : undefined,
            };
        }
    },
};
