import { z } from "zod";

const responseSchema = z.object({
    results: z.array(
        z.object({
            url: z.string(),
            title: z.string().optional(),
            content: z.string().optional(),
            raw_content: z.string().optional(),
        }),
    ),
});

/** Fixed-origin provider request; cancellation aborts the actual HTTP operation. */
export function createTavilyRequester(fetchRequest: typeof fetch = fetch) {
    return async function requestTavily(
        endpoint: "search" | "extract",
        apiKey: string,
        body: Record<string, unknown>,
        signal?: AbortSignal,
    ) {
        signal?.throwIfAborted();
        const timeout = AbortSignal.timeout(15_000);
        const response = await fetchRequest(
            `https://api.tavily.com/${endpoint}`,
            {
                method: "POST",
                redirect: "error",
                signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
            },
        );
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error("Tavily request failed.");
        }
        return responseSchema.parse(await response.json());
    };
}

export const requestTavily = createTavilyRequester();
