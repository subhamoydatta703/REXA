import type { Supervisor } from "./Supervisor";
import type { ResearchAgent } from "../agent/ResearchAgent";
import type { Agent } from "../agent/Agent";
import type { InputGuardrails } from "../guardrails/input/InputGuardrails";
import { isUrlInspectionRequest } from "./UrlIntent";
import type { AgentMode } from "../agent/AgentMode";
import type { RunCallbacks } from "../agent/RunCallbacks";
import type { LLMResponse } from "../providers/LLMResponse";


export class Orchestrator {

    constructor(
        private supervisor: Pick<Supervisor, "decide">,
        private researchAgent: Pick<ResearchAgent, "execute">,
        private agent: Pick<Agent, "run">,
        private inputGuardrails: Pick<InputGuardrails, "validate">) { }


    async run(content: string, mode: AgentMode = "act", callbacks?: RunCallbacks): Promise<LLMResponse> {
        const inputValidation = await this.inputGuardrails.validate({ agentName: "Orchestrator", input: content, timestamp: new Date() });
        if (inputValidation.isSafe === false) {
            throw new Error(inputValidation.reason);
        }

        callbacks?.onStatus?.("thinking...");
        const supervisorDecision = isUrlInspectionRequest(content)
            ? { route: "RESEARCH_ONLY" as const, reason: "Explicit URL inspection" }
            : await this.supervisor.decide(content);

        if (supervisorDecision.route === "DIRECT") {
            const text = supervisorDecision.directResponse || "";
            if (text) callbacks?.onToken?.(text);
            return { role: "assistant", text };
        }
        else if (supervisorDecision.route === "CODE_ONLY") {
            return this.agent.run(content, mode, callbacks);
        }
        else if (supervisorDecision.route === "RESEARCH_ONLY" || supervisorDecision.route === "RESEARCH_AND_CODE") {
            // Plan mode is deliberately tool-free: it may describe research
            // that would be useful, but must not perform that research.
            if (mode === "plan") {
                return this.agent.run(content, mode, callbacks);
            }
            const researchResponse = await this.researchAgent.execute(content, callbacks);
            if (supervisorDecision.route === "RESEARCH_ONLY") {
                if (researchResponse.text) callbacks?.onToken?.(researchResponse.text);
                return researchResponse;
            }
            return this.agent.run(content, mode, callbacks, researchResponse.text || "No external findings.");
        }

        throw new Error("Supervisor returned an unsupported route.");
    }
}
