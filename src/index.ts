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

// Set up CLI arguments using Commander
const program = new Command();
program
    .name("rexa")
    .description("REXA AI Agent CLI")
    .version("1.0.0")
    .option("-m, --max-steps <number>", "Max steps per task", "60")
    .option("-n, --name <string>", "Agent name", "REXA")
    .parse(process.argv);

const options = program.opts();

// Initialize Agent
const llm = new GeminiProvider(process.env.GOOGLE_GEMINI_API_KEY!);
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
cli.start();
