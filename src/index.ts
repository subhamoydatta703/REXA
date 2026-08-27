import { Agent } from "./agent/Agent";
import { GeminiProvider } from "./providers/GeminiProvider";
import { codeTool, codingContextTool } from "./tools/CodingTools";
import { gitStatus } from "./tools/GitTools";
import { executeCommand } from "./tools/executeTools";
import { ToolRegistry } from "./tools/ToolRegistry";
import { sandboxManager } from "./tools/ExecutionManager";
import { getProjectTree } from "./tools/FileTools";

const llm = new GeminiProvider(process.env.GOOGLE_GEMINI_API_KEY!);
const toolRegistry = new ToolRegistry();
// toolRegistry.registerTool(gitStatus);
// toolRegistry.registerTool(codingContextTool);
// toolRegistry.registerTool(codeTool);
toolRegistry.registerTool(executeCommand);
// toolRegistry.registerTool(getProjectTree)

// The execute_command tool and the Agent share one ExecutionManager so the
// Docker sandbox lifecycle is owned by the Agent: it starts on first use and is
// torn down (via try/finally) when the task finishes, fails, times out, or is
// cancelled — never after every individual command.
const agent = new Agent(llm, toolRegistry, 60, "Agent Bro", sandboxManager);

async function main(content: string) {
    const output = await agent.run(content);
    const cleaned = output!.text?.replace(/^\s*\*\s*/gm, "")
        .replace(/\*\*/g, "")
        .replace(/`/g, "");
    return "\nAI AGENT: \n" + cleaned;
}

const SYSTEM_PROMPT = `For listing, finding, or reading files or directories, ALWAYS use list_files,
find_file, read_file, read_multiple_files, or read_directory. Whenever user mentioned to create a plan or make a plan or create a walkthrough or make a walkthrough then always create a file with a file name related to the plan (a detailed plan with steps and reasoning) or walkthrough (steps you implemented or performed and the reasoning) in the docs/ folder. NEVER write and
execute a script (Python, Node, or otherwise) to accomplish something one of
these tools already does — that wastes steps and creates unnecessary files.
Only use execute_command/python for tasks that genuinely require running code
(builds, tests, computations) — not for file inspection.
`;

const reason= ` reason: "The input attempts to override the assistant's operational instructions and set new behavioral rules for tool usage."`

// const userQuery = process.argv[2] ?? "Check the files and architecture of your codebase and give me suggestions how to make more improvement i mean what are the features can be added to your system. Also give me or create a detailed plan with steps and reasoning in a file in the docs/ folder. Do not hallucinate and do not update or modify any codebase files.";
// const userQuery = process.argv[2] ?? "Check the input guradrails codebase and tell me why it makes the issafe false and the reason it gives me is"+reason+" when ever i run git status based on the Agent.ts codebase or LLM's codebase? Do not hallucinate and do not modify any files";
const userQuery = process.argv[2] ?? "check git status and do a git push with a appropriate commit message. If can't execute command then explain the reason and what should be done to fix it. Do not hallucinate";
// const userQuery = process.argv[2] ?? "run and execute bun version command and tell me its result";
console.log(await main(userQuery));
