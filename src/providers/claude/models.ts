import type { ModelDefinition } from "../ProviderSettings";

export const claudeModels: ModelDefinition[] = [
    {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        tools: true,
        streaming: true,
        reasoning: {
            kind: "levels",
            levels: ["low", "medium", "high", "max"],
            documentedDefault: "high",
        },
        sources: [
            "https://platform.claude.com/docs/en/models/sonnet-4-6/overview",
            "https://platform.claude.com/docs/en/build-with-claude/effort",
            "https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview",
            "https://platform.claude.com/docs/en/build-with-claude/streaming",
        ],
        reviewedAt: "2026-10-13",
    },
];
