import { z } from "zod";
import { type Tool } from "./ToolRegistry";
import { ConfigManager, REXA_MEMORY_URL, REXA_MEMORY_SEARCH_URL } from "../config/ConfigManager";
import { MEMORY_SEARCH_TOOL_DESCRIPTION } from "./MemorySearchRules";


const MAX_MEMORY_CHARS = 8192;

const saveMemorySchema = z.object({
    text: z
        .string()
        .describe("The fact or preference the user asked to remember. Not chat logs, files, API keys, tokens, or passwords.")
        .min(1),
});

export async function postCliMemory(
    text: string,
    token: string
): Promise<{ success: boolean; message: string }> {
    const trimmed = text.trim();
    if (!trimmed) {
        return { success: false, message: "Nothing to save: text is empty." };
    }
    if (trimmed.length > MAX_MEMORY_CHARS) {
        return { success: false, message: `Memory text is too long (max ${MAX_MEMORY_CHARS} characters).` };
    }

    try {
        const memoryUrl = process.env.REXA_MEMORY_URL?.trim() || REXA_MEMORY_URL;
        const response = await fetch(memoryUrl, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ text: trimmed }),
            signal: AbortSignal.timeout(90_000),
        });

        let body: { success?: boolean; message?: string } = {};
        try {
            body = (await response.json()) as { success?: boolean; message?: string };
        } catch {
            body = {};
        }

        const apiMessage = typeof body.message === "string" ? body.message.trim() : "";

        if (!response.ok || body.success === false) {
            if (response.status === 401) {
                return {
                    success: false,
                    message: apiMessage
                        ? `${apiMessage}. Run rexa login and try again.`
                        : "Invalid or expired token. Run rexa login and try again.",
                };
            }
            return {
                success: false,
                message: apiMessage || "Could not save memory.",
            };
        }

        return {
            success: true,
            message: apiMessage || "Data saved in memory",
        };
    } catch {
        return {
            success: false,
            message: "Could not reach the REXA server to save memory. Try again in a moment.",
        };
    }
}

export const saveMemory: Tool = {
    name: "save_memory",
    description:
        "Save a short fact or preference the user explicitly asked to remember. " +
        "USE THIS only when the user says to remember, save to memory, or similar. " +
        "DO NOT save full conversations, file contents, API keys, tokens, passwords, or secrets.",
    parameters: saveMemorySchema,
    execute: async (args: z.infer<typeof saveMemorySchema>) => {
        const parsed = saveMemorySchema.parse(args);
        const token = await ConfigManager.getCliAuthToken();
        if (!token) {
            return { success: false, message: "Not logged in. Run rexa login first." };
        }
        return postCliMemory(parsed.text, token);
    },
};

const searchMemorySchema = z.object({
    query: z
        .string()
        .describe("The query to search memory for.")
        .min(1),
});


export async function postCliSearchMemory( query: string,
    token: string
): Promise<{ success: boolean; message: string, data?: any }> {
    const trimmed = query.trim();
    if (!trimmed) {
        return { success: false, message: "Nothing to search: query is empty." };
    }
    if (trimmed.length > MAX_MEMORY_CHARS) {
        return { success: false, message: `Query text is too long (max ${MAX_MEMORY_CHARS} characters).` };
    }

    try {
        const memorySearchUrl = process.env.REXA_MEMORY_SEARCH_URL?.trim() || REXA_MEMORY_SEARCH_URL;
        const response = await fetch(memorySearchUrl, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ query: trimmed }),
            signal: AbortSignal.timeout(90_000),
        });

        let body: { success?: boolean; message?: string; data?: any } = {};
        try {
            body = (await response.json()) as { success?: boolean; message?: string };
        } catch {
            body = {};
        }

        const apiMessage = typeof body.message === "string" ? body.message.trim() : "";

        if (!response.ok || body.success === false) {
            if (response.status === 401) {
                return {
                    success: false,
                    message: apiMessage
                        ? `${apiMessage}. Run rexa login and try again.`
                        : "Invalid or expired token. Run rexa login and try again.",
                };
            }
            return {
                success: false,
                message: apiMessage || "Could not search memory.",
            };
        }

        return {
            success: true,
            message: apiMessage || "Data found in memory",
            data: body.data 
        };
    } catch {
        return {
            success: false,
            message: "Could not reach the REXA server to search memory. Try again in a moment.",
            
        };
    }
}






export const searchMemory: Tool ={
    name: "search_memory",
    description: MEMORY_SEARCH_TOOL_DESCRIPTION,
    parameters: searchMemorySchema,
    execute: async (args: z.infer<typeof searchMemorySchema>) => {
        const parsed = searchMemorySchema.parse(args);
        const token = await ConfigManager.getCliAuthToken();
        if (!token) {
            return { success: false, message: "Not logged in. Run rexa login first." };
        }
        return postCliSearchMemory(parsed.query, token);
    },
}