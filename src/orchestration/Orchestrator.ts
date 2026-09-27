import { Supervisor } from "./Supervisor";
import { ResearchAgent } from "../agent/ResearchAgent";
import { Agent } from "../agent/Agent";
import { InputGuardrails } from "../guardrails/input/InputGuardrails";
import type { AgentMode } from "../agent/AgentMode";
import type { RunCallbacks } from "../agent/RunCallbacks";
import type { LLMResponse } from "../providers/LLMResponse";


export class Orchestrator {

    constructor(
        private supervisor: Supervisor,
        private researchAgent: ResearchAgent,
        private agent: Agent,
        private inputGuardrails: InputGuardrails) { }


    async run(content: string, mode: AgentMode = "act", callbacks?: RunCallbacks): Promise<LLMResponse> {
        const inputValidation = await this.inputGuardrails.validate({ agentName: "Orchestrator", input: content, timestamp: new Date() });
        if (inputValidation.isSafe === false) {
            throw new Error(inputValidation.reason);
        }

        callbacks?.onStatus?.("thinking...");
        const supervisorDecision = await this.supervisor.decide(content);

        if (supervisorDecision.route === "DIRECT") {
            const text = supervisorDecision.directResponse || "";
            if (text) callbacks?.onToken?.(text);
            return { role: "assistant", text };
        }
        else if (supervisorDecision.route === "CODE_ONLY") {
            return this.agent.run(content, mode, callbacks);
        }
        else if (supervisorDecision.route === "RESEARCH_AND_CODE") {
            // Plan mode is deliberately tool-free: it may describe research
            // that would be useful, but must not perform that research.
            if (mode === "plan") {
                return this.agent.run(content, mode, callbacks);
            }
            const researchResponse = await this.researchAgent.execute(content, callbacks);
            const enrichedPrompt = `
USER REQUEST:
${content}
RESEARCH & TECHNICAL BRIEF (from ResearchAgent):
${researchResponse?.text || "No external findings."}
`.trim();
            const codeResponse = await this.agent.run(enrichedPrompt, mode, callbacks);
            return codeResponse;
        }

        throw new Error("Supervisor returned an unsupported route.");
    }
}
