export interface FriendlyErrorInfo {
    userMessage: string;
    isTemporary: boolean;
    statusCode?: number;
}


//   Translates low-level API errors, network issues, and status codes into
//   clean, conversational messages in REXA's persona.

export function toAgentFriendlyError(error: unknown): FriendlyErrorInfo {
    if (!error) {
        return {
            userMessage: "Yo, something tripped up on my end. Give it another shot, bro.",
            isTemporary: false,
        };
    }

    const errObj = error as Record<string, any>;
    const rawMessage = typeof errObj.message === "string" ? errObj.message : String(error);
    const status = errObj.status ?? errObj.code ?? errObj.error?.code ?? errObj.error?.status;

    // Check for 503 / High Demand / Overloaded / UNAVAILABLE
    if (
        status === 503 ||
        status === "UNAVAILABLE" ||
        /503|high demand|overloaded|unavailable|temporarily unavailable/i.test(rawMessage)
    ) {
        return {
            userMessage: "Yo, Gemini's servers are getting hammered right now (503 high demand). Spikes in demand are usually temporary — give it a sec and run that again, bro.",
            isTemporary: true,
            statusCode: 503,
        };
    }

    // Check for 429 / Rate limit / Quota exceeded
    if (
        status === 429 ||
        status === "RESOURCE_EXHAUSTED" ||
        /429|quota|rate limit|resource_exhausted/i.test(rawMessage)
    ) {
        return {
            userMessage: "Hold up, we hit the Gemini rate limit or quota. Let's chill for a moment before firing off another prompt.",
            isTemporary: true,
            statusCode: 429,
        };
    }

    // Check for 400 / 401 / 403 / API Key issues
    if (
        status === 401 ||
        status === 403 ||
        status === "PERMISSION_DENIED" ||
        status === "UNAUTHENTICATED" ||
        /api key|unauthenticated|permission_denied|invalid api key/i.test(rawMessage)
    ) {
        return {
            userMessage: "Looks like your Gemini API key isn't working or expired. Run 'rexa config set-key' to update it, bro.",
            isTemporary: false,
            statusCode: typeof status === "number" ? status : 401,
        };
    }

    // Check for network disconnects / timeouts
    if (
        /fetch failed|econnrefused|ehostunreach|enotfound|timed out|aborterror|network error/i.test(rawMessage)
    ) {
        return {
            userMessage: "Can't connect to Gemini right now. Check your internet connection or VPN and let's try again.",
            isTemporary: true,
        };
    }

    // Generic fallback in REXA's persona
    return {
        userMessage: "Ran into a bump while processing that. Lemme know if you want me to try again.",
        isTemporary: false,
    };
}
