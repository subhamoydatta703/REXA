import { input, password } from "@inquirer/prompts";

export type OptionalApiProvider = "tavily" | "brightData";

interface ProviderSetup {
    id: OptionalApiProvider;
    name: string;
    description: string;
    command: string;
}

const PROVIDERS: ProviderSetup[] = [
    {
        id: "tavily",
        name: "Tavily",
        description:
            "Enables Tavily web search and page-extraction fallback. Without this key, web search uses DuckDuckGo.",
        command: "rexa config set-tavily-key",
    },
    {
        id: "brightData",
        name: "Bright Data",
        description:
            "Enables structured extraction of LinkedIn personal profiles. Without this key, that extraction is unavailable. Provider access and credits are required.",
        command: "rexa config set-brightdata-key",
    },
];

export interface OptionalApiSetupDependencies {
    interactive: boolean;
    getKey: (provider: OptionalApiProvider) => Promise<string | undefined>;
    isComplete: (provider: OptionalApiProvider) => Promise<boolean>;
    markComplete: (provider: OptionalApiProvider) => Promise<void>;
    saveKey: (provider: OptionalApiProvider, key: string) => Promise<void>;
    ask: (message: string) => Promise<string>;
    readKey: (message: string) => Promise<string>;
    print: (message: string) => void;
}

export function validateOptionalApiAnswer(answer: string): true | string {
    return answer === "Y" || answer === "N" ? true : "Please enter Y or N.";
}

/** Optional onboarding only: explicit configuration commands remain available. */
export class OptionalApiSetup {
    constructor(private dependencies: OptionalApiSetupDependencies) {}

    private async askYesOrNo(message: string): Promise<"Y" | "N"> {
        for (;;) {
            const answer = await this.dependencies.ask(message);
            if (answer === "Y" || answer === "N") {
                return answer;
            }
            this.dependencies.print("Please enter Y or N.");
        }
    }

    private async remember(provider: ProviderSetup): Promise<void> {
        try {
            await this.dependencies.markComplete(provider.id);
        } catch {
            this.dependencies.print(
                `Could not remember the ${provider.name} setup decision. You may be asked again next launch.`,
            );
        }
    }

    private async configure(provider: ProviderSetup): Promise<void> {
        const setup = this.dependencies;
        if (await setup.getKey(provider.id)) {
            return;
        }
        if (await setup.isComplete(provider.id)) {
            return;
        }
        setup.print(
            `\n${provider.name} API key — Optional\n${provider.description}\nYou can add or change it later with: ${provider.command}`,
        );
        let answer: "Y" | "N";
        try {
            answer = await this.askYesOrNo(
                `Would you like to enter a ${provider.name} API key? [Y/N]:`,
            );
        } catch {
            setup.print(
                `${provider.name} setup cancelled. Continuing without a new key.`,
            );
            return;
        }
        if (answer === "N") {
            await this.remember(provider);
            return;
        }
        let key: string;
        try {
            key = (
                await setup.readKey(
                    `Enter your ${provider.name} API key (optional):`,
                )
            ).trim();
        } catch {
            setup.print(
                `${provider.name} key entry cancelled. Continuing without a new key.`,
            );
            return;
        }
        if (!key) {
            setup.print(`No ${provider.name} key entered. Nothing was saved.`);
            return;
        }
        try {
            await setup.saveKey(provider.id, key);
        } catch {
            // Storage exceptions could contain the key; show only a safe message.
            setup.print(
                `Could not save the ${provider.name} API key. Setup remains incomplete; you can retry with ${provider.command}.`,
            );
            return;
        }
        await this.remember(provider);
    }

    async run(): Promise<void> {
        if (!this.dependencies.interactive) {
            return;
        }
        for (const provider of PROVIDERS) {
            try {
                await this.configure(provider);
            } catch {
                this.dependencies.print(
                    `Could not load ${provider.name} setup settings. Skipping optional setup for this provider.`,
                );
            }
        }
    }
}

export async function runOptionalApiSetup(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        return;
    }
    const { ConfigManager } = await import("../config/ConfigManager");
    const setup = new OptionalApiSetup({
        interactive: true,
        getKey: (provider) =>
            provider === "tavily"
                ? ConfigManager.getTavilyApiKey()
                : ConfigManager.getBrightDataApiKey(),
        isComplete: (provider) =>
            ConfigManager.isOptionalApiSetupComplete(provider),
        markComplete: (provider) =>
            ConfigManager.completeOptionalApiSetup(provider),
        saveKey: (provider, key) =>
            provider === "tavily"
                ? ConfigManager.setTavilyApiKey(key)
                : ConfigManager.setBrightDataApiKey(key),
        ask: (message) =>
            input({ message, validate: validateOptionalApiAnswer }),
        readKey: (message) => password({ message, mask: "*" }),
        print: (message) => console.log(message),
    });
    await setup.run();
}
