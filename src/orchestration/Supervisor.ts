import { GoogleGenAI } from "@google/genai";
import { SupervisorPrompt } from "./SupervisorPrompt";
import type { SupervisorDecision } from "../providers/LLMResponse";
import { logger } from "../logger/AgentLogger";
import { isUrlInspectionRequest } from "./UrlIntent";



export class Supervisor{

    private client: GoogleGenAI;

    constructor(apiKey:string){
        this.client = new GoogleGenAI({apiKey})

    }

    async decide(query:string):Promise<SupervisorDecision>{

        try {
            const prompt = `${SupervisorPrompt}\n\n User Input: \n\n ${query}`
            
            const response = await this.client.models.generateContent({
                model: "gemini-3.8-flash",
                contents: prompt,
                config: {
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: "object",
                        properties: {
                            route: {
                                type: "string",
                                enum: ["DIRECT", "CODE_ONLY", "RESEARCH_ONLY", "RESEARCH_AND_CODE"],
                            },
                            reason: {
                                type: "string",
                            },
                            directResponse: {
                                type: "string",
                            },
                            

                        },
                        required: ["route", "reason"],
                    },
                }
            })

            const responseText = response.text || ""
            const jsonString =  responseText.replace(/```json/g, "").replace(/```/g, "").trim();
            const parsed = JSON.parse(jsonString) as SupervisorDecision;
            if (!["DIRECT", "CODE_ONLY", "RESEARCH_ONLY", "RESEARCH_AND_CODE"].includes(parsed.route)) throw new Error("Invalid supervisor route");
           return parsed;
            
            
        } catch (error) {
             logger.debug("Supervisor classification failed, falling back to CODE_ONLY", {
                error: error instanceof Error ? error.message : String(error),
            });
            return {
                route: isUrlInspectionRequest(query) ? "RESEARCH_ONLY" : "CODE_ONLY",
                reason:"Supervisor classification failed",
            }
        }

    }

}
