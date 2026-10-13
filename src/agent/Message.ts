import { z } from "zod";
import { toolCallSchema, type ToolCall } from "../tools/ToolRegistry";
import { providerIdSchema } from "../providers/ProviderSettings";
import type { LLMResponse } from "../providers/LLMResponse";

export const nativeContinuationSchema = z
    .object({
        provider: providerIdSchema,
        // Old sessions did not record a model. New adapters must include it.
        model: z.string().min(1).optional(),
        data: z.array(z.record(z.string(), z.unknown())),
    })
    .strict();
export type NativeContinuation = z.infer<typeof nativeContinuationSchema>;

export const toolResultSchema = z
    .object({
        callId: z.string().min(1),
        name: z.string().min(1),
        output: z.record(z.string(), z.unknown()),
    })
    .strict();
export type ToolResult = z.infer<typeof toolResultSchema>;

export const messageSchema = z
    .object({
        agentName: z.string().optional(),
        runID: z.string().optional(),
        role: z.enum(["user", "model", "assistant", "tool"]),
        content: z.string().optional(),
        toolCalls: z.array(toolCallSchema).optional(),
        toolResults: z.array(toolResultSchema).optional(),
        native: nativeContinuationSchema.optional(),
    })
    .strict()
    .superRefine((message, context) => {
        const ids = message.toolCalls?.map((call) => call.id) ?? [];
        if (new Set(ids).size !== ids.length) {
            context.addIssue({
                code: "custom",
                message: "Tool call IDs must be unique within a turn.",
            });
        }
        if (ids.length && !["model", "assistant"].includes(message.role)) {
            context.addIssue({
                code: "custom",
                message: "Only assistant turns can request tools.",
            });
        }
        if (message.toolResults?.length && message.role !== "tool") {
            context.addIssue({
                code: "custom",
                message: "Tool results require a tool turn.",
            });
        }
    });

export type Message = z.infer<typeof messageSchema>;
export type ResearchMessage = Message;

/** Keep common text/calls separate from opaque provider continuation data. */
export function assistantMessage(response: LLMResponse): Message {
    return messageSchema.parse({
        role: "model",
        content: response.text,
        toolCalls: response.toolcalls,
        native: response.native,
    });
}

export function toolResultMessage(
    call: ToolCall,
    output: Record<string, unknown>,
): Message {
    return {
        role: "tool",
        toolResults: [{ callId: call.id, name: call.name, output }],
    };
}
