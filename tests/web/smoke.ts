import { createUrlReader } from "../../src/tools/ReadUrlTool";

// Opt-in live retrieval check. No model calls, credentials, or provider extraction.
const read = createUrlReader({ extract: async () => null });
for (const url of [
    "https://example.com/",
    "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise",
    "https://github.com/mozilla/readability",
]) {
    const result = await read(url);
    console.log(JSON.stringify({ url, finalUrl: result.finalUrl, success: result.success, status: result.status, provider: result.provider, characters: result.content.length, title: result.title, warnings: result.warnings, error: result.error }));
    if (!result.success || !result.content.trim()) process.exitCode = 1;
}
