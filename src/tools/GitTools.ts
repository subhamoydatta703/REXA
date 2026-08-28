import { z } from "zod";
import { type Tool } from "./ToolRegistry";

const gitCommandSchema = z.object({
    args: z
        .array(z.string())
        .describe("Git subcommand and arguments, e.g. ['status'], ['add', '.'], ['commit', '-m', 'message'], ['push']")
        .default(["status"])
});

export const gitCommand: Tool = {
    name: "git_command",
    description: "Execute Git repository commands (status, add, commit, push, pull, branch, log, diff) directly on the host machine where local Git credentials, SSH keys, and tokens reside.",
    parameters: gitCommandSchema,
    execute: async (args: z.infer<typeof gitCommandSchema>) => {
        const parsed = gitCommandSchema.parse(args);
        try {
            const process = Bun.spawn(["git", ...parsed.args], {
                stdout: "pipe",
                stderr: "pipe",
            });

            const stdout = await new Response(process.stdout).text();
            const stderr = await new Response(process.stderr).text();
            await process.exited;

            if (process.exitCode !== 0) {
                return `[Git Error - Code ${process.exitCode}]\n${stderr || stdout}`;
            }

            return `[Git Success]\n${stdout || "Command completed with no output."}`;
        } catch (error: any) {
            return { status: "error", message: error.message };
        }
    }
};

export const gitStatus = gitCommand;