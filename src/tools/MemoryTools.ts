import { z } from "zod";
import { type Tool } from "./ToolRegistry";
import { ConfigManager, REXA_MEMORY_URL } from "../config/ConfigManager";

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
        const response = await fetch(REXA_MEMORY_URL, {
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
