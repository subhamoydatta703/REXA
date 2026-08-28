import type { Part } from "@google/genai";

export interface Message {
    agentName?: string
    runID?: string;
    role: "user" | "model" | "assistant" | "tool";
    content?: string;
    parts?: Part[];
}
