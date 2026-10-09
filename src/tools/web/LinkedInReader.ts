import { WebRequestError } from "./SafeWebRequest";
import { SecretScanner } from "../../guardrails/types/SecretScanner";

const API = "https://api.brightdata.com/datasets/v3";
const DATASET = "gd_l1viktl72bvl7bjuj0";
const MAX_RESPONSE_BYTES = 2_000_000;

export function linkedInProfileUrl(value: string): string | null {
    try {
        const url = new URL(value);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return null;
        if (!/^(?:[a-z]{2,3}\.)?linkedin\.com$/.test(url.hostname) || !/^\/in\/[^/]+\/?$/.test(url.pathname)) return null;
        return `https://www.linkedin.com${url.pathname.replace(/\/$/, "")}/`;
    } catch { return null; }
}

export interface LinkedInPage { title: string; content: string; url: string; retrievedAt: string; }
interface Dependencies {
    fetch: (url: string, init: RequestInit) => Promise<Response>;
    getKey: () => Promise<string | undefined>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    timeoutMs: number;
}

async function getKey(): Promise<string | undefined> {
    const { ConfigManager } = await import("../../config/ConfigManager");
    return ConfigManager.getBrightDataApiKey();
}

function object(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function responseText(response: Response, maxBytes: number): Promise<string> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
        const reader = response.body.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > maxBytes) {
                    await reader.cancel();
                    throw new WebRequestError("provider_error", "Bright Data response exceeded the size limit.");
                }
                chunks.push(value);
            }
        } finally { reader.releaseLock(); }
    }
    return Buffer.concat(chunks).toString("utf8");
}

function providerErrorDetail(text: string, key: string): string {
    let detail: unknown;
    try {
        const data = object(JSON.parse(text));
        // Do not expose echoed input, headers or other arbitrary response fields.
        detail = data?.message ?? data?.error_message ?? data?.error;
        if (typeof detail !== "string") detail = object(detail)?.message;
    } catch {
        // Some API failures are plain text, rather than JSON.
        if (!/^\s*</.test(text)) detail = text;
    }
    if (typeof detail !== "string") return "";
    // Remove the exact credential before truncating, even when it is not a known key format.
    return SecretScanner.redact(detail.split(key).join("[REDACTED]"))
        .replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 500);
}

// Fixed API origin and disabled redirects keep the bearer token away from profile URLs.
export function createLinkedInReader(overrides: Partial<Dependencies> = {}) {
    const dependencies: Dependencies = {
        fetch: (url, init) => fetch(url, init), getKey,
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), now: Date.now,
        timeoutMs: 120_000, ...overrides,
    };
    return async (value: string): Promise<LinkedInPage> => {
        const url = linkedInProfileUrl(value);
        if (!url) throw new WebRequestError("invalid_url", "A LinkedIn personal profile URL (/in/...) is required.");
        const key = (await dependencies.getKey())?.trim();
        if (!key) throw new WebRequestError("configuration_required", "LinkedIn profile extraction needs a Bright Data API key. Run `rexa config set-brightdata-key` or set BRIGHTDATA_API_KEY, then retry.");
        if (/^(?:wss?|https?):\/\//i.test(key) || /^brd-customer-/i.test(key)) {
            throw new WebRequestError("configuration_required", "The saved credential looks like a Browser API connection string or username. LinkedIn extraction requires an account API token from Bright Data Settings > Users/API keys. Save that token with `rexa config set-brightdata-key`.");
        }
        const apiKey: string = key;
        const deadline = dependencies.now() + dependencies.timeoutMs;
        async function request(path: string, body?: unknown): Promise<unknown> {
            const remaining = deadline - dependencies.now();
            if (remaining <= 0) throw new WebRequestError("timeout", "LinkedIn extraction timed out; no profile content was read.");
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), Math.min(remaining, 30_000));
            try {
                const response = await dependencies.fetch(`${API}/${path}`, {
                    method: body === undefined ? "GET" : "POST", redirect: "error", signal: controller.signal,
                    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                });
                if (!response.ok) {
                    let detail = "";
                    try { detail = providerErrorDetail(await responseText(response, 16_000), apiKey); }
                    catch { /* Keep the HTTP failure even if its diagnostic body cannot be read. */ }
                    const stage = body !== undefined ? "collection request" : path.startsWith("progress/") ? "progress check" : "snapshot download";
                    const message = response.status === 401 || response.status === 403
                        ? "Bright Data rejected the API key or scraper permissions. Check your key and LinkedIn Profiles scraper access."
                        : response.status === 402 ? "Bright Data requires additional credits. Check your account balance."
                        : response.status === 429 ? "Bright Data rate limit reached. Retry later."
                        : `Bright Data rejected the ${stage} (HTTP ${response.status}); no profile content was read.`;
                    throw new WebRequestError(response.status === 429 ? "rate_limited" : "provider_error", `${message}${detail ? ` Provider message: ${detail}` : ""}`);
                }
                const text = await responseText(response, MAX_RESPONSE_BYTES);
                try { return JSON.parse(text); }
                catch { throw new WebRequestError("provider_error", "Bright Data returned an invalid JSON response."); }
            } catch (error) {
                if (error instanceof WebRequestError) throw error;
                throw new WebRequestError(controller.signal.aborted ? "timeout" : "provider_error",
                    controller.signal.aborted ? "LinkedIn extraction timed out; no profile content was read." : "Could not contact Bright Data; no profile content was read.");
            } finally { clearTimeout(timer); }
        }

        // Submit exactly once: retries of a collection POST can consume extra credits.
        const job = object(await request(`trigger?dataset_id=${DATASET}&format=json&include_errors=true`, [{ url }]));
        const snapshot = job?.snapshot_id;
        if (typeof snapshot !== "string" || !/^s(?:d)?_[a-zA-Z0-9_-]+$/.test(snapshot)) {
            throw new WebRequestError("provider_error", "Bright Data did not return a valid collection ID.");
        }
        while (true) {
            const progress = object(await request(`progress/${snapshot}`));
            if (progress?.status === "ready") break;
            if (progress?.status === "failed" || progress?.status === "canceled") {
                throw new WebRequestError("content_unavailable", "Bright Data could not collect this profile. Check profile visibility and your scraper account status.");
            }
            if (progress?.status !== "starting" && progress?.status !== "running") {
                throw new WebRequestError("provider_error", "Bright Data returned an unknown collection status.");
            }
            if (deadline - dependencies.now() <= 2_000) {
                throw new WebRequestError("timeout", "LinkedIn extraction is still processing. No profile content was read. The collection may still consume Bright Data credits.");
            }
            await dependencies.sleep(2_000);
        }
        const data = await request(`snapshot/${snapshot}?format=json`);
        const records = Array.isArray(data) ? data : [data];
        const profile = records.map(object).find(record => {
            if (!record || record.error || record.error_code) return false;
            const source = record.url ?? record.input_url ?? object(record.input)?.url;
            return typeof source === "string" && linkedInProfileUrl(source) === url;
        });
        if (!profile || typeof profile.name !== "string" || !profile.name.trim()) {
            throw new WebRequestError("content_unavailable", "Bright Data returned no readable profile matching the requested URL.");
        }
        const fields = ["name", "position", "city", "country_code", "location", "about", "current_company", "current_company_name",
            "experience", "education", "educations_details", "skills", "certifications", "languages", "volunteer_experience",
            "courses", "publications", "projects", "honors_and_awards", "followers", "connections", "timestamp"];
        const details = Object.fromEntries(fields.filter(field => profile[field] !== undefined && profile[field] !== null).map(field => [field, profile[field]]));
        const retrievedAt = new Date(dependencies.now()).toISOString();
        return { url, title: `${profile.name} | LinkedIn`, retrievedAt,
            content: `LinkedIn profile data\nSource: ${url}\nRetrieved at: ${retrievedAt}\nProvider: Bright Data LinkedIn Profiles\nMissing fields were not available; do not infer them.\n\n${JSON.stringify(details, null, 2)}` };
    };
}

export const readLinkedInProfile = createLinkedInReader();
