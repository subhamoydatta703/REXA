import { z } from "zod";
import {
    modelDefinitionSchema,
    providerIdSchema,
    providerSettingsSchema,
    type ModelDefinition,
    type ProviderId,
    type ProviderSettings,
} from "./ProviderSettings";
import { geminiModels } from "./gemini/models";
import { openAIModels } from "./openai/models";
import { claudeModels } from "./claude/models";
import { waitWithCancellation } from "../utils/Cancellation";

const CACHE_LIFETIME_MS = 15 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 10000;
const discoveredIdsSchema = z.array(z.string().min(1).max(200)).max(500);

export interface CatalogListing {
    models: ModelDefinition[];
    source: "catalog" | "discovery" | "cache";
    warning?: string;
}

/** Verified capabilities are authoritative; discovery only narrows account visibility. */
export class ModelCatalog {
    private models: ModelDefinition[];
    private cache = new Map<ProviderId, { ids: string[]; expiresAt: number }>();

    constructor(
        definitions: ModelDefinition[] = [
            ...geminiModels,
            ...openAIModels,
            ...claudeModels,
        ],
        private now = () => Date.now(),
    ) {
        this.models = definitions.map((model) =>
            modelDefinitionSchema.parse(model),
        );
        const keys = this.models.map(
            (model) => `${model.provider}/${model.id}`,
        );
        if (new Set(keys).size !== keys.length) {
            throw new Error("Duplicate provider/model catalog entry.");
        }
    }

    list(provider: ProviderId): ModelDefinition[] {
        providerIdSchema.parse(provider);
        return structuredClone(
            this.models.filter((model) => model.provider === provider),
        );
    }

    validateSettings(input: unknown): ProviderSettings {
        const selection = providerSettingsSchema.parse(input);
        const model = this.models.find(
            (entry) =>
                entry.provider === selection.provider &&
                entry.id === selection.model,
        );
        if (!model) {
            throw new Error("Unknown model for the selected provider.");
        }
        if (!model.tools || !model.streaming) {
            throw new Error(
                "This model does not support the required coding tool/streaming capabilities.",
            );
        }
        if (
            selection.reasoning !== "default" &&
            !model.reasoning.levels.includes(selection.reasoning)
        ) {
            throw new Error(
                "The selected model does not support this reasoning level.",
            );
        }
        return selection;
    }

    /** The future provider adapters supply discovery; this class never handles keys. */
    async discover(
        provider: ProviderId,
        fetchIds: (signal: AbortSignal) => Promise<string[]>,
        options: { refresh?: boolean; signal?: AbortSignal } = {},
    ): Promise<CatalogListing> {
        const known = this.list(provider);
        options.signal?.throwIfAborted();
        const cached = this.cache.get(provider);
        if (!options.refresh && cached && cached.expiresAt > this.now()) {
            return this.filterDiscovery(known, cached.ids, "cache");
        }
        const deadline = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
        const signal = options.signal
            ? AbortSignal.any([options.signal, deadline])
            : deadline;
        try {
            const discovered = await waitWithCancellation(
                fetchIds(signal),
                signal,
            );
            const ids = discoveredIdsSchema.parse(discovered);
            options.signal?.throwIfAborted();
            this.cache.set(provider, {
                ids: [...new Set(ids)],
                expiresAt: this.now() + CACHE_LIFETIME_MS,
            });
            return this.filterDiscovery(known, ids, "discovery");
        } catch {
            options.signal?.throwIfAborted();
            if (cached) {
                return {
                    ...this.filterDiscovery(known, cached.ids, "cache"),
                    warning:
                        "Discovery failed; using cached model visibility. Account access may have changed.",
                };
            }
            return {
                models: known,
                source: "catalog",
                warning:
                    "Discovery unavailable; showing verified catalog entries. Account access is not confirmed.",
            };
        }
    }

    private filterDiscovery(
        known: ModelDefinition[],
        ids: string[],
        source: CatalogListing["source"],
    ): CatalogListing {
        const visible = new Set(ids);
        return {
            models: known.filter((model) => visible.has(model.id)),
            source,
            warning:
                "Listed models have verified capabilities; successful API access is not guaranteed.",
        };
    }
}
