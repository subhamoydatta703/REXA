import { type ToolCall } from "../tools/ToolRegistry";

export interface LLMResponse {
    role: string;
    text: string;
    rawParts?: any[];
    toolcalls?: ToolCall[];
     error?: {
        type: string;
        message: string;
    };
}


export interface GeminiRawJsonError {
    error: {
        code: number;
        message: string;
        status: string;
    };
}



export interface SupervisorDecision {
    route: "DIRECT" | "CODE_ONLY" | "RESEARCH_AND_CODE";
    reason: string;
    directResponse?: string;
}