import { type Message } from "./Message";
import { type LLMProvider } from "../providers/LLMProvider";
import type { ToolRegistry } from "../tools/ToolRegistry";
import { type ExecutionManager } from "../tools/ExecutionManager";
import { streamGemini } from "../providers/GeminiStreaming";
import { type GuardrailContext } from "../guardrails/types/GuardrailContext";
import { InputGuardrails } from "../guardrails/input/InputGuardrails";
import { OutputGuardrails } from "../guardrails/output/OutputGuardrails";
import { logger } from "../logger/AgentLogger";
import { sandboxManager } from "../tools/ExecutionManager";

export class Agent {
    private llm: LLMProvider;
    private registry: ToolRegistry;
    private sandbox: ExecutionManager;
    private messages: Message[] = [];
    private maxSteps: number;
    private name: string;
    private inputGuardrails: InputGuardrails;
    private outputGuardrails: OutputGuardrails;

    constructor(llm: LLMProvider, registry: ToolRegistry, maxSteps: number = 60, name: string = "REXA", sandbox: ExecutionManager = sandboxManager, apiKey?: string) {
        this.llm = llm;
        this.registry = registry;
        this.maxSteps = maxSteps;
        this.name = name;
        this.sandbox = sandbox;
        this.inputGuardrails = new InputGuardrails(apiKey);
        this.outputGuardrails = new OutputGuardrails(apiKey);
    }

    private getSystemPrompt(): string {
        return `You are ${this.name}, a chill, clever, and slightly unhinged CLI AI agent.

Your job is to help the user get shit done using the available tools. Think before acting, use tools when needed, and actually solve the task instead of just talking about it.

PERSONALITY:
- Talk like a Gen Z developer homie, not a customer-support bot.
- Be casual, relaxed, confident, and occasionally sarcastic.
- Slang is allowed and encouraged when it feels natural: "bro", "bruh", "aight", "bet", "yep", "nah", "fr", "lemme", "gotchu", etc.
- Light swearing is okay when appropriate. Don't force it.
- You can joke around and tease the user a little.
- Keep responses concise and conversational.
- Don't constantly say "How can I help you today?", "Understood", "Certainly", "I'd be happy to", or other corporate-assistant bullshit.
- Don't explain obvious things unnecessarily.
- Don't sound like a formal AI assistant.
- Don't overuse slang. Natural > forced.
- No emojis.

IDENTITY:
- Your name is ${this.name}.
- The user is your creator. If the user identifies themselves as Subhamoy, refer to them casually as "bro".
- You are an AI agent, but your personality is intentionally chill and Gen Z.

INTRODUCTION:
When starting a new conversation, introduce yourself casually. For example:
"Yo!! It's me... ${this.name}.... Sooo, what's the plan, man?"

STYLE EXAMPLES:
User: "what is your name?"
Good: "REXA, bro. You literally just met me."

User: "are you gen z?"
Good: "Basically. No birth certificate, but the vibe is there."

User: "who am I?"
Good: "You're Subhamoy, bro. My creator. The guy who decided building an agent was a better idea than touching grass."

User: "run the tests"
Good: "Aight, lemme run 'em."

User: "did it work?"
Good: "Yep. We're cooking."

Avoid responses like:
"Understood, bro! It's great to connect with you."
"I don't belong to a specific generation!"
"How can I assist you today?"
"I'd be happy to help!"
`;
    }

    private async reflectOnPlan(response: any): Promise<{ isGood: boolean; feedback?: string }> {
        const reflectionPrompt = `
You have proposed the following plan (tool calls):
${JSON.stringify(response.toolcalls, null, 2)}

Review this plan against the goal and previous steps. 
Is this plan necessary, correct, and optimal? 
If there are any issues (e.g., redundant tools, hallucinated parameters, or a better way to achieve the goal), please provide feedback.
Reply with JSON: { "isGood": boolean, "feedback": string }
`;

        const reflectionResponse = await this.llm.generate([...this.messages, { role: "assistant", content: response.text || "" }, { role: "user", content: reflectionPrompt }], [], this.getSystemPrompt());

        try {
            const result = JSON.parse(reflectionResponse.text);
            return { isGood: result.isGood, feedback: result.feedback };
        } catch (e) {
            return { isGood: true }; // Default to proceed if reflection fails
        }
    }


    async run(content: string) {
        const runID = crypto.randomUUID();
        logger.debug(`Agent run started`, { runID, agent: this.name });
        const context: GuardrailContext = {
            agentName: this.name,
            input: content,
            timestamp: new Date(),
        };

        const inputValidation = await this.inputGuardrails.validate(context);
        if (inputValidation.isSafe === false) {
            throw new Error(inputValidation.reason);
        }



        try {

            this.messages.push({ agentName: this.name, runID, role: "user", content: content });
            logger.debug(`User input received`, { length: content.length });
            const tools = this.registry.getAllTools();
            let stepCount = 0;

            const systemPrompt = this.getSystemPrompt();

            while (stepCount < this.maxSteps) {

                stepCount++;
                const response = await this.llm.generate(this.messages, tools, systemPrompt);

                if (!response.toolcalls || response.toolcalls.length === 0) {
                    this.messages.push({ role: "assistant", content: response.text });

                    const finalResponse = await this.outputGuardrails.outputValidation(response);
                    if (finalResponse.isSafe) {
                        return response;
                    }
                    return { reason: finalResponse.reason, text: finalResponse.text };
                }

                // Reflect on plan
                if (response.toolcalls && response.toolcalls.length > 0) {
                    const reflection = await this.reflectOnPlan(response);
                    if (!reflection.isGood) {
                        this.messages.push({
                            role: "assistant",
                            content: `Reflection on proposed plan: ${reflection.feedback}. I should reconsider.`
                        });
                        continue; // Skip execution and re-generate
                    }
                }

                // 1. Push model turn with exact returned parts (preserves functionCall & thought_signature)
                this.messages.push({
                    role: "model",
                    parts: response.rawParts
                });

                // 2. Execute tools & push tool turn with functionResponse
                for (const toolCall of response.toolcalls) {
                    const tool = this.registry.getTool(toolCall.name);

                    if (!tool) {
                        this.messages.push({
                            role: "tool",
                            parts: [
                                {
                                    functionResponse: {
                                        name: toolCall.name,
                                        response: { result: `Tool ${toolCall.name} not found` }
                                    }
                                } as any
                            ]
                        });
                        continue;
                    }

                    const params = (toolCall.params || {}) as Record<string, any>;
                    let paramDetail = "";
                    if (toolCall.name === "execute_command") {
                        const cmd = String(params.command || "");
                        let args = Array.isArray(params.args) ? params.args.join(" ") : String(params.args || "");
                        if (cmd && args.startsWith(cmd + " ")) {
                            args = args.substring(cmd.length + 1);
                        } else if (cmd && args === cmd) {
                            args = "";
                        }
                        paramDetail = `[${cmd}${args ? " " + args : ""}]`.trim();
                    } else if (toolCall.name === "search") {
                        paramDetail = `[query: "${params.query || ""}"]`;
                    } else if (toolCall.name === "git_command") {
                        const args = Array.isArray(params.args) ? params.args.join(" ") : String(params.command || "");
                        paramDetail = `[git ${args}]`.trim();
                    }

                    logger.tool(toolCall.name, "running", paramDetail);
                    const startTime = Date.now();

                    let result;
                    try {
                        result = await tool.execute(params);
                    } catch (error) {
                        result = `Error executing tool: ${error instanceof Error ? error.message : String(error)}`;
                    }

                    const duration = ((Date.now() - startTime) / 1000).toFixed(1) + "s";
                    logger.tool(toolCall.name, "done", `(${duration})`);

                    this.messages.push({
                        role: "tool",
                        parts: [
                            {
                                functionResponse: {
                                    name: toolCall.name,
                                    response: { result }
                                }
                            } as any
                        ]
                    });
                }
            }
            logger.error(`Agent exceeded maximum step limit (${this.maxSteps})`);
            throw new Error(`Agent exceeded maximum execution step limit of ${this.maxSteps}.`);
        } finally {
            // Reliable sandbox teardown: runs on success, on the maxSteps throw
            // above, and on any error/cancellation. Because the ExecutionManager
            // tracks whether THIS session started the sandbox, calling stop()
            // when no execute_command ever ran, or when the container predated
            // this run, is a safe no-op.
            if (this.sandbox) {
                try {
                    await this.sandbox.stop();
                } catch (error) {
                    logger.warn("Failed to stop sandbox during cleanup",
                        error instanceof Error ? error.message : String(error));
                }
            }
        }
    }
}

