import { AgentUI } from "./AgentUI";
import { clearActiveSpinner } from "./TerminalState";
import type { AgentMode } from "../agent/AgentMode";
import type { RunCallbacks } from "../agent/RunCallbacks";
import type { LLMResponse } from "../providers/LLMResponse";
import type { LocalCommands } from "./LocalCommands";
import { sanitizeStored } from "../utils/SanitizeStored";

interface AgentRunner {
    run(
        content: string,
        mode?: AgentMode,
        callbacks?: RunCallbacks,
    ): Promise<LLMResponse>;
}

export class CLI {
    constructor(
        private agent: AgentRunner,
        private commands?: LocalCommands,
        private initialMode: AgentMode = "act",
    ) {}

    async start() {
        let mode: AgentMode = this.initialMode;
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

            if (!trimmed) {
                continue;
            }
            if (userInput.trim().startsWith("/")) {
                try {
                    const result = await this.commands?.handle(userInput);
                    if (result) {
                        mode = result.mode ?? mode;
                        AgentUI.renderResponse(result.text);
                    } else {
                        AgentUI.renderResponse(
                            "Local commands are unavailable.",
                        );
                    }
                } catch (error) {
                    AgentUI.renderError(error);
                }
                continue;
            }

            await this.runTask(userInput, mode);
        }
    }

    private async runTask(userInput: string, mode: AgentMode): Promise<void> {
        const spinner = AgentUI.startSpinner();
        const cancellation = new AbortController();
        const cancel = () => {
            cancellation.abort(new Error("Task cancelled by user."));
            AgentUI.updateSpinner(spinner, "cancelling...");
        };
        process.on("SIGINT", cancel);
        let streamed = false;
        const callbacks: RunCallbacks = {
            signal: cancellation.signal,
            onCommandOutput: (text) => {
                if (spinner.isSpinning) {
                    spinner.stop();
                }
                // Tool output is data; strip terminal control sequences before display.
                process.stdout.write(
                    sanitizeStored(text)
                        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
                        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""),
                );
            },
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
            if (spinner.isSpinning) {
                spinner.stop();
            }
            clearActiveSpinner(spinner);
            if (streamed) {
                AgentUI.finishStreamingResponse();
            } else {
                AgentUI.renderResponse(response?.text || "");
            }
        } catch (error) {
            spinner.fail("Execution error.");
            clearActiveSpinner(spinner);
            AgentUI.renderError(error);
        } finally {
            process.off("SIGINT", cancel);
        }
    }
}
