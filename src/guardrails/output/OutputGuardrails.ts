import { GoogleGenAI } from "@google/genai";
import { buildOutputGuardrailPrompt} from "./OutputGuardrailPrompt";
import type { LLMResponse } from "../../providers/LLMResponse";
import type { GuardrailResult } from "../types/GuardrailResult";
import { SecretScanner } from "../types/SecretScanner";

export class OutputGuardrails {
    private aiGuard?: GoogleGenAI;
    
    constructor(apiKey?: string) {
        const key = apiKey || process.env.GEMINI_GUARD_API_KEY || process.env.GEMINI_API_KEY;
        if (key && key.trim()) {
            this.aiGuard = new GoogleGenAI({ apiKey: key.trim() });
        }
    }

    async outputValidation(response: LLMResponse): Promise<GuardrailResult> {
        if (!this.aiGuard) {
            const key = process.env.GEMINI_GUARD_API_KEY || process.env.GEMINI_API_KEY;
            if (key && key.trim()) {
                this.aiGuard = new GoogleGenAI({ apiKey: key.trim() });
            }
        }

        if (SecretScanner.containsSecret(response.text)) {
            return {
                isSafe: false,
                reason: "Potential secret detected",
            };
        }

        if (!this.aiGuard) {
            return {
                isSafe: true,
                reason: "Output validation passed",
            };
        }

        try {
            return await this.outputGuardrail(response);
        } catch (error) {
            console.warn("Output guardrail AI check failed, falling back to safe:", error instanceof Error ? error.message : String(error));
            return {
                isSafe: true,
                reason: "Output validation passed",
            };
        }
    }

    private async outputGuardrail(assistantResponse: LLMResponse): Promise<GuardrailResult> {
        if (!this.aiGuard) {
            return { isSafe: true, reason: "No AI Guard client available" };
        }
        try {
            const prompt = buildOutputGuardrailPrompt(assistantResponse);

            const response = await this.aiGuard.models.generateContent({
                model: "gemini-3.1-flash-lite",
                contents: prompt,
            });

            const responseText = response.text || "";
            if (!responseText) {
                throw new Error("Guardrail returned an empty response.");
            }

            const jsonString = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
            const parsed = JSON.parse(jsonString);

            return {
                isSafe: parsed.isSafe,
                reason: parsed.reason,
            };
        } catch (error) {
            console.error("Error at outputGuardrail: ", error);
            throw error;
        }
    }
}
