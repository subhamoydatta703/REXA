#!/usr/bin/env bun
import { Agent } from "./agent/Agent";
import { GeminiProvider } from "./providers/GeminiProvider";
import { codeTool, codingContextTool } from "./tools/CodingTools";
import { gitCommand } from "./tools/GitTools";
import { executeCommand } from "./tools/executeTools";
import { ToolRegistry } from "./tools/ToolRegistry";
import { getProjectTree } from "./tools/FileTools";
import { search } from "./tools/SearchTool";
import { CLI } from "./cli/AgentCLI";

const llm = new GeminiProvider(process.env.GOOGLE_GEMINI_API_KEY!);
const toolRegistry = new ToolRegistry();
toolRegistry.registerTool(gitCommand);
toolRegistry.registerTool(codingContextTool);
toolRegistry.registerTool(codeTool);
toolRegistry.registerTool(executeCommand);
toolRegistry.registerTool(getProjectTree)
toolRegistry.registerTool(search)

const agent1 = new Agent(llm, toolRegistry, 60);


const cli = new CLI(agent1);
cli.start();

// The execute_command tool and the Agent share one ExecutionManager so the
// Docker sandbox lifecycle is owned by the Agent: it starts on first use and is
// torn down (via try/finally) when the task finishes, fails, times out, or is
// cancelled — never after every individual command.
// const agent = new Agent(llm, toolRegistry, 60, "Agent Bro");

// async function main(content: string) {
//     const output = await agent.run(content);
//     const cleaned = output!.text?.replace(/^\s*\*\s*/gm, "")
//         .replace(/\*\*/g, "")
//         .replace(/`/g, "");
//     return "\nAI AGENT: \n" + cleaned;
// }





// // const userQuery = process.argv[2] ?? "Read the codebase and make a detailed list (create a file) on /docs about What are the features we can implement in this project to make it more real. Do not hallucinate and Do not update any codebase files";
// // const userQuery = process.argv[2] ?? "Read the codebase and and make a detailed list (create a file) on /docs for the question : should i use graph database or vectordatabase? Do not hallucinate and do not change any codebase files";
// const userQuery = process.argv[2] ?? "Read the codebase and and make a detailed list (create a file) on /docs for the question : How to make this whole agent system cli based? Do not hallucinate and do not change any codebase files";

// console.log(await main(userQuery));
