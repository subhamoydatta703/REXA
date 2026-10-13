import { z } from "zod";

export const providerIdSchema = z.enum(["gemini", "openai", "anthropic"]);
export type ProviderId = z.infer<typeof providerIdSchema>;

export const reasoningLevelSchema = z.enum([
    "default",
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
]);
export type ReasoningLevel = z.infer<typeof reasoningLevelSchema>;

// "default" means omit an override, not a universal amount of reasoning.
export const providerSettingsSchema = z
    .object({
        provider: providerIdSchema,
        model: z.string().trim().min(1).max(200),
        reasoning: reasoningLevelSchema.default("default"),
    })
    .strict();

export type ProviderSettings = z.infer<typeof providerSettingsSchema>;

export function parseProviderId(value: string): ProviderId {
    const normalized = value.trim().toLowerCase();
    return providerIdSchema.parse(
        normalized === "claude" ? "anthropic" : normalized,
    );
}

export const providerPreferencesSchema = z
    .object({
        active: providerSettingsSchema.optional(),
        remembered: z
            .partialRecord(providerIdSchema, providerSettingsSchema)
            .default({}),
    })
    .strict()
    .superRefine((preferences, context) => {
        for (const [provider, settings] of Object.entries(
            preferences.remembered,
        )) {
            if (settings.provider !== provider) {
                context.addIssue({
                    code: "custom",
                    message:
                        "Remembered settings belong to a different provider.",
                });
            }
        }
    });

export type ProviderPreferences = z.infer<typeof providerPreferencesSchema>;

export const modelDefinitionSchema = z
    .object({
        provider: providerIdSchema,
        id: z.string().min(1),
        displayName: z.string().min(1),
        tools: z.boolean(),
        streaming: z.boolean(),
        reasoning: z
            .object({
                kind: z.enum(["levels", "fixed"]),
                levels: z.array(reasoningLevelSchema.exclude(["default"])),
                documentedDefault: reasoningLevelSchema
                    .exclude(["default"])
                    .optional(),
            })
            .strict(),
        contextTokens: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        sources: z.array(z.string().url()).min(1),
        reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .strict()
    .superRefine((model, context) => {
        const { levels, kind, documentedDefault } = model.reasoning;
        if (
            new Set(levels).size !== levels.length ||
            (kind === "fixed" && levels.length > 0) ||
            (kind === "levels" && levels.length === 0) ||
            (documentedDefault && !levels.includes(documentedDefault))
        ) {
            context.addIssue({
                code: "custom",
                message: "Inconsistent model reasoning capabilities.",
            });
        }
    });
export type ModelDefinition = z.infer<typeof modelDefinitionSchema>;
