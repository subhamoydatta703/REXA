import { tavily } from "@tavily/core";
import { z } from "zod";
import { ConfigManager } from "../config/ConfigManager";

const searchSchema = z.object({
    query: z.string().describe("The search query or URL to inspect").min(1),
});

interface SearchResult {
    title: string;
    snippet: string;
    link: string;
}

interface SearchResponse {
    provider: string;
    results: SearchResult[];
    error?: string;
}

/**
 * Extracts the real destination URL from a DuckDuckGo redirect link.
 * DDG wraps all result links as: //duckduckgo.com/l/?uddg=<encoded_url>&rut=...
 */
function extractDDGUrl(rawHref: string): string {
    try {
        const uddgMatch = rawHref.match(/[?&]uddg=([^&]+)/);
        if (uddgMatch && uddgMatch[1]) {
            return decodeURIComponent(uddgMatch[1]);
        }
        // If no uddg param, try to use it as-is
        if (rawHref.startsWith("//")) return "https:" + rawHref;
        return rawHref;
    } catch {
        return rawHref;
    }
}

/**
 * Strips all HTML tags from a string.
 */
function stripHtml(html: string): string {
    return html.replace(/<[^>]+>/g, "").trim();
}

/**
 * Fetches and parses DuckDuckGo HTML search results.
 * Uses the non-JS HTML endpoint which returns server-rendered results.
 */
async function fetchDuckDuckGo(query: string): Promise<SearchResponse> {
    try {
        const res = await fetch(
            `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
            {
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                },
            }
        );
        const html = await res.text();

        // Extract title+href pairs: <a class="result__a" href="...">Title</a>
        const titleRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        const titles: { link: string; title: string }[] = [];
        let tm: RegExpExecArray | null;
        while ((tm = titleRegex.exec(html)) !== null) {
            const rawHref = tm[1] ?? "";
            const rawTitle = tm[2] ?? "";
            const link = extractDDGUrl(rawHref);
            const title = stripHtml(rawTitle);
            // Skip DuckDuckGo ads (they redirect through duckduckgo.com/y.js)
            if (title && link && !link.includes("/y.js")) {
                titles.push({ link, title });
            }
        }

        // Extract snippets: <a class="result__snippet" ...>Snippet text</a>
        const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        const snippets: string[] = [];
        let sm: RegExpExecArray | null;
        while ((sm = snippetRegex.exec(html)) !== null) {
            const raw = sm[1] ?? "";
            const snippet = stripHtml(raw);
            // Only push non-ad snippets (ads come first, skip if we filtered title)
            snippets.push(snippet || "");
        }

        // Skip leading ad results — DDG puts ads first with class "result--ad"
        // Count how many ad blocks appear before organic results
        const adCount = (html.match(/class="[^"]*result--ad[^"]*"/g) || []).length;
        const organicTitles = titles; // Already filtered ads by /y.js check
        const organicSnippets = snippets.slice(adCount);

        const results: SearchResult[] = [];
        const count = Math.min(organicTitles.length, organicSnippets.length, 5);
        for (let i = 0; i < count; i++) {
            const t = organicTitles[i];
            const s = organicSnippets[i];
            if (t && s) {
                results.push({ title: t.title, snippet: s, link: t.link });
            }
        }

        return { provider: "DuckDuckGo", results };
    } catch (error: any) {
        return { provider: "DuckDuckGo", results: [], error: error.message };
    }
}

/**
 * Direct GitHub API lookup for repository URLs.
 */
async function fetchGitHubRepo(url: string): Promise<SearchResponse | null> {
    const match = url.match(/github\.com\/([^\/]+)\/([^\/\s#?]+)/i);
    if (!match || !match[1] || !match[2]) return null;

    const owner = match[1];
    const repo = match[2].replace(/\.git$/, "");
    try {
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
            headers: { "User-Agent": "REXA-Agent" },
        });
        if (!res.ok) return null;

        const data = (await res.json()) as any;
        return {
            provider: "GitHub API",
            results: [
                {
                    title: `${data.full_name}`,
                    snippet: [
                        `Stars: ${data.stargazers_count}`,
                        `Forks: ${data.forks_count}`,
                        `Open Issues: ${data.open_issues_count}`,
                        `Language: ${data.language || "N/A"}`,
                        `Description: ${data.description || "No description"}`,
                    ].join(" | "),
                    link: data.html_url,
                },
            ],
        };
    } catch {
        return null;
    }
}

/**
 * Direct webpage metadata fetch for URLs.
 * Extracts <title> and <meta name="description"> from the page.
 */
async function fetchWebpageMeta(url: string): Promise<SearchResponse | null> {
    if (!/^https?:\/\//i.test(url)) return null;
    try {
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname.toLowerCase();
        const blockedHost = hostname === "localhost" || hostname === "::1" ||
            hostname.endsWith(".localhost") || hostname === "0.0.0.0" ||
            /^(10|127|169\.254|192\.168)\./.test(hostname) ||
            /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
        if (blockedHost) return null;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        const res = await fetch(url, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
            redirect: "manual",
            signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) return null;

        const html = await res.text();
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const descMatch = html.match(
            /<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["']/i
        );
        const ogDescMatch = html.match(
            /<meta[^>]*property=["']og:description["'][^>]*content=["']([\s\S]*?)["']/i
        );

        const title = titleMatch?.[1]?.trim() || url;
        const snippet =
            descMatch?.[1]?.trim() ||
            ogDescMatch?.[1]?.trim() ||
            "Page fetched successfully.";

        return {
            provider: "Direct Fetch",
            results: [{ title, snippet, link: url }],
        };
    } catch {
        return null;
    }
}

export const search = {
    name: "search",
    description: "Search the web for real-time information or inspect a URL",
    parameters: searchSchema,
    execute: async (args: z.infer<typeof searchSchema>) => {
        const parsed = searchSchema.parse(args);
        const query = parsed.query.trim();
        const tavilyKey = await ConfigManager.getTavilyApiKey();

        // Priority 1: Tavily (if configured)
        if (tavilyKey) {
            try {
                const tvly = tavily({ apiKey: tavilyKey });
                const response = await tvly.search(query);
                return { message: "Search via Tavily", data: response };
            } catch {
                // Fall through to free search
            }
        }

        // Priority 2: Direct GitHub API for github.com URLs
        const ghResult = await fetchGitHubRepo(query);
        if (ghResult && ghResult.results.length > 0) {
            return { message: `Search via ${ghResult.provider}`, data: ghResult };
        }

        // Priority 3: DuckDuckGo web search
        const ddgResult = await fetchDuckDuckGo(query);
        if (ddgResult.results.length > 0) {
            return { message: `Search via ${ddgResult.provider}`, data: ddgResult };
        }

        // Priority 4: Direct webpage fetch for URLs (when DDG returns nothing)
        const pageResult = await fetchWebpageMeta(query);
        if (pageResult && pageResult.results.length > 0) {
            return { message: `Search via ${pageResult.provider}`, data: pageResult };
        }

        // Nothing found
        return {
            message: "No results found",
            data: {
                provider: "None",
                results: [],
                error: ddgResult.error || "No results found for this query.",
            },
        };
    },
};
