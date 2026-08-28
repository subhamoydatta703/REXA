import type { Agent } from "../agent/Agent";
import { AgentUI } from "./AgentUI";
import { clearActiveSpinner } from "./TerminalState";

export class CLI {
    constructor(private agent: Agent) {}

    async start() {
        AgentUI.displayBanner();
        AgentUI.displayWorkspace(process.cwd());

        while (true) {
            let userInput: string;
            try {
                userInput = await AgentUI.getPromptInput();
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
                const response = await this.agent.run(userInput);
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
