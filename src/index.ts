#!/usr/bin/env bun
import { Command } from "commander";
import { Agent } from "./agent/Agent";
import { CLI } from "./cli/AgentCLI";
import { GeminiProvider } from "./providers/gemini/GeminiProvider";
import { codeTool, codingContextTool } from "./tools/CodingTools";
import { defaultExecutionTools } from "./tools/executeTools";
import { sandboxManager } from "./tools/ExecutionManager";
import { getProjectTree } from "./tools/FileTools";
import { gitCommand } from "./tools/GitTools";
import { search } from "./tools/SearchTool";
import { readUrl } from "./tools/ReadUrlTool";
import { Orchestrator } from "./orchestration/Orchestrator";
import { Supervisor } from "./orchestration/Supervisor";
import { ResearchAgent } from "./agent/ResearchAgent";
import { InputGuardrails } from "./guardrails/input/InputGuardrails";

import { saveMemory, searchMemory } from "./tools/MemoryTools";
import { ToolRegistry } from "./tools/ToolRegistry";
import { repositoryTools } from "./tools/RepositoryTools";
import { editor } from "./tools/SafeEditor";
import { SessionStore } from "./sessions/SessionStore";
import { LocalCommands } from "./cli/LocalCommands";
import { PermissionService, setPermissions } from "./tools/PermissionService";
import { ConfigManager } from "./config/ConfigManager";
import { runOptionalApiSetup } from "./cli/OptionalApiSetup";
import { ProviderSetup } from "./cli/ProviderSetup";
import { parseProviderId } from "./providers/ProviderSettings";
import { DEFAULT_GEMINI_MODEL } from "./providers/gemini/GeminiProtocol";
import { ModelCatalog } from "./providers/ModelCatalog";
import { EvaluationStore } from "./evaluation/EvaluationStore";
import { EvaluationTracker } from "./evaluation/EvaluationTracker";
import { EvaluationCommands } from "./evaluation/EvaluationCommands";

import { password } from "@inquirer/prompts";
import chalk from "chalk";

async function main() {
    const program = new Command();

    program
        .name("rexa")
        .description("REXA AI Agent CLI")
        .version("2.0.0")
        .option(
            "--continue",
            "Resume the latest saved conversation in this project",
        )
        .option("--resume <id>", "Resume a saved conversation by ID")
        .option("-m, --max-steps <number>", "Max steps per task", "60")
        .option("-n, --name <string>", "Agent name", "REXA")
        .option(
            "-k, --set-key [string]",
            "Set or update Gemini API key (masked input if omitted)",
        )
        .option(
            "-t, --set-tavily-key [string]",
            "Set or update optional Tavily Search API key (masked input if omitted)",
        );

    // Subcommand: rexa config set-key [key]
    const configCmd = program
        .command("config")
        .description("Manage REXA CLI configuration");

    configCmd
        .command("set-provider-key <provider>")
        .description(
            "Save a Gemini, OpenAI, or Anthropic API key using masked input",
        )
        .action(async (providerName: string) => {
            const provider = parseProviderId(providerName);
            if (!process.stdin.isTTY || !process.stdout.isTTY) {
                throw new Error(
                    "Use an interactive terminal for masked key entry, or set the provider API key environment variable.",
                );
            }
            let key: string;
            try {
                key = await password({
                    message: `Enter your ${provider} API key:`,
                    mask: "*",
                });
            } catch {
                return;
            }
            if (key.trim()) {
                await ConfigManager.setProviderApiKey(provider, key);
            }
        });

    configCmd
        .command("set-provider <provider>")
        .description(
            "Save provider/model/reasoning preferences (requires an available runtime adapter to run)",
        )
        .option("--model <id>", "Exact supported model ID")
        .option("--reasoning <level>", "Supported effort level, or default")
        .action(
            async (
                providerName: string,
                options: { model?: string; reasoning?: string },
            ) => {
                const setup = new ProviderSetup({
                    interactive: Boolean(
                        process.stdin.isTTY && process.stdout.isTTY,
                    ),
                    getPreferences: () =>
                        ConfigManager.getProviderPreferences(),
                    getKey: (provider) =>
                        ConfigManager.getProviderApiKey(provider),
                    readKey: (provider) =>
                        password({
                            message: `Enter your ${provider} API key:`,
                            mask: "*",
                        }),
                    saveKey: (provider, key) =>
                        ConfigManager.setProviderApiKey(provider, key),
                    saveSettings: (settings) =>
                        ConfigManager.setProviderSettings(settings),
                });
                const result = await setup.configure(providerName, options);
                if (result.status === "saved") {
                    console.log(
                        `Saved provider: ${result.settings.provider}; model: ${result.settings.model}; reasoning: ${result.settings.reasoning}.`,
                    );
                    if (
                        result.settings.provider !== "gemini" ||
                        result.settings.reasoning !== "default"
                    ) {
                        console.log(
                            "These settings are saved, but this build does not yet have the required runtime adapter/settings support.",
                        );
                    }
                }
            },
        );

    configCmd
        .command("show-provider")
        .description("Show saved provider preferences without credentials")
        .action(async () => {
            const preferences = await ConfigManager.getProviderPreferences();
            console.log(JSON.stringify(preferences, null, 2));
        });
    configCmd
        .command("set-key [key]")
        .description("Set or update your Gemini API key securely")
        .action(async (key?: string) => {
            if (!key || typeof key !== "string" || !key.trim()) {
                try {
                    key = await password({
                        message: chalk.bold.yellow(
                            "  ❯ Enter your Gemini API Key:",
                        ),
                        mask: "*",
                    });
                } catch {
                    process.exit(0);
                }
            }
            if (key) {
                await ConfigManager.setGeminiApiKey(key);
            }
            process.exit(0);
        });

    program
        .command("login")
        .description("Sign in with a CLI token from the REXA website")
        .action(async () => {
            await ConfigManager.clearCliAuthToken({ silent: true });
            await ConfigManager.ensureCliAuth();
            process.exit(0);
        });

    program
        .command("logout")
        .description("Remove the saved REXA website auth token")
        .action(async () => {
            await ConfigManager.clearCliAuthToken();
            process.exit(0);
        });

    configCmd
        .command("set-tavily-key [key]")
        .description("Set or update optional Tavily Search API key securely")
        .action(async (key?: string) => {
            if (!key || typeof key !== "string" || !key.trim()) {
                try {
                    key = await password({
                        message: chalk.bold.yellow(
                            "  ❯ Enter your Tavily Search API Key:",
                        ),
                        mask: "*",
                    });
                } catch {
                    process.exit(0);
                }
            }
            if (key) {
                await ConfigManager.setTavilyApiKey(key);
            }
            process.exit(0);
        });

    configCmd
        .command("set-brightdata-key")
        .description(
            "Save the optional Bright Data API key for LinkedIn profile extraction",
        )
        .action(async () => {
            let key: string;
            try {
                key = await password({
                    message: "Enter your Bright Data API key:",
                    mask: "*",
                });
            } catch {
                process.exit(0);
            }
            await ConfigManager.setBrightDataApiKey(key);
            process.exit(0);
        });

    // Default action when running 'rexa' (starting the interactive CLI agent)
    program.action(async (options) => {
        if (options.setKey) {
            let key =
                typeof options.setKey === "string" ? options.setKey : undefined;
            if (!key) {
                try {
                    key = await password({
                        message: chalk.bold.yellow(
                            "  ❯ Enter your Gemini API Key:",
                        ),
                        mask: "*",
                    });
                } catch {
                    process.exit(0);
                }
            }
            if (key) {
                await ConfigManager.setGeminiApiKey(key);
            }
            process.exit(0);
        }

        if (options.setTavilyKey) {
            let key =
                typeof options.setTavilyKey === "string"
                    ? options.setTavilyKey
                    : undefined;
            if (!key) {
                try {
                    key = await password({
                        message: chalk.bold.yellow(
                            "  ❯ Enter your Tavily Search API Key:",
                        ),
                        mask: "*",
                    });
                } catch {
                    process.exit(0);
                }
            }
            if (key) {
                await ConfigManager.setTavilyApiKey(key);
            }
            process.exit(0);
        }

        const selection = (await ConfigManager.getProviderPreferences()).active;
        if (selection) {
            new ModelCatalog().validateSettings(selection);
            if (selection.provider !== "gemini") {
                throw new Error(
                    `The ${selection.provider} runtime adapter is not available in this build. Your preferences are saved. Choose Gemini with rexa config set-provider gemini.`,
                );
            }
            if (
                selection.model !== DEFAULT_GEMINI_MODEL ||
                selection.reasoning !== "default"
            ) {
                throw new Error(
                    "This build cannot apply the saved Gemini model/reasoning override yet. Use rexa config set-provider gemini --reasoning default.",
                );
            }
        }
        await ConfigManager.ensureCliAuth();

        // Resolve the active Gemini credential; other runtime adapters are added later.
        const apiKey = await ConfigManager.ensureApiKey();
        process.env.GEMINI_API_KEY = apiKey;
        await runOptionalApiSetup();

        // Initialize Agent
        const evaluations = new EvaluationTracker(new EvaluationStore());
        const llm = evaluations.observeProvider(new GeminiProvider(apiKey));
        const toolRegistry = new ToolRegistry();
        setPermissions(await PermissionService.load());
        toolRegistry.registerTool(gitCommand);
        for (const tool of repositoryTools()) toolRegistry.registerTool(tool);
        await editor.checkpoints.recover();
        toolRegistry.registerTool(editor.tool());
        for (const tool of defaultExecutionTools)
            toolRegistry.registerTool(tool);
        toolRegistry.registerTool(search);
        toolRegistry.registerTool(readUrl);
        toolRegistry.registerTool(saveMemory);
        toolRegistry.registerTool(searchMemory);

        const agent = new Agent(
            llm,
            toolRegistry,
            parseInt(options.maxSteps, 10),
            options.name,
            undefined,
            apiKey,
        );

        const researchAgent = new ResearchAgent(
            llm,
            toolRegistry,
            parseInt(options.maxSteps, 10),
            "ResearchAgent",
            undefined,
            apiKey,
        );
        agent.enableSessions(new SessionStore());
        agent.enableVerification(editor.ws);
        let initialMode: "plan" | "act" = "act";
        if (options.continue || options.resume)
            initialMode = (await agent.resumeSession(options.resume)).mode;
        const orchestrator = new Orchestrator(
            new Supervisor(apiKey),
            researchAgent,
            agent,
            new InputGuardrails(apiKey),
        );

        const cli = new CLI(
            {
                run: (content, mode, callbacks) =>
                    evaluations.run(orchestrator, content, mode, callbacks),
            },
            new LocalCommands(
                agent,
                editor.checkpoints,
                undefined,
                undefined,
                new EvaluationCommands(evaluations),
            ),
            initialMode,
        );
        try {
            await cli.start();
        } finally {
            await sandboxManager.stop();
            await agent.closeSession();
        }
    });

    await program.parseAsync(process.argv);
}

main().catch((err) => {
    console.error("Fatal initialization error:", err);
    process.exit(1);
});
