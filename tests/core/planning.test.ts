import { test, expect, mock } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../../src/tools/ToolRegistry";
import { ToolDispatcher } from "../../src/tools/ToolDispatcher";
import { Agent } from "../../src/agent/Agent";
import type { LLMProvider } from "../../src/providers/LLMProvider";

test("planning reads evidence, blocks invented mutation calls, and keeps context into act mode", async () => {
    const registry = new ToolRegistry();
    const edit = mock(async () => ({}));
    registry.registerTool({
        name: "read_file",
        effect: "read",
        description: "fixture",
        parameters: z.object({}),
        execute: async () => ({ content: "1: actual code" }),
    });
    for (const [name, effect] of [
        ["code_tool", "edit"],
        ["execute_command", "command"],
        ["save_memory", "external"],
    ] as const)
        registry.registerTool({
            name,
            effect,
            description: "fixture",
            parameters: z.object({}),
            execute: edit,
        });
    let turn = 0;
    const llm: LLMProvider = {
        generate: async (messages, tools) => {
            if (messages.at(-1)?.content?.includes("Review this plan"))
                return { role: "assistant", text: '{"isGood":true}' };
            if (turn++ === 0) {
                expect(tools?.map((t) => t.name)).toEqual(["read_file"]);
                return {
                    role: "model",
                    text: "",
                    toolcalls: [
                        { name: "read_file", params: {} },
                        { name: "code_tool", params: {} },
                    ],
                };
            }
            expect(JSON.stringify(messages)).toContain("actual code");
            expect(JSON.stringify(messages)).toContain("unavailable in plan");
            return { role: "assistant", text: "Plan grounded in actual code." };
        },
    };
    const agent = new Agent(llm, registry, 5, "REXA", { stop: async () => {} });
    (agent as any).inputGuardrails = {
        validate: async () => ({ isSafe: true }),
    };
    (agent as any).outputGuardrails = {
        outputValidation: async () => ({ isSafe: true }),
    };
    await agent.run("Inspect source and plan", "plan");
    await agent.run("Now implement", "act");
    expect(edit).not.toHaveBeenCalled();
    const dispatcher = new ToolDispatcher(registry);
    for (const name of ["code_tool", "execute_command", "save_memory"])
        expect((await dispatcher.execute(name, {}, "plan")).status).toBe(
            "blocked",
        );
});

test("unvalidated model tokens are never emitted to the user", async () => {
    const llm: LLMProvider = {
        generate: async (_m, _t, _s, _i, callbacks) => {
            callbacks?.onToken?.("UNVALIDATED");
            return { role: "assistant", text: "unsafe response" };
        },
    };
    const agent = new Agent(llm, new ToolRegistry(), 2, "REXA", {
        stop: async () => {},
    });
    (agent as any).inputGuardrails = {
        validate: async () => ({ isSafe: true }),
    };
    (agent as any).outputGuardrails = {
        outputValidation: async () => ({ isSafe: false, reason: "Blocked" }),
    };
    const onToken = mock(() => {});
    expect((await agent.run("Explain code", "act", { onToken })).text).toBe(
        "Blocked",
    );
    expect(onToken).not.toHaveBeenCalled();
});

test("asynchronous response validation finishes before sandbox cleanup", async () => {
    const events: string[] = [];
    const llm: LLMProvider = {
        generate: async () => ({ role: "assistant", text: "fixture response" }),
    };
    const agent = new Agent(llm, new ToolRegistry(), 2, "REXA", {
        stop: async () => {
            events.push("cleanup");
        },
    });
    // Stub the guardrails so this fixture never contacts a live model.
    Object.assign(agent, {
        inputGuardrails: { validate: async () => ({ isSafe: true }) },
        outputGuardrails: {
            outputValidation: async () => {
                events.push("validating");
                await Bun.sleep(5);
                events.push("validation failed");
                throw new Error("fixture validation failure");
            },
        },
    });
    await expect(agent.run("Explain code")).rejects.toThrow(
        "fixture validation failure",
    );
    expect(events).toEqual(["validating", "validation failed", "cleanup"]);
});
