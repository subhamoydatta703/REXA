
export type ErrorKind =
    | "cancelled"
    | "auth"
    | "quota_exhausted"
    | "rate_limit"
    | "overloaded"
    | "internal"
    | "timeout"
    | "network"
    | "model_not_found"
    | "region_or_billing"
    | "context_too_long"
    | "safety"
    | "invalid_request"
    | "unknown";

export interface FriendlyErrorInfo {
    userMessage: string;
    isTemporary: boolean;
    statusCode?: number;
    /** Stable classification for retry logic, logs, metrics and tests. */
    kind: ErrorKind;
    /** Server-suggested wait (Gemini RetryInfo / "retry in 34s"), temporary errors only. */
    retryAfterMs?: number;
}

export interface FriendlyErrorOptions {
    /**
     * An AbortError is treated as a user cancel (Ctrl+C) by default, so it is
     * never retried. If YOUR OWN timer aborted the request (for example the
     * SDK's `httpOptions.timeout`, which as far as I know aborts via an
     * AbortController), pass `userCancelled: false` so it is reported as a
     * retryable timeout instead. Typical call site:
     *   toAgentFriendlyError(err, { userCancelled: userSignal.aborted })
     */
    userCancelled?: boolean;
}

// ---------------------------------------------------------------------------
// Error-shape extraction
// ---------------------------------------------------------------------------

const MAX_DEPTH = 6;
const MAX_ITEMS = 20;
const MAX_MESSAGES = 50;
const MAX_STRING = 20_000;

/** gRPC status names used in Google API error envelopes, mapped to HTTP codes. */
const GRPC_TO_HTTP: ReadonlyMap<string, number> = new Map([
    ["CANCELLED", 499],
    ["INVALID_ARGUMENT", 400],
    ["DEADLINE_EXCEEDED", 504],
    ["NOT_FOUND", 404],
    ["PERMISSION_DENIED", 403],
    ["RESOURCE_EXHAUSTED", 429],
    ["FAILED_PRECONDITION", 400],
    ["OUT_OF_RANGE", 400],
    ["UNIMPLEMENTED", 501],
    ["INTERNAL", 500],
    ["UNAVAILABLE", 503],
    ["UNAUTHENTICATED", 401],
]);

const MESSAGE_KEYS = ["message", "msg", "reason", "quotaId", "quotaMetric"] as const;
const STATUS_KEYS = ["status", "statusCode", "httpStatus", "code"] as const;
const NESTED_KEYS = ["error", "errors", "cause", "response", "details", "violations", "body", "data"] as const;

/** "got status: 503 . {...}", "status code 429", "[503 Service Unavailable]" */
const STATUS_IN_TEXT = /\bgot status:?\s*(\d{3})\b|\bstatus code:?\s*(\d{3})\b|\[(\d{3}) [a-z]/i;
const RETRY_IN_TEXT = /\bretry(?:ing)? in (\d+(?:\.\d+)?)s\b/;

interface Shape {
    messages: string[];
    /** Lower-cased, newline-joined messages. Regexes run against this. */
    text: string;
    /** HTTP status codes (400-599) found in structured fields or status text. */
    httpStatuses: number[];
    /** gRPC status names such as RESOURCE_EXHAUSTED. */
    grpcNames: Set<string>;
    /** Upper-cased string codes such as ECONNRESET or UND_ERR_SOCKET. */
    codes: Set<string>;
    /** Error class names along the cause chain, such as AbortError. */
    names: Set<string>;
    retryAfterMs?: number;
}

function addStatus(candidate: unknown, shape: Shape): void {
    if (typeof candidate === "number") {
        if (Number.isInteger(candidate) && candidate >= 400 && candidate < 600 && !shape.httpStatuses.includes(candidate)) {
            shape.httpStatuses.push(candidate);
        }
        return;
    }
    if (typeof candidate !== "string") return;

    const value = candidate.trim();
    if (/^\d{3}$/.test(value)) {
        addStatus(Number(value), shape);
        return;
    }
    const upper = value.toUpperCase();
    if (GRPC_TO_HTTP.has(upper)) shape.grpcNames.add(upper);
    else if (/^[A-Z][A-Z0-9_]{2,}$/.test(upper)) shape.codes.add(upper);
}

function ingestString(raw: string, shape: Shape, depth: number, seen: WeakSet<object>): void {
    const text = raw.trim().slice(0, MAX_STRING);
    if (!text) return;

    if (shape.messages.length < MAX_MESSAGES && !shape.messages.includes(text)) {
        shape.messages.push(text);
    }

    const match = STATUS_IN_TEXT.exec(text);
    const found = match?.[1] ?? match?.[2] ?? match?.[3];
    if (found) addStatus(Number(found), shape);

    // SDKs often embed a JSON envelope in `message`, sometimes after a prefix
    // such as "got status: 429 . ". Parse from the first brace.
    const brace = text.indexOf("{");
    if (brace !== -1) {
        try {
            collect(JSON.parse(text.slice(brace)) as unknown, shape, depth + 1, seen);
        } catch {
            // Not JSON; the raw text is already recorded.
        }
    }
}

function collect(value: unknown, shape: Shape, depth: number, seen: WeakSet<object>): void {
    if (value === null || value === undefined || depth > MAX_DEPTH) return;

    if (typeof value === "string") {
        ingestString(value, shape, depth, seen);
        return;
    }

    if (Array.isArray(value)) {
        for (const item of value.slice(0, MAX_ITEMS)) collect(item, shape, depth + 1, seen);
        return;
    }

    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;

    const name = record["name"];
    if (typeof name === "string" && /(?:error|exception)$/i.test(name)) shape.names.add(name);

    for (const key of MESSAGE_KEYS) {
        const candidate = record[key];
        if (typeof candidate === "string") ingestString(candidate, shape, depth, seen);
    }

    for (const key of STATUS_KEYS) addStatus(record[key], shape);

    const retryDelay = record["retryDelay"];
    if (typeof retryDelay === "string") {
        const match = /^(\d+(?:\.\d+)?)s$/.exec(retryDelay.trim());
        if (match?.[1]) shape.retryAfterMs ??= Math.round(Number(match[1]) * 1000);
    }

    for (const key of NESTED_KEYS) collect(record[key], shape, depth + 1, seen);
}

function extractShape(error: unknown): Shape {
    const shape: Shape = {
        messages: [],
        text: "",
        httpStatuses: [],
        grpcNames: new Set(),
        codes: new Set(),
        names: new Set(),
    };

    collect(error, shape, 0, new WeakSet<object>());

    if (shape.messages.length === 0) {
        const fallback = String(error);
        if (fallback && fallback !== "[object Object]") shape.messages.push(fallback);
    }

    shape.text = shape.messages.join("\n").toLowerCase();

    if (shape.retryAfterMs === undefined) {
        const match = RETRY_IN_TEXT.exec(shape.text);
        if (match?.[1]) shape.retryAfterMs = Math.round(Number(match[1]) * 1000);
    }
    return shape;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

interface Rule {
    kind: ErrorKind;
    userMessage: string;
    isTemporary: boolean;
    /** Reported when nothing more precise was detected. */
    defaultStatus?: number;
    // Structured signals (strong pass).
    http?: readonly number[];
    grpc?: readonly string[];
    codes?: readonly string[];
    names?: readonly string[];
    /** Extra text condition that must also hold for the structured signals above. */
    alsoText?: RegExp;
    /** Unambiguous text signature; counts as strong. */
    strongText?: RegExp;
    /** Fuzzy text fallback, only tried after every strong check has failed. */
    weakText?: RegExp;
}

const DAILY_QUOTA = /per[ _-]?day|\bdaily\b/;

const NODE_TIMEOUT_CODES = ["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"] as const;

const NODE_NETWORK_CODES = [
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENETDOWN",
    "EAI_AGAIN",
    "EPIPE",
    "UND_ERR_SOCKET",
    "UND_ERR_CLOSED",
    "UND_ERR_DESTROYED",
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "ERR_TLS_CERT_ALTNAME_INVALID",
] as const;

/**
 * Order matters. Specific rules come before generic ones (a Gemini
 * "API key not valid" arrives as HTTP 400 INVALID_ARGUMENT, so `auth` must run
 * before `invalid_request`). Every rule's structured signals are checked across
 * the whole list first; text-only fallbacks run in a second pass.
 */
const RULES: readonly Rule[] = [
    {
        kind: "quota_exhausted",
        http: [429],
        grpc: ["RESOURCE_EXHAUSTED"],
        alsoText: DAILY_QUOTA,
        isTemporary: false,
        defaultStatus: 429,
        userMessage:
            "You've burned through today's Gemini quota, and waiting a minute won't fix that. Swap the key, enable billing, or come back tomorrow, bro.",
    },
    {
        kind: "rate_limit",
        http: [429],
        grpc: ["RESOURCE_EXHAUSTED"],
        weakText: /\bexceeded your current quota\b|\bquota exceeded\b|\brate[ _-]?limit(?:ed)?\b|\btoo many requests\b|\bresource[ _-]?exhausted\b/,
        isTemporary: true,
        defaultStatus: 429,
        userMessage: "Hold up, we hit the Gemini rate limit. Let's chill for a moment before firing off another prompt.",
    },
    {
        kind: "auth",
        http: [401, 403],
        grpc: ["UNAUTHENTICATED", "PERMISSION_DENIED"],
        strongText: /\bapi_key_invalid\b|\bapi_key_expired\b|\bapi key (?:not valid|expired|invalid)\b|\binvalid api key\b/,
        weakText: /\bunauthenticated\b/,
        isTemporary: false,
        defaultStatus: 401,
        userMessage: "Looks like your Gemini API key isn't working or expired. Run 'rexa config set-key' to update it, bro.",
    },
    {
        kind: "region_or_billing",
        strongText: /\blocation is not supported\b|\bnot available in your (?:country|region)\b|\benable billing\b/,
        isTemporary: false,
        defaultStatus: 400,
        userMessage:
            "Gemini won't serve this from your region or plan. Check that billing is enabled on your key's project, bro.",
    },
    {
        kind: "context_too_long",
        strongText: /\binput token count\b.*\bexceeds\b|\bexceeds the maximum number of tokens\b|\bcontext (?:length|window)\b|\btoken limit\b/,
        isTemporary: false,
        defaultStatus: 400,
        userMessage:
            "This conversation got too long for the model's context window. Start a fresh session or trim the history, bro.",
    },
    {
        kind: "model_not_found",
        http: [404],
        grpc: ["NOT_FOUND"],
        alsoText: /\bmodels?\b/,
        strongText: /\bmodels\/\S+ (?:is )?not found\b|\bunsupported model\b|\binvalid model\b/,
        isTemporary: false,
        defaultStatus: 404,
        userMessage: "Gemini couldn't find that model. Double-check the model name in your config, bro.",
    },
    {
        kind: "safety",
        strongText:
            /\bblock_?reason\b|\bprompt (?:was )?blocked\b|\bfinish_?reason\W+(?:safety|prohibited_content|blocklist|spii|image_safety)\b/,
        isTemporary: false,
        userMessage: "Gemini's safety filters blocked that one. Try rephrasing the request, bro.",
    },
    {
        kind: "overloaded",
        http: [503],
        grpc: ["UNAVAILABLE"],
        weakText: /\bhigh demand\b|\boverloaded\b|\bservice unavailable\b|\btemporarily unavailable\b/,
        isTemporary: true,
        defaultStatus: 503,
        userMessage:
            "Yo, Gemini's servers are getting hammered right now. Spikes in demand are usually temporary. Give it a sec and run that again, bro.",
    },
    {
        kind: "internal",
        http: [500, 502],
        grpc: ["INTERNAL"],
        weakText: /\binternal (?:server )?error\b|\bbad gateway\b/,
        isTemporary: true,
        defaultStatus: 500,
        userMessage:
            "Gemini hit an internal error on its side. That's usually transient, so run it again, bro. If it keeps happening, something in the request might be triggering it.",
    },
    {
        kind: "timeout",
        http: [504],
        grpc: ["DEADLINE_EXCEEDED"],
        codes: NODE_TIMEOUT_CODES,
        // AbortError only reaches here when the caller passed { userCancelled: false }.
        names: ["TimeoutError", "AbortError"],
        weakText: /\btimed out\b|\bdeadline exceeded\b/,
        isTemporary: true,
        defaultStatus: 504,
        userMessage: "Gemini took too long to answer. Give it another shot, bro.",
    },
    {
        kind: "network",
        codes: NODE_NETWORK_CODES,
        weakText:
            /\bfetch failed\b|\bnetwork error\b|\bsocket hang up\b|(?:^|\n)terminated(?:\n|$)|\bconnection (?:refused|reset|closed)\b|\bgetaddrinfo\b|\bcould not connect\b|\bfailed to connect\b/,
        isTemporary: true,
        userMessage: "Can't connect to Gemini right now. Check your internet connection or VPN and let's try again.",
    },
    {
        kind: "invalid_request",
        http: [400],
        grpc: ["INVALID_ARGUMENT", "FAILED_PRECONDITION", "OUT_OF_RANGE"],
        weakText: /\binvalid[ _]argument\b|\bbad request\b|\bmalformed\b|\bunsupported parameter\b/,
        isTemporary: false,
        defaultStatus: 400,
        userMessage:
            "Gemini bounced that request as invalid. That's most likely a bug in how I built it, not something you did. Check the logs, bro.",
    },
];

/** Returns the matched status (if any) when a rule's structured or strong-text signals fire. */
function matchStrong(rule: Rule, shape: Shape): { status?: number } | undefined {
    if (!rule.alsoText || rule.alsoText.test(shape.text)) {
        const http = rule.http?.find((code) => shape.httpStatuses.includes(code));
        if (http !== undefined) return { status: http };

        const grpc = rule.grpc?.find((name) => shape.grpcNames.has(name));
        if (grpc !== undefined) {
            const status = GRPC_TO_HTTP.get(grpc);
            return status !== undefined ? { status } : {};
        }

        if (rule.codes?.some((code) => shape.codes.has(code))) return {};
        if (rule.names?.some((name) => shape.names.has(name))) return {};
    }
    if (rule.strongText?.test(shape.text)) return {};
    return undefined;
}

function build(rule: Rule, shape: Shape, matchedStatus?: number): FriendlyErrorInfo {
    const statusCode = matchedStatus ?? shape.httpStatuses[0] ?? rule.defaultStatus;
    return {
        kind: rule.kind,
        userMessage: rule.userMessage,
        isTemporary: rule.isTemporary,
        ...(statusCode !== undefined ? { statusCode } : {}),
        ...(rule.isTemporary && shape.retryAfterMs !== undefined ? { retryAfterMs: shape.retryAfterMs } : {}),
    };
}

const unknownError = (statusCode?: number): FriendlyErrorInfo => ({
    kind: "unknown",
    userMessage: "Ran into a bump while processing that. Lemme know if you want me to try again.",
    isTemporary: false,
    ...(statusCode !== undefined ? { statusCode } : {}),
});

function isCancelled(shape: Shape, options: FriendlyErrorOptions): boolean {
    const aborted = shape.names.has("AbortError") || shape.codes.has("ABORT_ERR");
    return aborted && !shape.names.has("TimeoutError") && options.userCancelled !== false;
}

export function toAgentFriendlyError(error: unknown, options: FriendlyErrorOptions = {}): FriendlyErrorInfo {
    if (error === null || error === undefined || error === "") {
        return {
            kind: "unknown",
            userMessage: "Yo, something tripped up on my end. Give it another shot, bro.",
            isTemporary: false,
        };
    }

    let shape: Shape;
    try {
        shape = extractShape(error);
    } catch {
        // An error handler must never throw (exotic proxies, throwing getters).
        return unknownError();
    }

    if (isCancelled(shape, options)) {
        return { kind: "cancelled", userMessage: "Cancelled.", isTemporary: false };
    }

    for (const rule of RULES) {
        const hit = matchStrong(rule, shape);
        if (hit) return build(rule, shape, hit.status);
    }

    for (const rule of RULES) {
        if (rule.weakText?.test(shape.text)) return build(rule, shape);
    }

    return unknownError(shape.httpStatuses[0]);
}