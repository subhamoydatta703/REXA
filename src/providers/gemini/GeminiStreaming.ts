import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import dotenv from "dotenv";
import { type Message } from "../../agent/Message";
import { type Tool } from "../../tools/ToolRegistry";
import { geminiContents } from "./GeminiProtocol";
import { z } from "zod";
import type { GeminiConfig } from "./GeminiConfig";

export type { GeminiConfig } from "./GeminiConfig";

dotenv.config();

export async function* streamGemini(
    messages: Message[],
    tools: Tool[],
    config: GeminiConfig = {},
): AsyncGenerator<string, void, unknown> {
    let stream;

    try {
        const apiKey =
            process.env.GEMINI_STREAMING_API_KEY || process.env.GEMINI_API_KEY;
        if (!apiKey) {
            throw new Error("API key for Gemini Streaming is not set");
        }
        const ai = new GoogleGenAI({ apiKey });

        const content = geminiContents(messages, "gemini-3.5-flash");

        stream = await ai.models.generateContentStream({
            model: "gemini-3.5-flash",
            contents: content,
            config: {
                maxOutputTokens: config.maxOutputTokens,
                thinkingConfig: {
                    thinkingLevel: config.thinkingLevel ?? ThinkingLevel.LOW,
                },
                tools:
                    tools.length > 0
                        ? [
                              {
                                  functionDeclarations: tools.map((t) => ({
                                      name: t.name,
                                      description: t.description,
                                      parametersJsonSchema: z.toJSONSchema(
                                          t.parameters,
                                      ),
                                  })),
                              },
                          ]
                        : undefined,
            },
        });
    } catch (error) {
        // Keep provider status/code available to the caller.
        throw error;
    }

    for await (const chunk of stream) {
        const text = chunk.text;

        if (text) {
            yield text;
        }
    }
}
