import type { Message } from "../agent/Message";
import type { LLMProvider } from "../providers/LLMProvider";

import { ApiError, FunctionCallingConfigMode, GoogleGenAI, type Part } from "@google/genai";
import type { LLMResponse } from "../providers/LLMResponse";
import type { Tool } from "../tools/ToolRegistry";
import * as z from "zod";
import { logger } from "../logger/AgentLogger";
import type { RunCallbacks } from "../agent/RunCallbacks";

interface GeminiErrorDetails {
    "@type": string;
    reason?: string;
    domain?: string;
    retryDelay?: string;
    violations?: Array<any>;
    links?: Array<{ description: string; url: string }>;
}

export class GeminiProvider implements LLMProvider {
    private client: GoogleGenAI;

    constructor(apikey: string) {
        this.client = new GoogleGenAI({ apiKey: apikey });
    }

    async generate(
        messages: Message[],
        tools: Tool[] = [],
        systemInstruction?: string,
        _memorySearchInstruction?: string,
        callbacks?: Pick<RunCallbacks, "onToken">,
    ): Promise<LLMResponse> {

        try {
            const functionDeclarations = tools.map(tool => ({
                name: tool.name,
                description: tool.description,
                parametersJsonSchema: z.toJSONSchema(tool.parameters)
            }));

            const contents = messages.map(msg => {
                if (msg.parts) {
                    return {
                        role: msg.role === "assistant" ? "model" : msg.role === "tool" ? "user" : msg.role,
                        parts: msg.parts
                    };
                }

                return {
                    role: msg.role === "assistant" ? "model" : "user",
                    parts: [{ text: msg.content || "" }]
                };
            });

           

            const stream = await this.client.models.generateContentStream({
                model: "gemini-3.6-flash",
                contents,
                config: {
                    systemInstruction: systemInstruction,
                    ...(tools.length > 0 ? {
                        toolConfig: {
                            functionCallingConfig: {
                                mode: FunctionCallingConfigMode.AUTO
                            }
                        },
                        tools: [{ functionDeclarations }],
                    } : {}),
                },
                
            });

            const parts: Part[] = [];
            const functionCalls: NonNullable<LLMResponse["toolcalls"]> = [];
            let extractedText = "";
            let hasFunctionCalls = false;

            for await (const chunk of stream) {
                const chunkParts = chunk.candidates?.[0]?.content?.parts ?? [];
                parts.push(...chunkParts);

                const chunkCalls = chunk.functionCalls ?? [];
                if (chunkCalls.length > 0) {
                    hasFunctionCalls = true;
                    functionCalls.push(...chunkCalls
                        .filter((call): call is typeof call & { name: string } => Boolean(call.name))
                        .map(call => ({ name: call.name, params: (call.args as Record<string, unknown>) || {} })));
                }

                const chunkText = chunk.text ?? "";
                extractedText += chunkText;
                const chunkHasFunctionCall = chunkCalls.length > 0 || chunkParts.some(
                    (part) => "functionCall" in part && Boolean(part.functionCall),
                );

                // Tool turns are never user-facing. Stream only textual chunks
                // that belong to a response chunk without a function call.
                if (chunkText && !chunkHasFunctionCall) {
                    callbacks?.onToken?.(chunkText);
                }
            }


            return {
                role: "assistant",
                text: extractedText,
                rawParts: parts,
                toolcalls: functionCalls,
            };

        } catch (error: any) {

            

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
            message: error instanceof Error
                ? error.message
                : String(error),
        },
    };
            
        }
    }



}
