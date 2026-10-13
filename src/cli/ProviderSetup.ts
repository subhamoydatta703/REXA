import { ModelCatalog } from "../providers/ModelCatalog";
import {
    parseProviderId,
    type ProviderId,
    type ProviderPreferences,
    type ProviderSettings,
} from "../providers/ProviderSettings";

interface ProviderSetupDependencies {
    interactive: boolean;
    getPreferences: () => Promise<ProviderPreferences>;
    getKey: (provider: ProviderId) => Promise<string | undefined>;
    readKey: (provider: ProviderId) => Promise<string>;
    saveKey: (provider: ProviderId, key: string) => Promise<void>;
    saveSettings: (settings: ProviderSettings) => Promise<unknown>;
}

export type ProviderSetupResult =
    { status: "saved"; settings: ProviderSettings } | { status: "cancelled" };

/** Configuration only. Constructing/routing runtime adapters belongs to the provider manager. */
export class ProviderSetup {
    constructor(
        private dependencies: ProviderSetupDependencies,
        private catalog = new ModelCatalog(),
    ) {}

    async configure(
        providerName: string,
        options: { model?: string; reasoning?: string } = {},
    ): Promise<ProviderSetupResult> {
        const provider = parseProviderId(providerName);
        const preferences = await this.dependencies.getPreferences();
        const remembered = preferences.remembered[provider];
        const model =
            options.model ??
            remembered?.model ??
            this.catalog.list(provider)[0]?.id;
        let reasoning = options.reasoning ?? remembered?.reasoning ?? "default";
        if (
            options.model &&
            options.model !== remembered?.model &&
            !options.reasoning
        ) {
            const capability = this.catalog
                .list(provider)
                .find((entry) => entry.id === model);
            const supported = capability?.reasoning.levels.some(
                (level) => level === reasoning,
            );
            if (reasoning !== "default" && !supported) {
                reasoning = "default";
            }
        }
        // Validate the entire candidate before prompts, credential writes, or preference writes.
        const settings = this.catalog.validateSettings({
            provider,
            model,
            reasoning,
        });
        if (!(await this.dependencies.getKey(provider))) {
            if (!this.dependencies.interactive) {
                throw new Error(
                    `Missing ${provider} API key. Run rexa config set-provider-key ${provider} in an interactive terminal or set the provider's API key environment variable.`,
                );
            }
            let key: string;
            try {
                key = (await this.dependencies.readKey(provider)).trim();
            } catch {
                return { status: "cancelled" };
            }
            if (!key) {
                return { status: "cancelled" };
            }
            await this.dependencies.saveKey(provider, key);
        }
        await this.dependencies.saveSettings(settings);
        return { status: "saved", settings };
    }
}
