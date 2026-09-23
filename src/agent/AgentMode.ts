export type AgentMode = "plan" | "act";

export interface PromptInput {
    value: string;
    mode: AgentMode;
}
