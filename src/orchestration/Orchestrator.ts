import { Supervisor } from "./Supervisor";
import { ResearchAgent } from "../agent/ResearchAgent";
import { Agent } from "../agent/Agent";
import { InputGuardrails } from "../guardrails/input/InputGuardrails";
import type { AgentMode } from "../agent/AgentMode";


export class Orchestrator {

    constructor(
        private supervisor: Supervisor,
        private researchAgent: ResearchAgent,
        private agent: Agent,
        private inputGuardrails: InputGuardrails) { }


    async run(content: string, mode: AgentMode = "act") {
        const inputValidation = await this.inputGuardrails.validate({ agentName: "Orchestrator", input: content, timestamp: new Date() });
        if (inputValidation.isSafe === false) {
            throw new Error(inputValidation.reason);
        }

        const supervisorDecision = await this.supervisor.decide(content);

        if (supervisorDecision.route === "DIRECT") {
            return supervisorDecision.directResponse;
        }
        else if (supervisorDecision.route === "CODE_ONLY") {
            return this.agent.run(content, mode);
        }
        else if (supervisorDecision.route === "RESEARCH_AND_CODE") {
            const researchResponse = await this.researchAgent.execute(content);
            const enrichedPrompt = `
USER REQUEST:
${content}
RESEARCH & TECHNICAL BRIEF (from ResearchAgent):
${researchResponse?.text || "No external findings."}
`.trim();
            const codeResponse = await this.agent.run(enrichedPrompt, mode);
            return codeResponse;
        }
    }
}