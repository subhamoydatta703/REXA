import { expect, test } from "bun:test";
import { renderPage } from "../../src/tools/web/BrowserReader";
import { extractPageContent } from "../../src/tools/web/PageContent";
import { safeWebRequest, type WebResponse } from "../../src/tools/web/SafeWebRequest";

test("real Chromium renders JavaScript and retrieves data through the controlled transport", async () => {
    const seen: string[] = [];
    const request: typeof safeWebRequest = async url => {
        seen.push(url);
        const path = new URL(url).pathname;
        const body = path === "/data" ? JSON.stringify({ text: "This content was loaded by JavaScript from a read-only data endpoint." }) : '<html><head><title>Dynamic fixture</title></head><body><main>Loading...</main><script>fetch("/data").then(r=>r.json()).then(data=>{document.querySelector("main").textContent=data.text;});</script></body></html>';
        return { url, status: 200, headers: { "content-type": path === "/data" ? "application/json" : "text/html" }, body: Buffer.from(body) };
    };
    const result = await renderPage("https://fixture.example/app", request, async url => new URL(url));
    expect(extractPageContent(result.html).content).toContain("This content was loaded by JavaScript");
    expect(seen).toContain("https://fixture.example/data");
    expect(result.status).toBe(200);
}, 40_000);

test("browser subrequests to local destinations are rejected and disclosed as partial", async () => {
    const attempted: string[] = [];
    const request: typeof safeWebRequest = async url => {
        if (new URL(url).hostname !== "fixture.example") {
            attempted.push(url);
            return safeWebRequest(url);
        }
        const response: WebResponse = { url, status: 200, headers: { "content-type": "text/html" }, body: Buffer.from('<html><body><main>Public content.</main><script>fetch("http://127.0.0.1/private").catch(()=>{});</script></body></html>') };
        return response;
    };
    const result = await renderPage("https://fixture.example/app", request, async url => new URL(url));
    expect(attempted).toEqual(["http://127.0.0.1/private"]);
    expect(result.partial).toBe(true);
    expect(extractPageContent(result.html).content).toContain("Public content.");
}, 40_000);
