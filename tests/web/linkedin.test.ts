import { describe, expect, mock, test } from "bun:test";
import { createLinkedInReader, linkedInProfileUrl } from "../../src/tools/web/LinkedInReader";
import { createUrlReader } from "../../src/tools/ReadUrlTool";
import { WebRequestError } from "../../src/tools/web/SafeWebRequest";

const url = "https://www.linkedin.com/in/subhamoy-datta/";
const profile = { url, name: "Subhamoy Datta", position: "Developer", experience: [{ title: "Engineer", company: "Example" }], education: [{ degree: "Computer Science" }] };
function setup(responses: Array<{ data: unknown; status?: number }>, options: Parameters<typeof createLinkedInReader>[0] = {}) {
    let time = Date.parse("2026-10-10T10:00:00Z");
    const fetch = mock(async (_url: string, _init: RequestInit) => {
        const response = responses.shift();
        if (!response) throw new Error("Unexpected request");
        return new Response(JSON.stringify(response.data), { status: response.status ?? 200 });
    });
    const read = createLinkedInReader({ fetch, getKey: async () => "private-test-key", now: () => time,
        sleep: async ms => { time += ms; }, ...options });
    return { read, fetch };
}
const job = { data: { snapshot_id: "s_test123" } };
const ready = { data: { status: "ready" } };

describe("LinkedIn extraction", () => {
    test("submits one canonical URL, polls and retrieves matching structured data", async () => {
        const { read, fetch } = setup([job, { data: { status: "starting" } }, { data: { status: "running" } }, ready, { data: [profile] }]);
        const result = await read("https://in.linkedin.com/in/subhamoy-datta?trk=public");
        expect(result.url).toBe(url);
        expect(result.title).toBe("Subhamoy Datta | LinkedIn");
        expect(result.content).toContain("Computer Science");
        expect(result.content).toContain("Engineer");
        expect(result.content).toContain("Missing fields");
        expect(result.retrievedAt).toBe("2026-10-10T10:00:04.000Z");
        expect(fetch).toHaveBeenCalledTimes(5);
        const [target, init] = fetch.mock.calls[0]!;
        expect(target).toBe("https://api.brightdata.com/datasets/v3/trigger?dataset_id=gd_l1viktl72bvl7bjuj0&format=json&include_errors=true");
        expect(init.method).toBe("POST");
        expect(init.redirect).toBe("error");
        expect(JSON.parse(init.body as string)).toEqual([{ url }]);
        expect(fetch.mock.calls.slice(1).every(([target, init]) => target.startsWith("https://api.brightdata.com/datasets/v3/") && init.method === "GET")).toBe(true);
        expect(result.content).not.toContain("private-test-key");
    });

    test.each([
        "https://linkedin.com.attacker.com/in/person/", "https://attacker.com/linkedin.com/in/person/",
        "https://www.linkedin.com/company/example/", "https://www.linkedin.com/in/person/posts/",
        "https://user:pass@www.linkedin.com/in/person/", "ftp://www.linkedin.com/in/person/",
        "https://www.linkedin.com:444/in/person/",
    ])("does not send unsupported URLs to the scraper: %s", async value => {
        const { read, fetch } = setup([]);
        expect(linkedInProfileUrl(value)).toBeNull();
        await expect(read(value)).rejects.toMatchObject({ code: "invalid_url" });
        expect(fetch).not.toHaveBeenCalled();
    });

    test("missing credentials provide setup instructions without starting a collection", async () => {
        const { read, fetch } = setup([], { getKey: async () => undefined });
        await expect(read(url)).rejects.toMatchObject({ code: "configuration_required", message: expect.stringContaining("set-brightdata-key") });
        expect(fetch).not.toHaveBeenCalled();
    });

    test("accepts the sd_ snapshot IDs used by the async scraper API", async () => {
        const { read, fetch } = setup([{ data: { snapshot_id: "sd_test123" } }, ready, { data: [profile] }]);
        expect((await read(url)).title).toContain("Subhamoy Datta");
        expect(fetch.mock.calls[1]![0]).toEndWith("progress/sd_test123");
    });

    test.each(["../other", "https://attacker.com/", "s_test?token=key", null])("rejects unsafe or missing collection IDs", async snapshot_id => {
        const { read, fetch } = setup([{ data: { snapshot_id } }]);
        await expect(read(url)).rejects.toMatchObject({ code: "provider_error" });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    test.each([401, 403, 402, 429, 500])("handles provider HTTP %i without exposing response bodies or retrying a paid collection", async status => {
        const { read, fetch } = setup([{ status, data: { error: "private-test-key" } }]);
        let failure: unknown;
        try { await read(url); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(WebRequestError);
        expect((failure as Error).message).not.toContain("private-test-key");
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    test("preserves the provider's HTTP 400 explanation while removing the exact API key and echoed input", async () => {
        const { read } = setup([{ status: 400, data: {
            error: "Account is not active. Credential private-test-key rejected.",
            input: { secret: "never-display-echoed-input" },
        } }]);
        await expect(read(url)).rejects.toMatchObject({
            code: "provider_error",
            message: "Bright Data rejected the collection request (HTTP 400); no profile content was read. Provider message: Account is not active. Credential [REDACTED] rejected.",
        });
    });

    test("identifies HTTP 400 on the download rather than blaming the collection input", async () => {
        const { read } = setup([job, ready, { status: 400, data: { message: "Invalid output format" } }]);
        await expect(read(url)).rejects.toMatchObject({ message: expect.stringContaining("snapshot download (HTTP 400)") });
    });

    test("supports bounded plain-text error messages and removes the token", async () => {
        const read = createLinkedInReader({ getKey: async () => "private-test-key", fetch: async () => new Response("Invalid credentials: private-test-key", { status: 400 }) });
        await expect(read(url)).rejects.toMatchObject({ message: expect.stringContaining("Invalid credentials: [REDACTED]") });
    });

    test("does not expose HTML error pages", async () => {
        const read = createLinkedInReader({ getKey: async () => "test-key", fetch: async () => new Response("<html>private-response-content</html>", { status: 400 }) });
        await expect(read(url)).rejects.toMatchObject({ message: "Bright Data rejected the collection request (HTTP 400); no profile content was read." });
    });

    test.each(["wss://username:password@brd.superproxy.io:9222", "https://username:password@brd.superproxy.io:9515", "brd-customer-example-zone-browser:password"])("rejects Browser API credentials before sending a request", async key => {
        const { read, fetch } = setup([], { getKey: async () => key });
        await expect(read(url)).rejects.toMatchObject({ code: "configuration_required", message: expect.stringContaining("account API token") });
        expect(fetch).not.toHaveBeenCalled();
    });

    test.each(["failed", "canceled", "unknown"])("handles collection status %s", async status => {
        const { read, fetch } = setup([job, { data: { status } }]);
        await expect(read(url)).rejects.toBeInstanceOf(WebRequestError);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    test("bounds polling and submits the collection only once", async () => {
        const { read, fetch } = setup([job, { data: { status: "running" } }, { data: { status: "running" } }], { timeoutMs: 4_000 });
        await expect(read(url)).rejects.toMatchObject({ code: "timeout" });
        expect(fetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
    });

    test.each([
        { data: [] }, { data: [{ ...profile, url: "https://www.linkedin.com/in/someone-else/" }] },
        { data: [{ url, error: "Profile not found" }] }, { data: [{ url }] }, { data: [{ url, name: " " }] },
    ])("rejects empty, error and mismatched profiles", async ({ data }) => {
        const { read } = setup([job, ready, { data }]);
        await expect(read(url)).rejects.toMatchObject({ code: "content_unavailable" });
    });

    test("does not accept echoed input as proof when the returned profile URL differs", async () => {
        const { read } = setup([job, ready, { data: [{ ...profile, url: "https://www.linkedin.com/in/someone-else/", input: { url } }] }]);
        await expect(read(url)).rejects.toMatchObject({ code: "content_unavailable" });
    });

    test("rejects malformed and oversized responses", async () => {
        for (const body of ["invalid JSON", JSON.stringify({ text: "x".repeat(2_000_001) })]) {
            const read = createLinkedInReader({ getKey: async () => "test-key", fetch: async () => new Response(body) });
            await expect(read(url)).rejects.toMatchObject({ code: "provider_error" });
        }
    });

    test("does not surface network error text that may contain credentials", async () => {
        const read = createLinkedInReader({ getKey: async () => "test-key", fetch: async () => { throw new Error("test-key"); } });
        await expect(read(url)).rejects.toMatchObject({ code: "provider_error", message: "Could not contact Bright Data; no profile content was read." });
    });
});

describe("LinkedIn URL routing", () => {
    const validate = async (value: string) => new URL(value);
    test("uses profile extraction instead of blocked HTTP and marks provenance as partial", async () => {
        const request = mock(async () => { throw new Error("Should not fetch LinkedIn directly"); });
        const { read } = setup([job, ready, { data: [profile] }]);
        const result = await createUrlReader({ validate, request, linkedIn: read })(url);
        expect(result.success).toBe(true);
        expect(result.provider).toBe("Bright Data LinkedIn Profiles");
        expect(result.status).toBe("partial");
        expect(result.content).toContain("Subhamoy Datta");
        expect(result.retrievedAt).toBeDefined();
        expect(result.httpStatus).toBeUndefined();
        expect(request).not.toHaveBeenCalled();
    });
    test("reports extraction failures without inventing profile details", async () => {
        const { read } = setup([], { getKey: async () => undefined });
        const result = await createUrlReader({ validate, linkedIn: read })(url);
        expect(result.success).toBe(false);
        expect(result.status).toBe("configuration_required");
        expect(result.content).toBe("");
    });
    test("keeps company pages on the ordinary reader", async () => {
        const linkedIn = mock(async () => { throw new Error("Not a profile"); });
        const result = await createUrlReader({ validate, linkedIn, request: async value => ({ url: value, status: 999, headers: {}, body: Buffer.from("") }) })("https://www.linkedin.com/company/example/");
        expect(result.status).toBe("access_blocked");
        expect(linkedIn).not.toHaveBeenCalled();
    });
    test("rejects unsafe destinations and secret URLs before calling the provider", async () => {
        const linkedIn = mock(async () => { throw new Error("Should not extract"); });
        const read = createUrlReader({ linkedIn, validate: async () => { throw new WebRequestError("blocked", "Unsafe destination"); } });
        expect((await read(url)).status).toBe("blocked");
        expect((await read(`${url}?token=some-secret-value`)).status).toBe("blocked");
        expect(linkedIn).not.toHaveBeenCalled();
    });
});
