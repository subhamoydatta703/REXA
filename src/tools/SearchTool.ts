import { z } from "zod";
import { parseHTML } from "linkedom";
import type { Tool } from "./ToolRegistry";
import { safeWebRequest } from "./web/SafeWebRequest";
import { SecretScanner } from "../guardrails/types/SecretScanner";

const searchSchema = z.object({ query: z.string().min(1).max(2000).describe("Search terms to discover sources. Use read_url to inspect an exact URL.") });
export interface SearchResult { title: string; snippet: string; link: string; }

export function parseSearchResults(html: string): SearchResult[] {
    const { document } = parseHTML(html);
    const results: SearchResult[] = [];
    for (const block of document.querySelectorAll(".result")) {
        if (block.classList.contains("result--ad")) continue;
        const anchor = block.querySelector(".result__a");
        const href = anchor?.getAttribute("href");
        if (!href || !anchor) continue;
        try {
            const redirect = new URL(href, "https://duckduckgo.com");
            const target = new URL(redirect.searchParams.get("uddg") || redirect.href);
            if (!["http:", "https:"].includes(target.protocol) || target.pathname === "/y.js") continue;
            results.push({ title: SecretScanner.redact(anchor.textContent?.trim() || target.hostname), snippet: SecretScanner.redact(block.querySelector(".result__snippet")?.textContent?.trim().slice(0, 2000) || ""), link: SecretScanner.redact(target.href) });
            if (results.length === 5) break;
        } catch { /* malformed result links are not sources */ }
    }
    return results;
}

async function tavilySearch(query: string): Promise<SearchResult[] | null> {
    const { ConfigManager } = await import("../config/ConfigManager");
    const key = await ConfigManager.getTavilyApiKey();
    if (!key) return null;
    const { tavily } = await import("@tavily/core");
    const response = await tavily({ apiKey: key }).search(query, { maxResults: 5, timeout: 15, includeRawContent: false });
    return response.results.filter(result => result.url && result.content).map(result => ({ title: SecretScanner.redact(result.title), snippet: SecretScanner.redact(result.content.slice(0, 2000)), link: SecretScanner.redact(result.url) }));
}

export function createSearchTool(dependencies = { request: safeWebRequest, providerSearch: tavilySearch }): Tool {
    return {
        name: "search",
        description: "Search the web to discover sources. Returns search snippets, not verified page contents. Use read_url to read or inspect a supplied URL or a discovered source.",
        parameters: searchSchema,
        execute: async (args: z.infer<typeof searchSchema>) => {
            const query = searchSchema.parse(args).query.trim();
            if (/^https?:\/\/\S+$/i.test(query)) return { success: false, message: "Use read_url to inspect this exact URL; search does not read pages.", data: { provider: "None", results: [], error: "url_requires_read_url" } };
            const warnings: string[] = [];
            try {
                const results = await dependencies.providerSearch(query);
                if (results?.length) return { success: true, message: "Search via Tavily (snippets only)", data: { provider: "Tavily", results, warnings } };
                if (results) warnings.push("Tavily returned no useful results; tried DuckDuckGo.");
            } catch { warnings.push("Tavily search failed; tried DuckDuckGo."); }
            try {
                const response = await dependencies.request(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
                if (response.status !== 200) throw new Error("Search endpoint returned an unsuccessful status.");
                const results = parseSearchResults(response.body.toString("utf8"));
                return { success: results.length > 0, message: results.length ? "Search via DuckDuckGo (snippets only)" : "No usable search results were retrieved", data: { provider: "DuckDuckGo", results, warnings, ...(results.length ? {} : { error: "No matching results, or the search endpoint returned an unrecognized page or access challenge." }) } };
            } catch { return { success: false, message: "Web search failed", data: { provider: "None", results: [], warnings, error: "Could not retrieve search results. No page contents were obtained." } }; }
        },
    };
}

export const search = createSearchTool();
