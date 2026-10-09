import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";

export class WebRequestError extends Error {
    constructor(public readonly code: string, message: string, cause?: unknown) { super(message, { cause }); }
}

// Keep families separate: IPv6 subnets can also match IPv4-mapped addresses
// when BlockList checks an IPv4 address, so ::/3 would block public IPv4 too.
const blockedIPv4 = new BlockList();
const blockedIPv6 = new BlockList();
for (const [address, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedIPv4.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
    ["::", 3], ["4000::", 2], ["8000::", 1], ["2001::", 23],
    ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) blockedIPv6.addSubnet(address, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 4) return !blockedIPv4.check(address, "ipv4");
    if (family === 6) return !blockedIPv6.check(address, "ipv6");
    return false;
}

export function parsePublicUrl(value: string): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw new WebRequestError("invalid_url", "A valid HTTP or HTTPS URL is required."); }
    if (!["http:", "https:"].includes(url.protocol)) {
        throw new WebRequestError("invalid_url", "Only HTTP and HTTPS pages can be read.");
    }
    if (url.username || url.password) throw new WebRequestError("blocked", "URLs containing login credentials are not accepted.");
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
    if (hostname === "localhost" || /\.(localhost|local|internal)$/.test(hostname) ||
        (isIP(hostname) !== 0 && !isPublicAddress(hostname))) {
        throw new WebRequestError("blocked", "Private, local, and reserved network destinations are not allowed.");
    }
    return url;
}

export async function validatePublicUrl(value: string): Promise<URL> {
    const url = parsePublicUrl(value);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([publicAddresses(url), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new WebRequestError("timeout", "DNS validation timed out.")), 10_000);
        })]);
        return url;
    } finally { clearTimeout(timer); }
}

type ResolveAddresses = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const resolveAddresses: ResolveAddresses = hostname => lookup(hostname, { all: true });

async function publicAddresses(url: URL, resolve = resolveAddresses): Promise<Array<{ address: string; family: number }>> {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
        throw new WebRequestError("blocked", "The hostname resolves to a private, local, or reserved address.");
    }
    return addresses;
}

export interface WebResponse {
    url: string;
    status: number;
    headers: Record<string, string>;
    body: Buffer;
}

export interface WebRequestOptions {
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    followRedirects?: boolean;
    accept?: string;
}

/** Validate every destination and pin the socket to the checked DNS address. */
export function createWebRequester(dependencies: { resolve?: ResolveAddresses; http?: typeof httpRequest; https?: typeof httpsRequest } = {}) {
    return async function requestPage(value: string, options: WebRequestOptions = {}): Promise<WebResponse> {
        const timeoutMs = options.timeoutMs ?? 15_000;
        const maxBytes = options.maxBytes ?? 2_000_000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            let url = parsePublicUrl(value);
            for (let redirects = 0; ; redirects++) {
                // DNS resolution shares the request deadline, including redirects and body reads.
                const addresses = await Promise.race([
                    publicAddresses(url, dependencies.resolve),
                    new Promise<never>((_, reject) => {
                        if (controller.signal.aborted) return reject(new WebRequestError("timeout", "Page retrieval timed out."));
                        controller.signal.addEventListener("abort", () => reject(new WebRequestError("timeout", "Page retrieval timed out.")), { once: true });
                    }),
                ]);
                const address = addresses[0]!;
                const result = await new Promise<WebResponse>((resolve, reject) => {
                    const send = url.protocol === "https:" ? dependencies.https ?? httpsRequest : dependencies.http ?? httpRequest;
                    const req = send(url, {
                        agent: false,
                        family: address.family,
                        signal: controller.signal,
                        headers: { "User-Agent": "REXA-Agent/2.0 (page reader)", Accept: options.accept ?? "text/html, text/plain, application/json;q=0.9", "Accept-Encoding": "identity" },
                        lookup: (_hostname, options, callback) => {
                            if (options.all) callback(null, [address]);
                            else callback(null, address.address, address.family);
                        },
                    }, res => {
                        const chunks: Buffer[] = [];
                        let bytes = 0;
                        res.on("data", (chunk: Buffer) => {
                            bytes += chunk.length;
                            if (bytes > maxBytes) {
                                const error = new WebRequestError("too_large", `Response exceeds the ${maxBytes}-byte download limit.`);
                                reject(error);
                                res.destroy(error);
                                req.destroy(error);
                            } else chunks.push(chunk);
                        });
                        res.on("error", reject);
                        res.on("end", () => {
                            if (bytes > maxBytes) return;
                            try {
                                const headers: Record<string, string> = {};
                                for (const [key, val] of Object.entries(res.headers)) if (val !== undefined) headers[key] = Array.isArray(val) ? val.join(", ") : val;
                                let body = Buffer.concat(chunks);
                                const encoding = headers["content-encoding"];
                                const limits = { maxOutputLength: maxBytes };
                                if (encoding === "gzip") body = gunzipSync(body, limits);
                                else if (encoding === "deflate") body = inflateSync(body, limits);
                                else if (encoding === "br") body = brotliDecompressSync(body, limits);
                                else if (encoding && encoding !== "identity") throw new WebRequestError("unsupported", "Unsupported response encoding.");
                                if (body.length > maxBytes) throw new WebRequestError("too_large", "Decompressed response exceeds the download limit.");
                                delete headers["content-encoding"];
                                delete headers["transfer-encoding"];
                                delete headers["connection"];
                                delete headers["set-cookie"];
                                headers["content-length"] = String(body.length);
                                resolve({ url: url.href, status: res.statusCode ?? 0, headers, body });
                            } catch (error) { reject(error); }
                        });
                    });
                    req.on("error", reject);
                    req.end();
                });
                if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
                    const next = parsePublicUrl(new URL(result.headers.location, url).href);
                    if (url.protocol === "https:" && next.protocol !== "https:") throw new WebRequestError("blocked", "HTTPS to HTTP redirects are not allowed.");
                    if (options.followRedirects === false) return result;
                    if (redirects >= (options.maxRedirects ?? 5)) throw new WebRequestError("redirect_limit", "Too many redirects.");
                    url = next;
                    continue;
                }
                return result;
            }
        } catch (error) {
            if (controller.signal.aborted) throw new WebRequestError("timeout", "Page retrieval timed out.");
            if (error instanceof WebRequestError) throw error;
            if (error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE") throw new WebRequestError("too_large", "Decompressed response exceeds the download limit.");
            throw new WebRequestError("network_error", "Could not retrieve the page (DNS, connection, or TLS failure).", error);
        } finally { clearTimeout(timer); }
    };
}

export const safeWebRequest = createWebRequester();
