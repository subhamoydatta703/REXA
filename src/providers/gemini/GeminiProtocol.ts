import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Content, Part } from "@google/genai";
import { messageSchema, type Message } from "../../agent/Message";
import type { LLMResponse } from "../LLMResponse";
import type { ToolCall } from "../../tools/ToolRegistry";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

/** Extract each call once from its actual part, preserving signatures untouched. */
export function geminiResponse(
    parts: Part[],
    text: string,
    model: string,
): LLMResponse {
    const toolcalls: ToolCall[] = [];
    for (const part of parts) {
        const call = part.functionCall;
        if (call) {
            if (!call.name || call.partialArgs?.length || call.willContinue) {
                throw new Error(
                    "Incomplete Gemini function call; no tools were executed.",
                );
            }
            toolcalls.push({
                id: call.id || randomUUID(),
                name: call.name,
                params: call.args ?? {},
            });
        }
    }
    messageSchema.parse({ role: "model", toolCalls: toolcalls });
    return {
        role: "assistant",
        text,
        toolcalls,
        // Opaque SDK parts remain inside the Gemini translation boundary.
        native: {
            provider: "gemini",
            model,
            data: parts as Record<string, unknown>[],
        },
    };
}

/** Shared loops never build Google parts or manufacture thought signatures. */
export function geminiContents(messages: Message[], model: string): Content[] {
    const pending = new Map<string, { call: ToolCall; nativeId?: string }>();
    const contents = messages.map((message): Content => {
        messageSchema.parse(message);
        if (pending.size && message.role !== "tool") {
            throw new Error(
                "A tool-call turn must be followed by all its results.",
            );
        }
        const isAssistant =
            message.role === "assistant" || message.role === "model";
        const role = isAssistant ? "model" : "user";
        const native = message.native;
        const wrongProvider = native && native.provider !== "gemini";
        const wrongModel = native?.model && native.model !== model;
        if (wrongProvider || wrongModel) {
            throw new Error(
                "Incompatible provider continuation data; a conversation handoff is required.",
            );
        }
        const nativeParts = native?.data as Part[] | undefined;
        if (message.toolCalls?.length) {
            const sharedParts: Part[] = message.toolCalls.map((call) => ({
                functionCall: {
                    id: call.id,
                    name: call.name,
                    args: call.params,
                },
            }));
            if (message.content) {
                sharedParts.unshift({ text: message.content });
            }
            const parts = nativeParts ?? sharedParts;
            const nativeCalls = parts.flatMap((part) =>
                part.functionCall ? [part.functionCall] : [],
            );
            if (nativeCalls.length !== message.toolCalls.length) {
                throw new Error(
                    "Gemini continuation calls do not match shared tool calls.",
                );
            }
            for (const [index, call] of message.toolCalls.entries()) {
                const original = nativeCalls[index]!;
                if (
                    original.name !== call.name ||
                    (original.id && original.id !== call.id) ||
                    !isDeepStrictEqual(original.args ?? {}, call.params) ||
                    pending.has(call.id)
                ) {
                    throw new Error(
                        "Gemini tool call identity is invalid or duplicated.",
                    );
                }
                pending.set(call.id, { call, nativeId: original.id });
            }
            return { role, parts };
        }
        if (message.toolResults?.length) {
            const parts = message.toolResults.map((result): Part => {
                const original = pending.get(result.callId);
                if (!original || original.call.name !== result.name) {
                    throw new Error("Tool result has no matching Gemini call.");
                }
                pending.delete(result.callId);
                return {
                    functionResponse: {
                        name: result.name,
                        ...(original.nativeId ? { id: original.nativeId } : {}),
                        response: result.output,
                    },
                };
            });
            return { role, parts };
        }
        return {
            role,
            parts: nativeParts ?? [{ text: message.content ?? "" }],
        };
    });
    if (pending.size) {
        throw new Error(
            "Conversation has unanswered tool calls; recover it before generation.",
        );
    }
    return contents;
}

const legacyPartSchema = z
    .object({
        text: z.string().optional(),
        functionCall: z
            .object({
                id: z.string().optional(),
                name: z.string().min(1),
                args: z.record(z.string(), z.unknown()).optional(),
            })
            .passthrough()
            .optional(),
        functionResponse: z
            .object({
                id: z.string().optional(),
                name: z.string().min(1),
                response: z.record(z.string(), z.unknown()).optional(),
            })
            .passthrough()
            .optional(),
    })
    .passthrough();

export const legacyGeminiMessageSchema = z
    .object({
        role: z.enum(["user", "model", "assistant", "tool"]),
        content: z.string().optional(),
        agentName: z.string().optional(),
        runID: z.string().optional(),
        parts: z.array(legacyPartSchema),
    })
    .strict();

type LegacyPart = z.infer<typeof legacyPartSchema>;

function legacyCalls(parts: LegacyPart[], messageIndex: number): ToolCall[] {
    const calls: ToolCall[] = [];
    for (const [partIndex, part] of parts.entries()) {
        if (part.functionCall) {
            calls.push({
                id:
                    part.functionCall.id ||
                    `legacy-${messageIndex}-${partIndex}`,
                name: part.functionCall.name,
                params: part.functionCall.args ?? {},
            });
        }
    }
    return calls;
}

/** Convert saved v1 Google-shaped messages in memory, never rewrite old records. */
export function migrateLegacyMessages(input: unknown[]): Message[] {
    let pending: ToolCall[] = [];
    return input.map((value, index) => {
        const current = messageSchema.safeParse(value);
        if (current.success) {
            if (current.data.role !== "tool") {
                pending = [...(current.data.toolCalls ?? [])];
            } else {
                const completed = new Set(
                    current.data.toolResults?.map((result) => result.callId),
                );
                pending = pending.filter((call) => !completed.has(call.id));
            }
            return current.data;
        }
        const { parts, ...base } = legacyGeminiMessageSchema.parse(value);
        const message: Message = { ...base };
        if (base.role !== "tool") {
            message.content ??= parts
                .filter((part) => !part.thought)
                .map((part) => part.text ?? "")
                .join("");
            message.native = { provider: "gemini", data: parts };
            message.toolCalls = legacyCalls(parts, index);
            pending = [...message.toolCalls];
        } else {
            message.toolResults = parts.flatMap((part) => {
                const result = part.functionResponse;
                if (!result) {
                    return [];
                }
                // Legacy results without IDs can only be matched in call order.
                const match = pending.findIndex((call) => {
                    if (result.id) {
                        return call.id === result.id;
                    }
                    return call.name === result.name;
                });
                if (match < 0) {
                    throw new Error(
                        "Legacy tool response has no matching call.",
                    );
                }
                const call = pending.splice(match, 1)[0]!;
                return [
                    {
                        callId: call.id,
                        name: result.name,
                        output: result.response ?? {},
                    },
                ];
            });
        }
        return messageSchema.parse(message);
    });
}
