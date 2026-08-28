#!/usr/bin/env bun
import { Command } from "commander";
import { Agent } from "./agent/Agent";
import { CLI } from "./cli/AgentCLI";
import { GeminiProvider } from "./providers/GeminiProvider";
import { codeTool, codingContextTool } from "./tools/CodingTools";
import { executeCommand } from "./tools/executeTools";
import { getProjectTree } from "./tools/FileTools";
import { gitCommand } from "./tools/GitTools";
import { search } from "./tools/SearchTool";
import { ToolRegistry } from "./tools/ToolRegistry";
import { ConfigManager } from "./config/ConfigManager";

async function main() {
    const program = new Command();

    program
        .name("rexa")
        .description("REXA AI Agent CLI")
        .version("1.0.0")
        .option("-m, --max-steps <number>", "Max steps per task", "60")
        .option("-n, --name <string>", "Agent name", "REXA")
        .option("-k, --set-key <string>", "Set or update Gemini API key")
        .option("-t, --set-tavily-key <string>", "Set or update optional Tavily Search API key");

    // Subcommand: rexa config set-key <key>
    const configCmd = program.command("config").description("Manage REXA CLI configuration");
    configCmd
        .command("set-key <key>")
        .description("Set or update your Gemini API key")
        .action(async (key: string) => {
            await ConfigManager.setGeminiApiKey(key);
            process.exit(0);
        });

    configCmd
        .command("set-tavily-key <key>")
        .description("Set or update optional Tavily Search API key")
        .action(async (key: string) => {
            await ConfigManager.setTavilyApiKey(key);
            process.exit(0);
        });

    // Default action when running 'rexa' (starting the interactive CLI agent)
    program.action(async (options) => {
        if (options.setKey) {
            await ConfigManager.setGeminiApiKey(options.setKey);
            process.exit(0);
        }

        if (options.setTavilyKey) {
            await ConfigManager.setTavilyApiKey(options.setTavilyKey);
            process.exit(0);
        }

        // Resolve Gemini API key dynamically across env vars, ~/.rexa/config.json, or prompt user
        const apiKey = await ConfigManager.ensureApiKey();

        // Initialize Agent
        const llm = new GeminiProvider(apiKey);
        const toolRegistry = new ToolRegistry();
        toolRegistry.registerTool(gitCommand);
        toolRegistry.registerTool(codingContextTool);
        toolRegistry.registerTool(codeTool);
        toolRegistry.registerTool(executeCommand);
        toolRegistry.registerTool(getProjectTree);
        toolRegistry.registerTool(search);

        const agent = new Agent(
            llm,
            toolRegistry,
            parseInt(options.maxSteps, 10),
            options.name
        );

        const cli = new CLI(agent);
        await cli.start();
    });

    await program.parseAsync(process.argv);
}

main().catch((err) => {
    console.error("Fatal initialization error:", err);
    process.exit(1);
});
