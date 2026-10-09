import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { safeWebRequest, validatePublicUrl, WebRequestError } from "./SafeWebRequest";

export interface RenderedPage { html: string; url: string; status: number; partial: boolean; }

/** Node owns Chromium's pipes; Bun performs every validated, DNS-pinned HTTP request. */
export async function renderPage(url: string, request = safeWebRequest, validate = validatePublicUrl): Promise<RenderedPage> {
    await validate(url);
    const env: Record<string, string> = {};
    for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PLAYWRIGHT_BROWSERS_PATH"]) {
        if (process.env[key]) env[key] = process.env[key]!;
    }
    const localBrowsers = fileURLToPath(new URL("../../../.cache/ms-playwright/", import.meta.url));
    if (!env.PLAYWRIGHT_BROWSERS_PATH && existsSync(localBrowsers)) env.PLAYWRIGHT_BROWSERS_PATH = localBrowsers;
    const worker = spawn("node", [fileURLToPath(new URL("./BrowserWorker.mjs", import.meta.url))], { env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const lines = createInterface({ input: worker.stdout });
    let bytes = 0;
    let requests = 0;
    const deadline = Date.now() + 40_000;
    try {
        return await new Promise<RenderedPage>((resolve, reject) => {
            let finished = false;
            const finish = (error?: Error, result?: RenderedPage) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                worker.stdin.end();
                if (error) reject(error); else if (result) resolve(result);
            };
            const timer = setTimeout(() => {
                finish(new WebRequestError("timeout", "Browser rendering timed out."));
                worker.kill();
            }, 40_000);
            worker.once("error", () => finish(new WebRequestError("browser_unavailable", "Browser rendering needs Node.js 20 or newer and Chromium. Run `bunx playwright install chromium` to install the browser.")));
            worker.once("exit", () => { if (!finished) finish(new WebRequestError("browser_unavailable", "Browser rendering failed. Check Node.js and run `bunx playwright install chromium`.")); });
            worker.stdin.on("error", () => finish(new WebRequestError("browser_unavailable", "The browser worker stopped unexpectedly.")));
            const reply = (message: unknown) => { if (!finished && worker.stdin.writable) worker.stdin.write(JSON.stringify(message) + "\n"); };
            lines.on("line", line => {
                if (finished) return;
                if (line.length > 3_000_000) { finish(new WebRequestError("too_large", "Rendered page exceeds the content limit.")); return; }
                let message: Record<string, unknown>;
                try {
                    const data: unknown = JSON.parse(line);
                    if (!data || typeof data !== "object") throw new Error("Invalid worker message");
                    message = data as Record<string, unknown>;
                } catch { finish(new WebRequestError("browser_error", "Invalid browser response.")); return; }
                if (message.type === "request" && typeof message.id === "number" && typeof message.url === "string") {
                    const { id, url: target } = message;
                    if (++requests > 60 || bytes >= 8_000_000 || Date.now() >= deadline) { reply({ id, error: "Browser retrieval budget exceeded." }); return; }
                    void request(target, { timeoutMs: Math.max(1, Math.min(10_000, deadline - Date.now())), followRedirects: false, accept: "*/*" }).then(response => {
                        bytes += response.body.length;
                        if (bytes > 8_000_000) reply({ id, error: "Browser download budget exceeded." });
                        else reply({ id, response: { status: response.status, headers: response.headers, body: response.body.toString("base64") } });
                    }).catch(() => reply({ id, error: "The resource could not be retrieved safely." }));
                } else if (message.type === "result" && typeof message.html === "string" && typeof message.url === "string" && typeof message.status === "number" && typeof message.partial === "boolean") {
                    const { html, url: finalUrl, status, partial } = message;
                    if (html.length > 2_000_000) { finish(new WebRequestError("too_large", "Rendered page exceeds the content limit.")); return; }
                    void validate(finalUrl).then(() => finish(undefined, { html, url: finalUrl, status, partial })).catch(() => finish(new WebRequestError("blocked", "The rendered page navigated to an unsafe destination.")));
                } else if (message.type === "error") {
                    const code = message.code === "timeout" ? "timeout" : message.code === "render_failed" ? "render_failed" : "browser_unavailable";
                    finish(new WebRequestError(code, code === "browser_unavailable" ? "Browser rendering is unavailable. Check Node.js 20+ and run `bunx playwright install chromium`." : code === "timeout" ? "Browser rendering timed out." : "The browser could not load or render the requested page."));
                }
            });
            worker.stdin.write(JSON.stringify({ type: "start", url }) + "\n");
        });
    } finally { lines.close(); worker.stdin.end(); }
}
