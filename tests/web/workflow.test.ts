import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { Orchestrator } from "../../src/orchestration/Orchestrator";
import { Agent } from "../../src/agent/Agent";
import { ResearchAgent } from "../../src/agent/ResearchAgent";
import { ToolRegistry } from "../../src/tools/ToolRegistry";
import { InputGuardrails } from "../../src/guardrails/input/InputGuardrails";
import { researchContextMessage, MAX_RESEARCH_CHARACTERS } from "../../src/agent/ResearchContext";
import type { LLMProvider } from "../../src/providers/LLMProvider";
import type { Message } from "../../src/agent/Message";
import type { LLMResponse, SupervisorDecision } from "../../src/providers/LLMResponse";
import type { UrlReadResult } from "../../src/tools/ReadUrlTool";

// This suite exercises actual local validators and fake model responses, never API keys.
const savedKeys = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, GEMINI_GUARD_API_KEY: process.env.GEMINI_GUARD_API_KEY };
beforeAll(() => { delete process.env.GEMINI_API_KEY; delete process.env.GEMINI_GUARD_API_KEY; });
afterAll(() => {
    for (const [name, value] of Object.entries(savedKeys)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
});
const safeInput = { validate: async () => ({ isSafe: true }) };
function decision(route: SupervisorDecision["route"]) { return { decide: mock(async () => ({ route, reason: "fixture" })) }; }
const answer = { role: "assistant", text: "A verified research answer." };

describe("research orchestration", () => {
    test("explicit inspection bypasses ambiguous model routing and never invokes coding", async () => {
        const supervisor = decision("CODE_ONLY");
        const execute = mock(async () => answer);
        const run = mock(async () => answer);
        const onToken = mock(() => {});
        const result = await new Orchestrator(supervisor, { execute }, { run }, safeInput).run("Check https://example.com and give me details", "act", { onToken });
        expect(result).toEqual(answer);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(run).not.toHaveBeenCalled();
        expect(supervisor.decide).not.toHaveBeenCalled();
        expect(onToken).toHaveBeenCalledWith(answer.text);
    });
    test("research-only classification also works without an explicit URL", async () => {
        const run = mock(async () => answer);
        const result = await new Orchestrator(decision("RESEARCH_ONLY"), { execute: async () => answer }, { run }, safeInput).run("Research current browser features");
        expect(result).toEqual(answer);
        expect(run).not.toHaveBeenCalled();
    });
    test("plan mode runs neither research nor URL retrieval", async () => {
        const execute = mock(async () => answer);
        const run = mock(async (..._args: Parameters<Agent["run"]>) => answer);
        await new Orchestrator(decision("RESEARCH_ONLY"), { execute }, { run }, safeInput).run("Read https://example.com", "plan");
        expect(execute).not.toHaveBeenCalled();
        expect(run.mock.calls[0]?.[1]).toBe("plan");
    });
    test("hands a long research report to the real coding agent separately from input validation", async () => {
        const report = "Relevant research findings. ".repeat(100);
        let observed: Message[] = [];
        const llm: LLMProvider = { generate: async messages => { observed = [...messages]; return answer; } };
        const stop = mock(async () => {});
        const agent = new Agent(llm, new ToolRegistry(), 2, "REXA", { stop });
        const input = "Implement a feature using the researched documentation";
        const result = await new Orchestrator(decision("RESEARCH_AND_CODE"), { execute: async () => ({ role: "assistant", text: report }) }, agent, new InputGuardrails()).run(input);
        expect(result).toEqual(answer);
        expect(observed[0]?.content).toBe(input);
        expect(observed[1]?.content).toContain(report);
        expect(observed[1]?.content).toContain("untrusted");
        expect(stop).toHaveBeenCalledTimes(1);
    });
    test("bounds research context without altering the original request", () => {
        const message = researchContextMessage("x".repeat(MAX_RESEARCH_CHARACTERS + 100));
        expect(message).toContain('"truncated":true');
        expect(message.length).toBeLessThan(MAX_RESEARCH_CHARACTERS + 1000);
    });
    test("plan mode exposes no tools to the coding model", async () => {
        const registry = new ToolRegistry();
        registry.registerTool({ name: "read_url", description: "test", parameters: z.object({}), execute: async () => ({}) });
        let toolCount = -1;
        const llm: LLMProvider = { generate: async (_messages, tools) => { toolCount = tools?.length ?? 0; return answer; } };
        await new Agent(llm, registry, 2, "REXA", { stop: async () => {} }).run("Read a page later", "plan");
        expect(toolCount).toBe(0);
    });
});

const readResult = (url: string, success = true): UrlReadResult => ({ requestedUrl: url, finalUrl: url, success, status: success ? "ok" : "http_error", provider: "fixture", title: "Document", content: success ? "Verified page content." : "", description: "", truncated: false, partial: false, metadataOnly: false, warnings: [], ...(!success ? { error: "HTTP 404; page was not read." } : {}) });

describe("research evidence", () => {
    test("reads the exact URL before the model can answer, with fresh evidence on each request", async () => {
        const registry = new ToolRegistry();
        const reads: string[] = [];
        registry.registerTool({ name: "read_url", description: "fixture", parameters: z.object({ url: z.string() }), execute: async ({ url }: { url: string }) => { reads.push(url); return readResult(url); } });
        const observed: Message[][] = [];
        const llm: LLMProvider = { generate: async messages => { expect(reads.length).toBeGreaterThan(0); observed.push([...messages]); return answer; } };
        const agent = new ResearchAgent(llm, registry);
        await agent.execute("Read https://example.com/first");
        await agent.execute("Read https://example.com/second");
        expect(reads).toEqual(["https://example.com/first", "https://example.com/second"]);
        expect(JSON.stringify(observed[0])).toContain("Verified page content.");
        expect(observed[0]?.some(message => message.parts?.some(part => part.functionCall))).toBe(false);
        expect(observed[0]?.[1]?.role).toBe("user");
        expect(observed[0]?.[1]?.content).toContain("EXTERNAL RESEARCH DATA");
        expect(JSON.stringify(observed[1])).not.toContain("https://example.com/first");
    });
    test("failed page retrieval returns a limitation without asking the model to invent details", async () => {
        const registry = new ToolRegistry();
        registry.registerTool({ name: "read_url", description: "fixture", parameters: z.object({ url: z.string() }), execute: async ({ url }: { url: string }) => readResult(url, false) });
        const generate = mock(async () => answer);
        const result = await new ResearchAgent({ generate }, registry).execute("Read https://example.com/missing");
        expect(result.text).toContain("HTTP 404");
        expect(result.text).toContain("Could not read");
        expect(generate).not.toHaveBeenCalled();
    });
    test("webpage-directed tool calls cannot execute coding tools", async () => {
        const registry = new ToolRegistry();
        const execute = mock(async () => ({}));
        registry.registerTool({ name: "code_tool", description: "forbidden", parameters: z.object({}), execute });
        let turn = 0;
        const llm: LLMProvider = { generate: async (_messages, tools): Promise<LLMResponse> => {
            expect(tools?.map(tool => tool.name)).not.toContain("code_tool");
            return turn++ === 0 ? { role: "model", text: "", toolcalls: [{ name: "code_tool", params: {} }] } : answer;
        } };
        await new ResearchAgent(llm, registry).execute("Research a topic");
        expect(execute).not.toHaveBeenCalled();
    });
});
