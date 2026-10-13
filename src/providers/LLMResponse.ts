import type { NativeContinuation } from "../agent/Message";
import { type ToolCall } from "../tools/ToolRegistry";

export interface LLMResponse {
    role: string;
    text: string;
    native?: NativeContinuation;
    toolcalls?: ToolCall[];
    error?: {
        type: string;
        message: string;
    };
}

export interface SupervisorDecision {
    route: "DIRECT" | "CODE_ONLY" | "RESEARCH_ONLY" | "RESEARCH_AND_CODE";
    reason: string;
    directResponse?: string;
}
