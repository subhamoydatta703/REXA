import { describe, expect, test } from "bun:test";
import { SecretScanner } from "../../src/guardrails/types/SecretScanner";
import { isPublicAddress, parsePublicUrl } from "../../src/tools/web/SafeWebRequest";
import { isUrlInspectionRequest, requestUrls } from "../../src/orchestration/UrlIntent";

describe("URL-aware validation", () => {
    test("accepts a public documentation URL that exceeded the entropy threshold", () => {
        expect(SecretScanner.containsSecret("Check https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise and explain it")).toBe(false);
        expect(SecretScanner.containsSecret("Details: [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)")).toBe(false);
    });
    test.each(["https://user:password@example.com/", "https://example.com/?token=shortsecret", "https://example.com/?api_key=abcdefgh12345678", "https://example.com/?signature=shortsecret", "https://example.com/#access_token=shortsecret"])('rejects credentials in %s', url => {
        expect(SecretScanner.containsSecret(url)).toBe(true);
    });
    test("preserves secret detection outside URLs", () => {
        expect(SecretScanner.containsSecret("Check https://example.com/ api_key=abcdefghijklmnop123456789")).toBe(true);
        expect(SecretScanner.containsSecret("AKIAABCDEFGHIJKLMNOP")).toBe(true);
        expect(SecretScanner.containsSecret("aB3dE5fG7hI9jK1mN2pQ4rS6tU8vW0xY")).toBe(true);
    });
    test("redacts URL credentials before displaying retrieval errors", () => {
        expect(SecretScanner.redact("https://example.com/?token=shortsecret")).not.toContain("shortsecret");
        expect(SecretScanner.redact("https://user:password@example.com/")).not.toContain("password");
        expect(SecretScanner.redact("https://example.com/#access_token=shortsecret")).not.toContain("shortsecret");
    });
    test.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.0.1", "192.168.1.1", "198.18.0.1", "203.0.113.1", "224.1.1.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::"])('blocks non-public address %s', address => {
        expect(isPublicAddress(address)).toBe(false);
    });
    test.each(["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"])('accepts public address %s', address => {
        expect(isPublicAddress(address)).toBe(true);
    });
    test.each(["::ffff:8.8.8.8", "::ffff:808:808", "::ffff:10.1.2.3", "::ffff:192.168.1.1"])('blocks IPv4-mapped IPv6 address %s', address => {
        expect(isPublicAddress(address)).toBe(false);
    });
    test.each(["", "example.com", "999.1.1.1"])('rejects invalid address %s', address => {
        expect(isPublicAddress(address)).toBe(false);
    });
    test.each(["http://localhost/", "http://127.1/", "http://2130706433/", "http://[::ffff:127.0.0.1]/", "file:///etc/passwd", "https://user:pass@example.com/"])('rejects unsafe URL %s', url => {
        expect(() => parsePublicUrl(url)).toThrow();
    });
});

describe("inspection intent", () => {
    test.each(["Check https://example.com and give me details", "Summarize https://example.com/article", "https://example.com", "What does https://example.com describe?"])('recognizes %s', input => {
        expect(isUrlInspectionRequest(input)).toBe(true);
    });
    test.each(["Build an app using https://example.com/docs", "Add this URL https://example.com to README", "Fix the code using https://example.com/docs", "Clone https://github.com/example/repo", "const endpoint = 'https://example.com/api'"])('leaves coding and incidental references to the supervisor: %s', input => {
        expect(isUrlInspectionRequest(input)).toBe(false);
    });
    test("extracts exact URLs from markdown and removes sentence punctuation", () => {
        expect(requestUrls("Read [page](https://example.com/article). Also https://example.com/help.")).toEqual(["https://example.com/article", "https://example.com/help"]);
    });
});
