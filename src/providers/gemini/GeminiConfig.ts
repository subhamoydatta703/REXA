import type { ThinkingLevel } from "@google/genai";

export interface GeminiConfig {
    maxOutputTokens?: number;
    thinkingLevel?: ThinkingLevel;
}
