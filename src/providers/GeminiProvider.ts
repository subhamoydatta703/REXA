import type { Message } from "../agent/Message";
import type { LLMProvider } from "../providers/LLMProvider";
import { FunctionCallingConfigMode, GoogleGenAI, type Part } from "@google/genai";
import type { LLMResponse } from "../providers/LLMResponse";
import type { Tool } from "../tools/ToolRegistry";
import * as z from "zod";

export class GeminiProvider implements LLMProvider {
    private client: GoogleGenAI;

    constructor(apikey: string) {
        this.client = new GoogleGenAI({ apiKey: apikey });
    }

    async generate(messages: Message[], tools: Tool[], systemInstruction?: string): Promise<LLMResponse> {

        try {
            if (tools.length === 0) {
                return {
                    role: "assistant",
                    text: "No tools found",
                    rawParts: [],
                    toolcalls: []
                };
            }

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

            const response = await this.client.models.generateContent({
                model: "gemini-3.1-flash-lite",
                contents,
                config: {
                    systemInstruction: systemInstruction,
                    toolConfig: {
                        functionCallingConfig: {
                            mode: FunctionCallingConfigMode.AUTO
                        }
                    },
                    tools: [{ functionDeclarations }]
                },
                
            });

            const candidate = response.candidates?.[0];
            const functionCalls = response.functionCalls || [];
            const parts = candidate?.content?.parts ?? [];
            const extractedText = parts
                .filter((p): p is Part & { text: string } => typeof (p as any).text === "string")
                .map(p => p.text)
                .join("");

            return {
                role: "assistant",
                text: extractedText,
                rawParts: parts,
                toolcalls: functionCalls
                    .filter(
                        (call): call is typeof call & { name: string } => Boolean(call.name)
                    )
                    .map(call => ({ name: call.name, params: (call.args as Record<string, unknown>) || {} }))
            };

        } catch (error) {

            console.error("LLM generation failed:", error);

            return {
                role: "assistant",
                text: "",
                rawParts: [],
                toolcalls: [],
                error: {
                    type: "LLM_GENERATION_FAILED",
                    message:
                        error instanceof Error
                            ? error.message
                            : String(error)
                }
            };
        }
    }



}

