import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import dotenv from "dotenv";
import { type Message } from "../agent/Message";
import { type Tool } from "../tools/ToolRegistry";

dotenv.config();

export interface GeminiConfig {
    maxOutputTokens?: number;
    thinkingLevel?: ThinkingLevel;
}

export async function* streamGemini(
    messages: Message[],
    tools: Tool[],
    config: GeminiConfig = {}
): AsyncGenerator<string, void, unknown> {
    let stream;

    try {
        const apiKey = process.env.GEMINI_STREAMING_API_KEY || process.env.GEMINI_API_KEY;
        if (!apiKey) {
            throw new Error("API key for Gemini Streaming is not set");
        }
        const ai = new GoogleGenAI({ apiKey });

        // Convert messages to Gemini format if necessary. 
        // Assuming current simple content passing for now based on previous implementation
        const content = messages.map(m => m.content).join("\n");
        
        stream = await ai.models.generateContentStream({
            model: "gemini-3.5-flash",
            contents: content,
            config: {
                maxOutputTokens: config.maxOutputTokens,
                thinkingConfig: {
                    thinkingLevel:
                        config.thinkingLevel ?? ThinkingLevel.LOW,
                },
                tools: tools.length > 0 ? [{ functionDeclarations: tools.map(t => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters as any
                })) }] : undefined
            },
        });
    } catch (error) {
        console.error("Error generating content stream:", error);

        throw new Error(
            `Failed to stream from Gemini: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }

    for await (const chunk of stream) {
        const text = chunk.text;

        if (text) {
            yield text;
        }
    }
}
