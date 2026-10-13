import { z } from "zod";
import type { StaleEditRecovery } from "./StaleEditRecovery";
export interface ToolExecutionContext {
    approved?: boolean;
    signal?: AbortSignal;
    onOutput?: (text: string, stream: "stdout" | "stderr") => void;
    editRecovery?: StaleEditRecovery;
}

export interface Tool {
    name: string;
    effect?: "read" | "web" | "edit" | "command" | "external";
    description: string;
    IMPORTANT?: string;
    parameters: z.ZodSchema;
    // Each registered tool has its own schema and argument type. The dispatcher
    // validates arguments before crossing this shared execution boundary.
    execute: (args: any, context?: ToolExecutionContext) => Promise<any>;
}

export class ToolRegistry {
    private tools: Tool[] = [];

    registerTool(tool: Tool) {
        this.tools.push(tool);
    }

    getAllTools(): Tool[] {
        return this.tools;
    }

    getTool(toolName: string): Tool | undefined {
        return this.tools.find((tool) => tool.name === toolName);
    }
}

export const toolCallSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    params: z.record(z.string(), z.unknown()),
}).strict();

export type ToolCall = z.infer<typeof toolCallSchema>;
