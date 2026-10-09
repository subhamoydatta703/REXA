import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, request as httpRequest, type RequestOptions, type IncomingMessage } from "node:http";
import { gzipSync } from "node:zlib";
import { createWebRequester, WebRequestError } from "../../src/tools/web/SafeWebRequest";

let port: number;
let calls = 0;
let pinned = false;
const server = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "/article" }); res.end(); }
    else if (req.url === "/private") { res.writeHead(302, { location: "http://private.example/article" }); res.end(); }
    else if (req.url === "/loop") { res.writeHead(302, { location: "/loop" }); res.end(); }
    else if (req.url === "/large") { res.end("x".repeat(5000)); }
    else if (req.url === "/gzip") { res.writeHead(200, { "content-encoding": "gzip" }); res.end(gzipSync("x".repeat(5000))); }
    else if (req.url === "/slow") {
        res.writeHead(200); res.write("start");
        const timer = setTimeout(() => res.end("end"), 500);
        res.on("close", () => clearTimeout(timer));
    } else { res.writeHead(200, { "content-type": "text/plain" }); res.end("The exact document body."); }
});
beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an HTTP listening address");
    port = address.port;
});
afterAll(() => server.close());

// The injected adapter maps public fixture URLs onto a controlled local server.
// Production requests use the DNS-pinned adapter, never this test mapping.
const adapter = ((url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    calls++;
    pinned = typeof options.lookup === "function" && options.agent === false;
    return httpRequest(`http://127.0.0.1:${port}${url.pathname}`, { ...options, lookup: undefined }, callback);
}) as typeof httpRequest;
const request = createWebRequester({ http: adapter, resolve: async hostname => [{ address: hostname === "private.example" ? "10.0.0.1" : "93.184.216.34", family: 4 }] });

describe("bounded HTTP transport", () => {
    test("reads real streamed HTTP bodies using a pinned-address transport", async () => {
        const result = await request("http://public.example/article");
        expect(result.body.toString()).toBe("The exact document body.");
        expect(pinned).toBe(true);
    });
    test("follows relative redirects and reports the final URL", async () => {
        const result = await request("http://public.example/redirect");
        expect(result.url).toBe("http://public.example/article");
    });
    test("revalidates redirect DNS before opening another socket", async () => {
        const initialCalls = calls;
        await expect(request("http://public.example/private")).rejects.toMatchObject({ code: "blocked" });
        expect(calls - initialCalls).toBe(1);
    });
    test("rejects mixed public/private DNS responses", async () => {
        const mixed = createWebRequester({ http: adapter, resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }] });
        const initialCalls = calls;
        await expect(mixed("http://public.example/article")).rejects.toMatchObject({ code: "blocked" });
        expect(calls).toBe(initialCalls);
    });
    test("limits redirect loops", async () => {
        await expect(request("http://public.example/loop", { maxRedirects: 2 })).rejects.toMatchObject({ code: "redirect_limit" });
    });
    test("bounds downloaded bodies", async () => {
        await expect(request("http://public.example/large", { maxBytes: 1000 })).rejects.toMatchObject({ code: "too_large" });
    });
    test("bounds decompressed bodies", async () => {
        await expect(request("http://public.example/gzip", { maxBytes: 1000 })).rejects.toBeInstanceOf(WebRequestError);
    });
    test("keeps timeout active while reading the body", async () => {
        await expect(request("http://public.example/slow", { timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
    });
    test("DNS lookup shares the overall deadline", async () => {
        const stalled = createWebRequester({ resolve: () => new Promise(() => {}) });
        await expect(stalled("https://public.example/", { timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
    });
});
