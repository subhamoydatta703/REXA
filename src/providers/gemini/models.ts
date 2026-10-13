import type { ModelDefinition } from "../ProviderSettings";
import { DEFAULT_GEMINI_MODEL } from "./GeminiProtocol";

export const geminiModels: ModelDefinition[] = [
    {
        provider: "gemini",
        id: DEFAULT_GEMINI_MODEL,
        displayName: "Gemini 3.8 Flash",
        tools: true,
        streaming: true,
        reasoning: {
            kind: "levels",
            levels: ["low", "medium", "high"],
            documentedDefault: "medium",
        },
        sources: [
            "https://ai.google.dev/gemini-api/docs/latest-model",
            "https://ai.google.dev/gemini-api/docs/thinking",
            "https://ai.google.dev/gemini-api/docs/function-calling",
        ],
        reviewedAt: "2026-10-13",
    },
];
