import { describe, expect, test, mock } from "bun:test";
import { createUrlReader } from "../../src/tools/ReadUrlTool";
import { extractPageContent, MAX_PAGE_CHARACTERS } from "../../src/tools/web/PageContent";
import { WebRequestError, type WebResponse } from "../../src/tools/web/SafeWebRequest";
import { createSearchTool, parseSearchResults } from "../../src/tools/SearchTool";

const url = "https://example.com/article";
const prose = "This is the actual article body, which explains a useful subject in detail. ".repeat(8);
function response(body: string, options: Partial<WebResponse> = {}): WebResponse {
    return { url, status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(body), ...options };
}
function reader(body: string, overrides: Parameters<typeof createUrlReader>[0] = {}) {
    return createUrlReader({ validate: async value => new URL(value), request: async () => response(body),
        render: async () => { throw new WebRequestError("browser_unavailable", "Browser unavailable."); }, extract: async () => null, ...overrides });
}

describe("exact page reading", () => {
    test("returns page body rather than metadata, removes navigation and scripts", async () => {
        const read = reader(`<html><head><title>Article</title><meta name="description" content="Metadata only"></head><body><nav>Navigation junk</nav><main><h1>Facts</h1><p>${prose}</p><script>ignored()</script></main></body></html>`);
        const result = await read(url);
        expect(result.success).toBe(true);
        expect(result.title).toBe("Article");
        expect(result.content).toContain(prose.trim());
        expect(result.content).not.toContain("Navigation junk");
        expect(result.content).not.toContain("ignored()");
        expect(result.metadataOnly).toBe(false);
    });

    test("preserves redirect destination as source evidence", async () => {
        const result = await reader(`<main>${prose}</main>`, { request: async () => response(`<main>${prose}</main>`, { url: "https://example.com/final" }) })(url);
        expect(result.requestedUrl).toBe(url);
        expect(result.finalUrl).toBe("https://example.com/final");
    });

    test.each([401, 403, 404, 429, 500])("reports HTTP %i without fabricating content", async status => {
        const render = mock(async () => ({ html: "", url, status: 200, partial: false }));
        const result = await reader("<main>Not the requested document</main>", { request: async () => response("", { status }), render })(url);
        expect(result.success).toBe(false);
        expect(result.httpStatus).toBe(status);
        expect(result.content).toBe("");
        expect(render).not.toHaveBeenCalled();
    });

    test("does not interpret binary files as HTML", async () => {
        const result = await reader("%PDF", { request: async () => response("%PDF", { headers: { "content-type": "application/pdf" } }) })(url);
        expect(result.status).toBe("unsupported");
        expect(result.success).toBe(false);
    });

    test("uses rendered page content for an application shell", async () => {
        const render = mock(async () => ({ html: `<main>${prose}</main>`, url, status: 200, partial: false }));
        const result = await reader("<html><head><title>App</title></head><body><div id=root>Loading...</div></body></html>", { render })(url);
        expect(result.success).toBe(true);
        expect(result.provider).toBe("Browser");
        expect(result.content).toContain(prose.trim());
    });

    test("returns an honest failure when only metadata is accessible", async () => {
        const result = await reader('<html><head><title>App</title><meta content="A product" name="description"></head><body><div id=root></div></body></html>')(url);
        expect(result.success).toBe(false);
        expect(result.metadataOnly).toBe(true);
        expect(result.content).toBe("");
        expect(result.description).toBe("A product");
        expect(result.warnings).toContain("Browser unavailable.");
    });

    test("provider extraction is explicit and marked partial", async () => {
        const result = await reader("<html><body></body></html>", { extract: async () => ({ title: "Provider result", content: prose }) })(url);
        expect(result.provider).toBe("Tavily Extract");
        expect(result.status).toBe("partial");
        expect(result.success).toBe(true);
    });

    test("HTTP 200 login pages are not treated as the requested content", async () => {
        const result = await reader("<html><head><title>Sign in</title></head><body><main>Enter your account details to continue.</main></body></html>")(url);
        expect(result.success).toBe(false);
        expect(result.status).toBe("access_blocked");
        expect(result.content).toBe("");
    });

    test("retrieval timeouts are distinct from empty search results", async () => {
        const result = await reader("", { request: async () => { throw new WebRequestError("timeout", "Page retrieval timed out."); } })(url);
        expect(result.status).toBe("timeout");
        expect(result.success).toBe(false);
        expect(result.error).toContain("timed out");
    });

    test("marks truncated content and keeps a bounded context", async () => {
        const result = await reader(`<main>${"Words about this article. ".repeat(2000)}</main>`)(url);
        expect(result.content.length).toBeLessThanOrEqual(MAX_PAGE_CHARACTERS);
        expect(result.truncated).toBe(true);
        expect(result.partial).toBe(true);
    });

    test("reads GitHub file contents instead of repository statistics", async () => {
        let requested = "";
        const result = await reader("", { request: async value => { requested = value; return response("export const answer = 42;", { headers: { "content-type": "text/plain" } }); } })("https://github.com/owner/repo/blob/main/src/main.ts");
        expect(requested).toBe("https://api.github.com/repos/owner/repo/contents/src/main.ts?ref=main");
        expect(result.content).toBe("export const answer = 42;");
        expect(result.provider).toBe("GitHub API");
    });

    test("reads issue body and discloses missing comments", async () => {
        const result = await reader("", { request: async value => {
            expect(value).toBe("https://api.github.com/repos/owner/repo/issues/23");
            return response(JSON.stringify({ title: "Bug report", body: prose, state: "open" }));
        } })("https://github.com/owner/repo/issues/23");
        expect(result.content).toContain(prose);
        expect(result.partial).toBe(true);
        expect(result.warnings.join(" ")).toContain("comments");
    });

    test("rejects credential URLs before making network requests", async () => {
        const request = mock(async () => response(""));
        const result = await reader("", { request })("https://example.com/page?token=super-secret-value");
        expect(result.status).toBe("blocked");
        expect(result.requestedUrl).not.toContain("super-secret-value");
        expect(request).not.toHaveBeenCalled();
    });

    test("DOM extraction handles entities, tables, and uppercase markup", () => {
        const content = extractPageContent('<HTML><BODY><MAIN><H1>Pricing &amp; features</H1><TABLE><TR><TD>Basic</TD><TD>$10</TD></TR></TABLE></MAIN></BODY></HTML>');
        expect(content.content).toContain("Pricing & features");
        expect(content.content).toContain("Basic");
        expect(content.content).toContain("$10");
    });
});

describe("search is source discovery", () => {
    test("matches each organic result with its own snippet", () => {
        const results = parseSearchResults('<div class="result result--ad"><a class="result__a" href="https://ads.example/">Ad</a><a class="result__snippet">Wrong snippet</a></div><div class="result"><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle" class="result__a">Article &amp; facts</a><span class="result__snippet">Correct snippet</span></div>');
        expect(results).toEqual([{ title: "Article & facts", snippet: "Correct snippet", link: url }]);
    });
    test("empty Tavily responses fall back with a diagnostic", async () => {
        const tool = createSearchTool({ providerSearch: async () => [], request: async () => response('<div class="result"><a class="result__a" href="https://example.com/article">Article</a><a class="result__snippet">Excerpt</a></div>') });
        const result = await tool.execute({ query: "a research topic" });
        expect(result.success).toBe(true);
        expect(result.data.provider).toBe("DuckDuckGo");
        expect(result.data.warnings[0]).toContain("no useful results");
    });
    test("search does not claim to inspect a URL", async () => {
        const request = mock(async () => response(""));
        const result = await createSearchTool({ providerSearch: async () => null, request }).execute({ query: url });
        expect(result.success).toBe(false);
        expect(result.message).toContain("read_url");
        expect(request).not.toHaveBeenCalled();
    });
});
