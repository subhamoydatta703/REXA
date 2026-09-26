import type { LLMProvider } from "../providers/LLMProvider";
import type { ToolRegistry } from "../tools/ToolRegistry";
import type { ExecutionManager } from "../tools/ExecutionManager";
import { type GuardrailContext } from "../guardrails/types/GuardrailContext";
import { InputGuardrails } from "../guardrails/input/InputGuardrails";
import { OutputGuardrails } from "../guardrails/output/OutputGuardrails";
import { logger } from "../logger/AgentLogger";
import { sandboxManager } from "../tools/ExecutionManager";
import { ResearchAgentPrompt } from "./ReseatchAgentSystemPrompt";
import type { LLMResponse } from "../providers/LLMResponse";
import { type ResearchMessage } from "./Message";

export class ResearchAgent {

    private llm: LLMProvider;
    private registry: ToolRegistry;
    private sandbox: ExecutionManager;
    private messages: ResearchMessage[] = [];
    private maxSteps: number;
    private name: string;
    private inputGuardrails: InputGuardrails;
    private outputGuardrails: OutputGuardrails;

    constructor(llm: LLMProvider, registry: ToolRegistry, maxSteps: number = 60, name: string = "ResearchAgent", sandbox: ExecutionManager = sandboxManager, apiKey?: string) {
        this.llm = llm;
        this.registry = registry;
        this.maxSteps = maxSteps;
        this.name = name;
        this.sandbox = sandbox;
        this.inputGuardrails = new InputGuardrails(apiKey);
        this.outputGuardrails = new OutputGuardrails(apiKey);
    }


    private systemPrompt: string = ResearchAgentPrompt;
    async execute(input: string) {
        const runID = crypto.randomUUID();
        logger.debug(`Agent run started`, { runID, agent: this.name });
        const context: GuardrailContext = {
            agentName: this.name,
            input: input,
            timestamp: new Date(),
        };

        const inputValidation = await this.inputGuardrails.validate(context);
        if (inputValidation.isSafe === false) {
            throw new Error(inputValidation.reason);
        }


        try {
            this.messages.push({ agentName: this.name, runID, role: "user", content: input });
            logger.debug(`User input received`, { length: input.length });
            const searchTool = this.registry.getTool("search");
            const tools = searchTool ? [searchTool] : [];
            let stepCount = 0


            while (stepCount < this.maxSteps) {
                stepCount++

                const response = await this.llm.generate(this.messages, tools, this.systemPrompt);

                if (!response.toolcalls || response.toolcalls.length === 0) {
                    this.messages.push({ agentName: this.name, runID, role: "model", content: response.text });

                    const finalResponse = await this.outputGuardrails.outputValidation(response);
                    if (finalResponse.isSafe) {
                        return response;
                    }
                    return { reason: finalResponse.reason, text: finalResponse.text };
                }
                this.messages.push({
                    agentName: this.name,
                    runID,
                    role: "model",
                    parts: response.rawParts
                });

                for (const toolCall of response.toolcalls) {
                    const tool = this.registry.getTool(toolCall.name);
                    if (!tool) {
                        this.messages.push({
                            agentName: this.name,
                            runID,
                            role: "tool",
                            parts: [{
                                functionResponse: {
                                    name: toolCall.name,
                                    response: { result: `Tool ${toolCall.name} not found` }
                                }
                            } as any]
                        });
                        continue;
                    }

                    const params = (toolCall.params || {}) as Record<string, any>;
                    logger.tool(toolCall.name, "running", `[query: "${params.query || ""}"]`);
                    const startTime = Date.now();

                    let result;
                    try {
                        result = await tool?.execute(params);
                    } catch (error: any) {
                        result = `Error executing tool: ${error instanceof Error ? error.message : String(error)}`;
                    }

                    const duration = ((Date.now() - startTime) / 1000).toFixed(1) + "s";
                    logger.tool(toolCall.name, "done", `(${duration})`);

                    this.messages.push({
                        agentName: this.name,
                        runID,
                        role: "tool",
                        parts: [{
                            functionResponse: {
                                name: toolCall.name,
                                response: { result }
                            }
                        } as any]
                    });
                }
            }

            logger.error(`ResearchAgent exceeded maximum step limit (${this.maxSteps})`);
            throw new Error(`ResearchAgent exceeded maximum execution step limit of ${this.maxSteps}.`);
        } catch (error: any) {
            logger.error(
                `ResearchAgent execution failed`,
                error instanceof Error ? error.message : String(error)
            );
            throw error;
        }
    }
}

