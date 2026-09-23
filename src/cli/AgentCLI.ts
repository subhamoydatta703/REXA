import type { Agent } from "../agent/Agent";
import { AgentUI } from "./AgentUI";
import { clearActiveSpinner } from "./TerminalState";
import type { AgentMode } from "../agent/AgentMode";

export class CLI {
    constructor(private agent: Agent) {}

    async start() {
        AgentUI.displayBanner();
        AgentUI.displayWorkspace(process.cwd());
        let mode: AgentMode = "act";

        while (true) {
            let userInput: string;
            try {
                const prompt = await AgentUI.getPromptInput(mode);
                userInput = prompt.value;
                mode = prompt.mode;
            } catch {
                AgentUI.renderExit();
                break;
            }

            const trimmed = userInput.trim().toLowerCase();
            // Only exit on explicit exit/quit commands
            if (["exit", "quit"].includes(trimmed)) {
                AgentUI.renderExit();
                break;
            }

            if (!trimmed) continue;

            const spinner = AgentUI.startSpinner();

            try {
                const response = await this.agent.run(userInput, mode);
                spinner.stop();
                clearActiveSpinner(spinner);
                AgentUI.renderResponse(response?.text || "");
            } catch (error: any) {
                spinner.fail("Execution error.");
                clearActiveSpinner(spinner);
                AgentUI.renderError(error);
            }
        }
    }
}
