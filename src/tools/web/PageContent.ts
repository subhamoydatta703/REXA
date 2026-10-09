import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

export const MAX_PAGE_CHARACTERS = 30_000;

export interface PageContent {
    title: string;
    content: string;
    description: string;
    truncated: boolean;
    metadataOnly: boolean;
}

export function extractPageContent(html: string): PageContent {
    const { document } = parseHTML(html);
    const title = document.title?.trim() ?? "";
    const description = document.querySelector('meta[name="description"], meta[property="og:description"]')?.getAttribute("content")?.trim() ?? "";
    for (const node of document.querySelectorAll("script, style, noscript, template, svg, nav, footer, header, aside, form, [hidden], [aria-hidden=true]")) node.remove();
    // Readability works best on prose; main/body remains useful for docs, tables, and landing pages.
    let article: ReturnType<Readability["parse"]> = null;
    try { article = new Readability(document.cloneNode(true) as Document, { maxElemsToParse: 25_000 }).parse(); } catch { /* use semantic content below */ }
    const semanticRoot = document.querySelector("main, article, [role=main]");
    const articleRoot = article?.content && (article.length ?? 0) >= 200 ? parseHTML(`<html><body>${article.content}</body></html>`).document.body : null;
    const root = semanticRoot ?? articleRoot ?? document.body ?? document.documentElement;
    for (const node of root.querySelectorAll("p, div, section, article, h1, h2, h3, h4, li, tr, pre, br")) node.appendChild(document.createTextNode("\n"));
    const mainText = (root.textContent ?? "").replace(/[\t ]+/g, " ").replace(/\n\s*\n/g, "\n\n").trim();
    const content = mainText || article?.textContent?.trim() || "";
    return {
        title: title || article?.title || "",
        description,
        content: content.slice(0, MAX_PAGE_CHARACTERS),
        truncated: content.length > MAX_PAGE_CHARACTERS,
        metadataOnly: content.length === 0,
    };
}
