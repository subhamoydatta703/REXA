import type { AgentMode } from "../agent/AgentMode";
import type { Tool, ToolRegistry, ToolExecutionContext } from "./ToolRegistry";
import { permissions, type PermissionService } from "./PermissionService";

export class ToolDispatcher {
    constructor(
        private registry: ToolRegistry,
        private permissionService: PermissionService = permissions,
    ) {}

    tools(mode: AgentMode): Tool[] {
        return this.registry
            .getAllTools()
            .filter(
                (tool) =>
                    mode === "act" ||
                    tool.effect === "read" ||
                    tool.effect === "web",
            );
    }

    async execute(
        name: string,
        params: unknown,
        mode: AgentMode,
        context: ToolExecutionContext = {},
    ) {
        const tool = this.tools(mode).find(
            (candidate) => candidate.name === name,
        );
        if (!tool) {
            return {
                success: false,
                status: "blocked",
                error: `Tool ${name} is unavailable in ${mode} mode.`,
            };
        }
        context.signal?.throwIfAborted();
        const parsed = tool.parameters.parse(params);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Tool arguments must be an object.");
        }
        if (
            !(await this.permissionService.authorize(
                tool,
                parsed as Record<string, unknown>,
            ))
        ) {
            return {
                success: false,
                status: "rejected",
                error: "Operation denied by permission policy or user.",
            };
        }
        context.signal?.throwIfAborted();
        return tool.execute(parsed, { ...context, approved: true });
    }
}
