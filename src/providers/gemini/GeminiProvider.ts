import type { Message } from "../../agent/Message";
import type { LLMProvider } from "../LLMProvider";

import {
    ApiError,
    FunctionCallingConfigMode,
    GoogleGenAI,
    type Part,
} from "@google/genai";
import type { LLMResponse } from "../LLMResponse";
import type { Tool } from "../../tools/ToolRegistry";
import * as z from "zod";
import type { RunCallbacks } from "../../agent/RunCallbacks";
import {
    DEFAULT_GEMINI_MODEL,
    geminiContents,
    geminiResponse,
} from "./GeminiProtocol";

interface GeminiClient {
    models: Pick<GoogleGenAI["models"], "generateContentStream">;
}

export class GeminiProvider implements LLMProvider {
    private client: GeminiClient;

    constructor(apikey: string, client?: GeminiClient) {
        this.client = client ?? new GoogleGenAI({ apiKey: apikey });
    }

    async generate(
        messages: Message[],
        tools: Tool[] = [],
        systemInstruction?: string,
        _memorySearchInstruction?: string,
        callbacks?: Pick<RunCallbacks, "onToken" | "signal">,
    ): Promise<LLMResponse> {
        try {
            const functionDeclarations = tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parametersJsonSchema: z.toJSONSchema(tool.parameters),
            }));

            const contents = geminiContents(messages, DEFAULT_GEMINI_MODEL);

            const stream = await this.client.models.generateContentStream({
                model: DEFAULT_GEMINI_MODEL,
                contents,
                config: {
                    abortSignal: callbacks?.signal,
                    systemInstruction: systemInstruction,
                    ...(tools.length > 0
                        ? {
                              toolConfig: {
                                  functionCallingConfig: {
                                      mode: FunctionCallingConfigMode.AUTO,
                                  },
                              },
                              tools: [{ functionDeclarations }],
                          }
                        : {}),
                },
            });

            const parts: Part[] = [];
            let extractedText = "";

            for await (const chunk of stream) {
                const chunkParts = chunk.candidates?.[0]?.content?.parts ?? [];
                parts.push(...chunkParts);

                const chunkCalls = chunk.functionCalls ?? [];

                const chunkText = chunk.text ?? "";
                extractedText += chunkText;
                const chunkHasFunctionCall =
                    chunkCalls.length > 0 ||
                    chunkParts.some(
                        (part) =>
                            "functionCall" in part &&
                            Boolean(part.functionCall),
                    );

                // Tool turns are never user-facing. Stream only textual chunks
                // that belong to a response chunk without a function call.
                if (chunkText && !chunkHasFunctionCall) {
                    callbacks?.onToken?.(chunkText);
                }
            }

            return geminiResponse(parts, extractedText, DEFAULT_GEMINI_MODEL);
        } catch (error) {
            if (error instanceof ApiError) {
                console.log("Gemini API Error");
                console.log("name:", error.name);
                console.log("status:", error.status);
                console.log("message:", error.message);

                if (error.status === 429) {
                    console.log("RATE LIMIT");
                }

                return {
                    role: "assistant",
                    text: "",
                    error: {
                        type: "LLM_GENERATION_FAILED",
                        message: error.message,
                    },
                };
            }

            return {
                role: "assistant",
                text: "",
                error: {
                    type: "LLM_GENERATION_FAILED",
                    message:
                        error instanceof Error ? error.message : String(error),
                },
            };
        }
    }
}
