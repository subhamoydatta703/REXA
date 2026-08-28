import type { GuardrailResult } from "../types/GuardrailResult";
import type { GuardrailContext } from "../types/GuardrailContext";
import { SecretScanner } from "../types/SecretScanner";
import { buildInputGuardrailPrompt } from "./InputGuardrailPrompt";
import { GoogleGenAI } from "@google/genai";

export class InputGuardrails {
    private aiGuard: GoogleGenAI;

    constructor() {
        this.aiGuard = new GoogleGenAI({ apiKey: process.env.GEMINI_GUARD_API_KEY });
    }


    async validate(context: GuardrailContext): Promise<GuardrailResult> {

        if (!this.aiGuard) {
            throw new Error("AI Guard not initialized");
        }
        

        if (context.input.length > 1000) {
            return {
                isSafe: false,
                reason: "Input too long",
            };
        }
        
        // different secrets checking happens here
        if (SecretScanner.containsSecret(context.input)) {
            return {
                isSafe: false,
                reason: "Potential secret detected",
            };
        }


        // call llm to check other type of inputs
        // and give result

        const llmResult = await this.inputGuardrail(context.input);
        if (llmResult.isSafe===false) {
            return {
                isSafe: false,
                reason: llmResult.reason,
            };
        }


     return {
        isSafe: true,
        reason: "Input validation passed",
     }
}



private inputGuardrail = async (userQuery: string): Promise<GuardrailResult> => {
    try {
        const prompt = buildInputGuardrailPrompt(userQuery);

        const response = await this.aiGuard.models.generateContent({
            model: "gemini-3.1-flash-lite",
            contents: prompt,
        })

        const responseText = response.text || "";
        if (!responseText) {
            throw new Error("Guardrail returned an empty response.");
        }

        const jsonString = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
        const parsed: unknown = JSON.parse(jsonString);
        if (
            typeof parsed !== "object" ||
            parsed === null ||
            typeof (parsed as { isSafe?: unknown }).isSafe !== "boolean"
        ) {
            return {
                isSafe: false,
                reason: "Input guardrail returned an invalid classification.",
            };
        }

        return {
            isSafe: (parsed as { isSafe: boolean }).isSafe,
            reason: typeof (parsed as { reason?: unknown }).reason === "string"
                ? (parsed as { reason: string }).reason
                : undefined,
        };


    } catch (error) {
        console.error("Error at inputGuardrail: ", error);
        throw error;
    }
}


}
