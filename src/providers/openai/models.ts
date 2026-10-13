import type { ModelDefinition } from "../ProviderSettings";

// A verified seed entry, not a claim that this is the newest or best model.
export const openAIModels: ModelDefinition[] = [
    {
        provider: "openai",
        id: "gpt-5",
        displayName: "GPT-5",
        tools: true,
        streaming: true,
        reasoning: {
            kind: "levels",
            levels: ["minimal", "low", "medium", "high"],
        },
        contextTokens: 400000,
        maxOutputTokens: 128000,
        sources: ["https://developers.openai.com/api/docs/models/gpt-5"],
        reviewedAt: "2026-10-13",
    },
];
