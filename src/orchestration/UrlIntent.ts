export function requestUrls(input: string): string[] {
    return [...new Set((input.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [])
        .map(url => url.replace(/[),.;\]}]+$/, "")))].slice(0, 3);
}

/** Conservative shortcut only; ambiguous requests remain the supervisor's job. */
export function isUrlInspectionRequest(input: string): boolean {
    if (!requestUrls(input).length) return false;
    const prose = input.replace(/https?:\/\/[^\s<>"'`]+/gi, " ").trim();
    if (!prose) return true;
    // Implementation requests that refer to a site still need the coding workflow.
    if (/\b(build|implement|integrate|install|migrate|upgrade|clone|deploy|recreate|replicate|commit|push)\b/i.test(prose) ||
        /\b(fix|edit|modify|create|write|add|update|change)\b[\s\S]*\b(code|file|app|website|component|function|repository|repo|project|test|feature|readme)\b/i.test(prose)) return false;
    return /\b(check|inspect|read|summari[sz]e|analy[sz]e|review|explain|describe|details|information|tell me|what is|what does|compare|look at)\b/i.test(prose);
}
