// Run with Node: Playwright's Chromium pipes and websocket client hang under Bun on Windows.
// Browser network requests are fulfilled only by the parent's validated HTTP transport.
import { chromium } from "playwright";
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
const pending = new Map();
let sequence = 0;
let browser;
let started = false;
let closing = false;
let phase = "launch";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
async function close() {
    if (closing) return;
    closing = true;
    try { await browser?.close(); } finally { process.exit(0); }
}
process.stdin.on("end", close);
process.on("SIGTERM", close);
process.on("SIGINT", close);
setTimeout(() => { send({ type: "error", code: "timeout" }); void close(); }, 35_000).unref();

function retrieve(url) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ type: "request", id, url });
    });
}

async function render(url) {
    browser = await chromium.launch({ headless: true, timeout: 10_000,
        args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-quic"] });
    phase = "render";
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    await context.routeWebSocket("**/*", socket => socket.close());
    let requests = 0;
    let partial = false;
    let mainStatus;
    await context.route("**/*", async route => {
        const request = route.request();
        if (++requests > 60 || request.method() !== "GET" || ["image", "media", "font"].includes(request.resourceType())) {
            if (!["image", "media", "font"].includes(request.resourceType())) partial = true;
            await route.abort(); return;
        }
        try {
            const response = await retrieve(request.url());
            if (request.isNavigationRequest() && request.frame().parentFrame() === null) mainStatus = response.status;
            await route.fulfill({ status: response.status, headers: response.headers, body: Buffer.from(response.body, "base64") });
        } catch { partial = true; await route.abort().catch(() => {}); }
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    try { await page.waitForLoadState("networkidle", { timeout: 4_000 }); } catch { partial = true; }
    const html = await page.content();
    if (html.length > 2_000_000 || mainStatus === undefined) throw new Error("No bounded page content");
    const result = { type: "result", html, url: page.url(), status: mainStatus, partial };
    await browser.close();
    browser = undefined;
    send(result);
}

lines.on("line", line => {
    try {
        const message = JSON.parse(line);
        if (message.type === "start" && !started && typeof message.url === "string") {
            started = true;
            void render(message.url).catch(async () => { send({ type: "error", code: phase === "launch" ? "browser_unavailable" : "render_failed" }); await close(); });
        } else if (typeof message.id === "number" && pending.has(message.id)) {
            const request = pending.get(message.id);
            pending.delete(message.id);
            if (message.response) request.resolve(message.response); else request.reject(new Error("Resource unavailable"));
        }
    } catch { send({ type: "error" }); void close(); }
});
