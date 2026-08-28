import { z } from "zod";
import { type Tool } from "./ToolRegistry";
import { sandboxManager } from "./ExecutionManager";
import { confirm } from "@inquirer/prompts";
import { getGitOperation, gitRequiresConfirmation } from "./CommandPolicy";
import { pauseActiveSpinner, resumeActiveSpinner } from "../cli/TerminalState";

const gitCommandSchema = z.object({
    args: z
        .array(z.string())
        .describe("Git subcommand and arguments, e.g. ['status'], ['add', '.'], ['commit', '-m', 'message'], ['push']")
        .default(["status"]),
    workdir: z
        .enum(["/app", "/workspace"])
        .default("/app")
        .describe("Sandbox working directory. Use /app for the current project or /workspace for a previously cloned repository."),
});

export const gitCommand: Tool = {
    name: "git_command",
    description: "Execute Git commands inside the Docker sandbox. The current project is available at /app. Clones always go to the private /workspace volume. Use workdir /workspace for Git commands against a cloned repository.",
    parameters: gitCommandSchema,
    execute: async (args: z.infer<typeof gitCommandSchema>) => {
        const parsed = gitCommandSchema.parse(args);
        try {
            const operation = getGitOperation(parsed.args);
            const workdir = operation === "clone" ? "/workspace" : parsed.workdir;
            if (gitRequiresConfirmation(parsed.args)) {
                const spinnerWasActive = pauseActiveSpinner();
                let approved = false;
                try {
                    approved = await confirm({
                        message: `Allow sandbox Git operation: git ${parsed.args.join(" ")}?`,
                        default: false,
                    });
                } finally {
                    resumeActiveSpinner(spinnerWasActive);
                }
                if (!approved) {
                    return { success: false, status: "rejected", command: "git", args: parsed.args, workdir, message: "Git operation rejected by the user." };
                }
            }
            const result = await sandboxManager.execute({
                command: "git",
                args: parsed.args,
                workdir,
            });

            if (!result.success) {
                return { ...result, status: "error", message: result.stderr || result.stdout };
            }

            return { ...result, stdout: result.stdout || "Command completed with no output." };
        } catch (error: any) {
            return { status: "error", message: error.message };
        }
    }
};

export const gitStatus = gitCommand;
