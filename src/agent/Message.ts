import type { Part } from "@google/genai";

export interface Message {
    runID?: string;
    role: "user" | "model" | "assistant" | "tool";
    content?: string;
    parts?: Part[];
}
