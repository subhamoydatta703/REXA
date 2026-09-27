import { AgentUI } from "./AgentUI";
import { clearActiveSpinner } from "./TerminalState";
import type { AgentMode } from "../agent/AgentMode";
import type { RunCallbacks } from "../agent/RunCallbacks";
import type { LLMResponse } from "../providers/LLMResponse";

interface AgentRunner {
    run(content: string, mode?: AgentMode, callbacks?: RunCallbacks): Promise<LLMResponse>;
}

export class CLI {
    constructor(private agent: AgentRunner) {}

    async start() {
        let mode: AgentMode = "act";
        AgentUI.displayBanner(mode);
        AgentUI.displayWorkspace(process.cwd());

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
            let streamed = false;
            const callbacks: RunCallbacks = {
                onStatus: (status) => AgentUI.updateSpinner(spinner, status),
                onToken: (token) => {
                    if (!streamed) {
                        streamed = true;
                        AgentUI.beginStreamingResponse(spinner);
                    }
                    AgentUI.writeStreamingToken(token);
                },
            };

            try {
                const response = await this.agent.run(userInput, mode, callbacks);
                if (spinner.isSpinning) spinner.stop();
                clearActiveSpinner(spinner);
                if (streamed) {
                    AgentUI.finishStreamingResponse();
                } else {
                    AgentUI.renderResponse(response?.text || "");
                }
            } catch (error: any) {
                spinner.fail("Execution error.");
                clearActiveSpinner(spinner);
                AgentUI.renderError(error);
            }
        }
    }
}
