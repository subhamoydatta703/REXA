import type { LLMProvider } from "../providers/LLMProvider";
import type { ToolRegistry } from "../tools/ToolRegistry";
import type { ExecutionManager } from "../tools/ExecutionManager";
import { InputGuardrails } from "../guardrails/input/InputGuardrails";
import { OutputGuardrails } from "../guardrails/output/OutputGuardrails";
import { ResearchAgentPrompt } from "./ReseatchAgentSystemPrompt";
import type { LLMResponse } from "../providers/LLMResponse";
import type { ResearchMessage } from "./Message";
import type { RunCallbacks } from "./RunCallbacks";
import { requestUrls } from "../orchestration/UrlIntent";
import { researchContextMessage } from "./ResearchContext";
import type { UrlReadResult } from "../tools/ReadUrlTool";
import { SecretScanner } from "../guardrails/types/SecretScanner";

export class ResearchAgent {
    private inputGuardrails: InputGuardrails;
    private outputGuardrails: OutputGuardrails;

    constructor(private llm: LLMProvider, private registry: ToolRegistry, private maxSteps = 60,
        private name = "ResearchAgent", _sandbox?: ExecutionManager, apiKey?: string) {
        this.inputGuardrails = new InputGuardrails(apiKey);
        this.outputGuardrails = new OutputGuardrails(apiKey);
    }

    async execute(input: string, callbacks?: RunCallbacks): Promise<LLMResponse> {
        const validation = await this.inputGuardrails.validate({ agentName: this.name, input, timestamp: new Date() });
        if (!validation.isSafe) throw new Error(validation.reason);
        // Each request starts with fresh evidence; a previous page cannot stand in for this one.
        const messages: ResearchMessage[] = [{ role: "user", content: input }];
        const tools = this.registry.getAllTools().filter(tool => ["search", "read_url"].includes(tool.name));
        const reader = tools.find(tool => tool.name === "read_url");
        const urls = requestUrls(input);
        const evidence: UrlReadResult[] = [];
        for (const url of urls) {
            callbacks?.onStatus?.(`reading ${SecretScanner.redact(url)}...`);
            if (!reader) throw new Error("The read_url tool is required to inspect supplied URLs.");
            const result = await reader.execute({ url }) as UrlReadResult;
            evidence.push(result);
            // This retrieval was initiated by the application, not the model.
            // Synthetic functionCall turns lack Gemini's required thought signatures.
            messages.push({ role: "user", content: researchContextMessage(JSON.stringify({ tool: "read_url", result })) });
        }
        if (evidence.length && !evidence.some(result => result.success && result.content.trim())) {
            return {
                role: "assistant",
                text: evidence.map(result => `Could not read ${SecretScanner.redact(result.requestedUrl)}: ${result.error || result.status}${result.description ? `\nOnly page description metadata was available: ${result.description}` : ""}${result.warnings.length ? `\n${result.warnings.join("\n")}` : ""}`).join("\n\n"),
            };
        }
        callbacks?.onStatus?.("researching...");
        for (let step = 0; step < this.maxSteps; step++) {
            const response = await this.llm.generate(messages, tools, ResearchAgentPrompt);
            if (response.error) throw new Error(response.error.message);
            if (!response.toolcalls?.length) {
                const final = await this.outputGuardrails.outputValidation(response);
                return final.isSafe ? response : { role: "assistant", text: final.text || final.reason || "Research output blocked by validation." };
            }
            messages.push({ role: "model", parts: response.rawParts ?? response.toolcalls.map(call => ({ functionCall: { name: call.name, args: call.params } })) });
            for (const call of response.toolcalls) {
                // Enforce the read-only allowlist at dispatch, not only in model declarations.
                const tool = tools.find(tool => tool.name === call.name);
                let result: unknown = { error: "This tool is not available to the research agent." };
                if (tool) {
                    callbacks?.onStatus?.(`[${call.name}] running...`);
                    try { result = await tool.execute(call.params); }
                    catch { result = { error: "Retrieval failed; no content was obtained." }; }
                }
                const serialized = JSON.stringify(result) ?? "null";
                messages.push({ role: "tool", parts: [{ functionResponse: { name: call.name, response: { sourceData: researchContextMessage(serialized) } } }] });
            }
            callbacks?.onStatus?.("researching...");
        }
        throw new Error(`ResearchAgent exceeded maximum execution step limit of ${this.maxSteps}.`);
    }
}
