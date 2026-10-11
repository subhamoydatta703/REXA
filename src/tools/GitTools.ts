import { z } from "zod";
import type { Tool, ToolExecutionContext } from "./ToolRegistry";
import { sandboxManager, workdirSchema } from "./ExecutionManager";
import { getGitOperation, validateSandboxedGitClone } from "./CommandPolicy";
import { permissions } from "./PermissionService";
import { ProcessManager } from "./ProcessManager";
import { editor } from "./SafeEditor";

const schema = z.object({
    args: z.array(z.string()).default(["status"]),
    workdir: workdirSchema,
});
export const hostGitProcesses = new ProcessManager();
export const gitCommand: Tool = {
    name: "git_command",
    effect: "command",
    description:
        "Git operations with permission approval. /app paths run on the HOST using host Git credentials; /workspace and clone run inside Docker. Host Git may run configured hooks/helpers. Project text checkpoints cannot undo commits, pushes or other external effects.",
    parameters: schema,
    execute: async (input, context: ToolExecutionContext = {}) => {
        const request = schema.parse(input);
        if (
            !context.approved &&
            !(await permissions.authorize(gitCommand, request))
        ) {
            return { success: false, status: "rejected" };
        }
        if (getGitOperation(request.args) === "clone") {
            const error = validateSandboxedGitClone(request.args);
            if (error) {
                return { success: false, status: "rejected", error };
            }
            request.workdir = "/workspace";
        }
        if (request.workdir.startsWith("/workspace")) {
            return sandboxManager.execute(
                { command: "git", ...request },
                context,
            );
        }
        const cwd = await editor.ws.resolve(request.workdir.slice(5) || ".");
        const checkpoint = await editor.checkpoints.beginCommand();
        try {
            const id = await hostGitProcesses.start(["git", ...request.args], {
                cwd,
                timeoutMs: 60_000,
                signal: context.signal,
                onOutput: context.onOutput,
            });
            const result = await hostGitProcesses.wait(id);
            return {
                ...result,
                environment: "host",
                ...(await editor.checkpoints.finishCommand(checkpoint)),
            };
        } catch (error) {
            if (checkpoint.status === "recording") {
                await editor.checkpoints.finishCommand(checkpoint);
            }
            throw error;
        }
    },
};
export const gitStatus = gitCommand;
