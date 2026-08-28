import { z } from "zod";
import { type Tool } from "./ToolRegistry";
import { sandboxManager } from "./ExecutionManager";
import { confirm } from "@inquirer/prompts";
import { getGitOperation, validateSandboxedGitClone } from "./CommandPolicy";
import { pauseActiveSpinner, resumeActiveSpinner } from "../cli/TerminalState";

const gitCommandSchema = z.object({
    args: z
        .array(z.string())
        .describe("Git subcommand and arguments, e.g. ['status'], ['add', '.'], ['commit', '-m', 'message'], ['push']")
        .default(["status"]),
    workdir: z
        .enum(["/app", "/workspace"])
        .default("/app")
        .describe("Git target: /app uses the current project and host Git credentials; /workspace uses a cloned repository inside Docker."),
});

export const gitCommand: Tool = {
    name: "git_command",
    description: "Execute Git commands after explicit user confirmation. Git for the current project runs on the host so it can use the user's configured credentials for push. Clones and Git commands with workdir /workspace run in Docker's private sandbox volume.",
    parameters: gitCommandSchema,
    execute: async (args: z.infer<typeof gitCommandSchema>) => {
        const parsed = gitCommandSchema.parse(args);
        try {
            const operation = getGitOperation(parsed.args);
            const workdir = operation === "clone" ? "/workspace" : parsed.workdir;
            const cloneValidation = operation === "clone" ? validateSandboxedGitClone(parsed.args) : undefined;
            if (cloneValidation) {
                return { success: false, status: "rejected", command: "git", args: parsed.args, workdir, message: cloneValidation };
            }
            const spinnerWasActive = pauseActiveSpinner();
            let approved = false;
            try {
                approved = await confirm({
                    message: `Allow ${workdir === "/workspace" ? "sandbox" : "host"} Git operation: git ${parsed.args.join(" ")}?`,
                    default: false,
                });
            } finally {
                resumeActiveSpinner(spinnerWasActive);
            }
            if (!approved) {
                return { success: false, status: "rejected", command: "git", args: parsed.args, workdir, message: "Git operation rejected by the user." };
            }

            const result = workdir === "/workspace"
                ? await sandboxManager.execute({ command: "git", args: parsed.args, workdir })
                : await executeHostGit(parsed.args);

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

async function executeHostGit(args: string[]) {
    const targetWorkspace = process.cwd();
    const gitProcess = Bun.spawn(["git", ...args], {
        cwd: targetWorkspace,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(gitProcess.stdout).text(),
        new Response(gitProcess.stderr).text(),
        gitProcess.exited,
    ]);

    return {
        success: exitCode === 0,
        status: exitCode === 0 ? "executed" : "failed",
        command: "git",
        args,
        exitCode,
        stdout,
        stderr,
        workdir: "/app" as const,
    };
}
