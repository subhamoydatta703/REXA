import type { Part } from "@google/genai";

export interface Message {
    agentName?: string
    runID?: string;
    role: "user" | "model" | "assistant" | "tool";
    content?: string;
    parts?: Part[];
}


export interface ResearchMessage {
    agentName?: string;
    runID?: string;
    role: "user" | "model" | "tool";
    content?: string;
    parts?: Part[];
}




