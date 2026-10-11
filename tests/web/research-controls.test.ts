import { afterEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { ResearchAgent } from "../../src/agent/ResearchAgent";
import { ToolRegistry, type Tool } from "../../src/tools/ToolRegistry";
import { ToolDispatcher } from "../../src/tools/ToolDispatcher";
import {
    PermissionService,
    permissions,
    setPermissions,
} from "../../src/tools/PermissionService";
import type { LLMProvider } from "../../src/providers/LLMProvider";
import type { LLMResponse } from "../../src/providers/LLMResponse";
import { createUrlReader } from "../../src/tools/ReadUrlTool";
import { createSearchTool } from "../../src/tools/SearchTool";
import { createLinkedInReader } from "../../src/tools/web/LinkedInReader";
import { createTavilyRequester } from "../../src/tools/web/TavilyRequest";

const originalPermissions = permissions;
afterEach(() => setPermissions(originalPermissions));
const answer: LLMResponse = { role: "assistant", text: "Fixture answer." };

function researchAgent(llm: LLMProvider, tools: Tool[]) {
    const registry = new ToolRegistry();
    for (const tool of tools) {
        registry.registerTool(tool);
    }
    const agent = new ResearchAgent(llm, registry);
    // These tests isolate execution controls without making guardrail API calls.
    Object.assign(agent, {
        inputGuardrails: { validate: async () => ({ isSafe: true }) },
        outputGuardrails: { outputValidation: async () => ({ isSafe: true }) },
    });
    return agent;
}

function webTool(name: string, execute: Tool["execute"]): Tool {
    return {
        name,
        effect: "web",
        description: "fixture",
        parameters: z.object({
            url: z.string().optional(),
            query: z.string().optional(),
        }),
        execute,
    };
}

describe("research execution controls", () => {
    test("denied supplied URLs never execute or reach the model", async () => {
        setPermissions(
            new PermissionService([{ tool: "read_url", action: "deny" }]),
        );
        const execute = mock(async () => ({}));
        const generate = mock(async () => answer);
        const agent = researchAgent({ generate }, [
            webTool("read_url", execute),
        ]);
        await expect(agent.execute("Read https://example.com")).rejects.toThrow(
            "Research URL retrieval blocked",
        );
        expect(execute).not.toHaveBeenCalled();
        expect(generate).not.toHaveBeenCalled();
    });

    test("model-requested web calls honor deny rules and report rejection", async () => {
        setPermissions(
            new PermissionService([{ effect: "web", action: "deny" }]),
        );
        const execute = mock(async () => ({}));
        let turns = 0;
        const agent = researchAgent(
            {
                generate: async (messages) => {
                    if (turns++ === 0) {
                        return {
                            role: "model",
                            text: "",
                            toolcalls: [
                                {
                                    name: "search",
                                    params: { query: "fixture" },
                                },
                                {
                                    name: "read_url",
                                    params: { url: "https://example.com" },
                                },
                            ],
                        };
                    }
                    expect(JSON.stringify(messages)).toContain("rejected");
                    return answer;
                },
            },
            [webTool("search", execute), webTool("read_url", execute)],
        );
        await agent.execute("Research a topic");
        expect(execute).not.toHaveBeenCalled();
        expect(turns).toBe(2);
    });

    test("shared dispatch rejects invalid model arguments before retrieval", async () => {
        const execute = mock(async () => ({}));
        let turns = 0;
        const agent = researchAgent(
            {
                generate: async () =>
                    turns++ === 0
                        ? {
                              role: "model",
                              text: "",
                              toolcalls: [
                                  { name: "read_url", params: { url: 123 } },
                              ],
                          }
                        : answer,
            },
            [webTool("read_url", execute)],
        );
        await agent.execute("Research a topic");
        expect(execute).not.toHaveBeenCalled();
    });

    test("an already cancelled task performs no model or tool calls", async () => {
        const controller = new AbortController();
        controller.abort(new Error("fixture cancellation"));
        const generate = mock(async () => answer);
        const execute = mock(async () => ({}));
        await expect(
            researchAgent({ generate }, [webTool("read_url", execute)]).execute(
                "Read https://example.com",
                { signal: controller.signal },
            ),
        ).rejects.toThrow("fixture cancellation");
        expect(generate).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
    });

    test("active URL retrieval receives cancellation and stops before the model", async () => {
        const controller = new AbortController();
        const generate = mock(async () => answer);
        let observed: AbortSignal | undefined;
        const agent = researchAgent({ generate }, [
            webTool("read_url", async (_args, context) => {
                observed = context?.signal;
                controller.abort(new Error("cancel active retrieval"));
                return new Promise(() => {});
            }),
        ]);
        await expect(
            agent.execute("Read https://example.com", {
                signal: controller.signal,
            }),
        ).rejects.toThrow("cancel active retrieval");
        expect(observed).toBe(controller.signal);
        expect(generate).not.toHaveBeenCalled();
    });

    test("model cancellation prevents proposed tools from executing", async () => {
        const controller = new AbortController();
        const execute = mock(async () => ({}));
        const agent = researchAgent(
            {
                generate: async (
                    _messages,
                    _tools,
                    _prompt,
                    _memory,
                    callbacks,
                ) => {
                    expect(callbacks?.signal).toBe(controller.signal);
                    controller.abort(new Error("cancel model"));
                    return {
                        role: "model",
                        text: "",
                        toolcalls: [
                            { name: "search", params: { query: "fixture" } },
                        ],
                    };
                },
            },
            [webTool("search", execute)],
        );
        await expect(
            agent.execute("Research", { signal: controller.signal }),
        ).rejects.toThrow("cancel model");
        expect(execute).not.toHaveBeenCalled();
    });

    test("cancellation between tool calls stops the rest of the batch", async () => {
        const controller = new AbortController();
        const second = mock(async () => ({}));
        const generate = mock(async (): Promise<LLMResponse> => ({
            role: "model",
            text: "",
            toolcalls: [
                { name: "search", params: { query: "fixture" } },
                { name: "read_url", params: { url: "https://example.com" } },
            ],
        }));
        const agent = researchAgent({ generate }, [
            webTool("search", async () => {
                controller.abort(new Error("cancel batch"));
                return {};
            }),
            webTool("read_url", second),
        ]);
        await expect(
            agent.execute("Research", { signal: controller.signal }),
        ).rejects.toThrow("cancel batch");
        expect(second).not.toHaveBeenCalled();
        expect(generate).toHaveBeenCalledTimes(1);
    });

    test("plan dispatch allows web and repository reads while blocking edits", async () => {
        const registry = new ToolRegistry();
        const read = mock(async () => ({ success: true }));
        const edit = mock(async () => ({}));
        registry.registerTool(webTool("read_url", read));
        registry.registerTool({
            ...webTool("read_file", read),
            effect: "read",
        });
        registry.registerTool({
            ...webTool("code_tool", edit),
            effect: "edit",
        });
        const dispatcher = new ToolDispatcher(
            registry,
            new PermissionService(),
        );
        expect(dispatcher.tools("plan").map((tool) => tool.name)).toEqual([
            "read_url",
            "read_file",
        ]);
        await dispatcher.execute(
            "read_url",
            { url: "https://example.com" },
            "plan",
        );
        await dispatcher.execute("read_file", {}, "plan");
        expect((await dispatcher.execute("code_tool", {}, "plan")).status).toBe(
            "blocked",
        );
        expect(read).toHaveBeenCalledTimes(2);
        expect(edit).not.toHaveBeenCalled();
    });
});

describe("retrieval cancellation propagation", () => {
    test("cancellation aborts an active LinkedIn provider request", async () => {
        const controller = new AbortController();
        let activeSignal: AbortSignal | null | undefined;
        const read = createLinkedInReader({
            getKey: async () => "fixture-key",
            fetch: async (_url, init) => {
                activeSignal = init.signal;
                const response = new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener(
                        "abort",
                        () => reject(init.signal?.reason),
                        { once: true },
                    );
                });
                controller.abort(new Error("cancel LinkedIn HTTP"));
                return response;
            },
        });
        await expect(
            read("https://www.linkedin.com/in/fixture/", controller.signal),
        ).rejects.toThrow("cancel LinkedIn HTTP");
        expect(activeSignal?.aborted).toBe(true);
    });

    test("provider search and extraction use cancellable authenticated fixed-origin requests", async () => {
        const controller = new AbortController();
        const requests: string[] = [];
        const fetchRequest = (async (
            input: string | URL | Request,
            init?: RequestInit,
        ) => {
            requests.push(String(input));
            expect(init?.method).toBe("POST");
            expect(init?.redirect).toBe("error");
            expect(new Headers(init?.headers).get("Authorization")).toBe(
                "Bearer fixture-key",
            );
            expect(JSON.parse(String(init?.body))).toEqual({ fixture: true });
            if (requests.length === 1) {
                controller.abort(new Error("cancel provider"));
                expect(init?.signal?.aborted).toBe(true);
                init?.signal?.throwIfAborted();
            }
            return Response.json({ results: [] });
        }) as typeof fetch;
        const request = createTavilyRequester(fetchRequest);
        await expect(
            request(
                "search",
                "fixture-key",
                { fixture: true },
                controller.signal,
            ),
        ).rejects.toThrow("cancel provider");
        await expect(
            request("extract", "fixture-key", { fixture: true }),
        ).resolves.toEqual({ results: [] });
        expect(requests).toEqual([
            "https://api.tavily.com/search",
            "https://api.tavily.com/extract",
        ]);
    });

    test("cancelled HTTP reading propagates cancellation without fallback or a failure summary", async () => {
        const controller = new AbortController();
        const render = mock(async () => {
            throw new Error("unexpected render");
        });
        const read = createUrlReader({
            validate: async (url) => new URL(url),
            render,
            request: async (_url, options) => {
                expect(options?.signal).toBe(controller.signal);
                controller.abort(new Error("cancel HTTP"));
                return new Promise(() => {});
            },
        });
        await expect(
            read("https://example.com", controller.signal),
        ).rejects.toThrow("cancel HTTP");
        expect(render).not.toHaveBeenCalled();
    });

    test("cancelled browser fallback does not start provider extraction", async () => {
        const controller = new AbortController();
        const extract = mock(async () => null);
        const read = createUrlReader({
            validate: async (url) => new URL(url),
            request: async (url) => ({
                url,
                status: 200,
                headers: { "content-type": "text/html" },
                body: Buffer.from("<html><body>Loading...</body></html>"),
            }),
            render: async (_url, signal) => {
                expect(signal).toBe(controller.signal);
                controller.abort(new Error("cancel browser"));
                return new Promise(() => {});
            },
            extract,
        });
        await expect(
            read("https://example.com", controller.signal),
        ).rejects.toThrow("cancel browser");
        expect(extract).not.toHaveBeenCalled();
    });

    test("cancelled provider search does not start DuckDuckGo fallback", async () => {
        const controller = new AbortController();
        const request = mock(async () => {
            throw new Error("unexpected fallback");
        });
        const tool = createSearchTool({
            request,
            providerSearch: async (_query, signal) => {
                expect(signal).toBe(controller.signal);
                controller.abort(new Error("cancel search"));
                return new Promise(() => {});
            },
        });
        await expect(
            tool.execute({ query: "fixture" }, { signal: controller.signal }),
        ).rejects.toThrow("cancel search");
        expect(request).not.toHaveBeenCalled();
    });

    test("LinkedIn polling stops after cancellation without downloading a snapshot", async () => {
        const controller = new AbortController();
        let calls = 0;
        const read = createLinkedInReader({
            getKey: async () => "fixture-key",
            fetch: async (_url, init) => {
                expect(init.signal).toBeDefined();
                calls++;
                return Response.json(
                    calls === 1
                        ? { snapshot_id: "s_fixture" }
                        : { status: "running" },
                );
            },
            sleep: async () => {
                controller.abort(new Error("cancel polling"));
            },
        });
        await expect(
            read("https://www.linkedin.com/in/fixture/", controller.signal),
        ).rejects.toThrow("cancel polling");
        expect(calls).toBe(2);
    });
});
