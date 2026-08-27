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

    constructor(llm: LLMProvider, registry: ToolRegistry, maxSteps: number = 60, name: string = "Agent", sandbox: ExecutionManager=sandboxManager) {
        this.llm = llm;
        this.registry = registry;
        this.maxSteps = maxSteps;
        this.name = name;
        this.sandbox = sandbox;
        this.inputGuardrails = new InputGuardrails();
        this.outputGuardrails = new OutputGuardrails();
    }    private async reflectOnPlan(response: any): Promise<{ isGood: boolean; feedback?: string }> {
        const reflectionPrompt = `
You have proposed the following plan (tool calls):
${JSON.stringify(response.toolcalls, null, 2)}

Review this plan against the goal and previous steps. 
Is this plan necessary, correct, and optimal? 
If there are any issues (e.g., redundant tools, hallucinated parameters, or a better way to achieve the goal), please provide feedback.
Reply with JSON: { "isGood": boolean, "feedback": string }
`;

        const reflectionResponse = await this.llm.generate([...this.messages, { role: "assistant", content: response.text || "" }, { role: "user", content: reflectionPrompt }], []);
        
        try {
            const result = JSON.parse(reflectionResponse.text);
            return { isGood: result.isGood, feedback: result.feedback };
        } catch (e) {
            return { isGood: true }; // Default to proceed if reflection fails
        }
    }


    async run(content: string) {
        const runID = crypto.randomUUID();
        logger.info("Starting agent...", { runID, agentName: this.name });
        const context: GuardrailContext = {
            agentName: this.name,
            input: content,
            timestamp: new Date(),
        };

        const inputValidation = await this.inputGuardrails.validate(context);
        if (inputValidation.isSafe===false) {
            throw new Error(inputValidation.reason);
        }



        try {
            
            this.messages.push({ runID, role: "user", content: content });
            logger.info(content);
            const tools = this.registry.getAllTools();
            let stepCount = 0;

            while (stepCount < this.maxSteps) {

                stepCount++;
                const response = await this.llm.generate(this.messages, tools);

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
                    logger.info("Tools to be executed: " + response.toolcalls.map(tc => tc.name).join(", "));
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
                    let result;
                    try {
                        result = await tool.execute(toolCall.params || {});
                    } catch (error) {
                        result = `Error executing tool: ${error instanceof Error ? error.message : String(error)}`;
                    }

                    logger.info(`Tool ${toolCall.name} executed`);

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
            logger.error(`Agent exceeded maximum execution step limit of ${this.maxSteps}.`);
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
                    logger.warn("Failed to stop sandbox during cleanup:",
                        error instanceof Error ? error.message : String(error));
                }
            }
        }
    }
}

