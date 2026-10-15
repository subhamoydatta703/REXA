import { afterEach, beforeEach, expect, test } from "bun:test";
import {
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EvaluationStore } from "../../src/evaluation/EvaluationStore";
import { EvaluationTracker } from "../../src/evaluation/EvaluationTracker";
import { EvaluationCommands } from "../../src/evaluation/EvaluationCommands";
import {
    compareRecords,
    summarizeVerification,
    type EvaluationRecord,
} from "../../src/evaluation/EvaluationRecord";
import { emitEvidence } from "../../src/agent/RunCallbacks";
import type {
    VerificationEvidence,
    CheckResult,
} from "../../src/verification/VerificationResults";
import { Agent } from "../../src/agent/Agent";
import { ToolRegistry } from "../../src/tools/ToolRegistry";
import { Orchestrator } from "../../src/orchestration/Orchestrator";
import { ResearchAgent } from "../../src/agent/ResearchAgent";
import { z } from "zod";

let directory: string;
let store: EvaluationStore;
beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "rexa-history-test-"));
    store = new EvaluationStore(directory);
});
afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

function record(sequence = 0, taskId = "authentication"): EvaluationRecord {
    return {
        version: 1,
        id: randomUUID(),
        taskId,
        createdAt: new Date(
            Date.UTC(2026, 9, 15, 0, 0, sequence),
        ).toISOString(),
        promptPreview: "Fix authentication",
        rexa: {
            packageVersion: "2.1.0",
            revision: "revision",
            sourceHash: "source",
        },
        context: {
            promptHash: "same-requirements",
            mode: "act",
            workspaceState: "same-starting-project",
            permissionsHash: "same-policy",
            provider: "gemini",
            model: "fixture",
            reasoning: "default",
            platform: "fixture-os",
            runtime: "fixture-runtime",
        },
        route: "CODE_ONLY",
        outcome: "completed",
        durationMs: 100,
        error: null,
        sessionId: "session-reference",
        activity: {
            modelRequests: 2,
            modelErrors: 0,
            toolResults: 2,
            toolFailures: 0,
            deniedTools: 0,
            guardrailBlocks: 0,
            pageReads: 0,
            successfulPageReads: 0,
            sourceUrls: [],
        },
        verification: null,
        limitations: ["fixture evidence"],
        comparison: null,
    };
}

function check(status: CheckResult["status"]): CheckResult {
    return {
        check: {
            name: "auth",
            command: "bun",
            args: ["test"],
            directory: ".",
            timeoutMs: 1000,
        },
        status,
        exitCode: status === "passed" ? 0 : 1,
        stdout: "",
        stderr: "Expected 401; received 200",
        durationMs: 10,
        locations: ["middleware.test.ts:12"],
    };
}

function evidence(): VerificationEvidence {
    return {
        source: "recorded verification",
        notices: [],
        baseline: [check("passed")],
        runs: [[check("failed")], [check("passed")]],
        changedFiles: ["middleware.ts"],
        repairRounds: 1,
        pendingProcesses: [],
        dirty: false,
        stage: "completed",
        coverage: [
            {
                behavior: "missing sessions are rejected",
                testFiles: ["middleware.test.ts"],
                checkNames: ["auth"],
            },
        ],
        testChangesReasons: [
            "Corrected test setup without changing the expected status.",
        ],
    };
}

test("compact verification summaries distinguish command checks, coverage and actual failures", () => {
    const source = evidence();
    const summary = summarizeVerification(source);
    expect(summary.first.failed).toBe(1);
    expect(summary.latest.passed).toBe(1);
    expect(summary.testFiles).toEqual(["middleware.test.ts"]);
    expect(summary.repairRounds).toBe(1);
    expect(summary.failures).toEqual([]);
    expect(summary.firstFailures[0]?.message).toContain("Expected 401");
    source.runs.push([check("unavailable")]);
    const unavailable = summarizeVerification(source);
    expect(unavailable.latest.unavailable).toBe(1);
    expect(unavailable.latest.passed).toBe(0);
    expect(unavailable.failures[0]?.locations).toEqual([
        "middleware.test.ts:12",
    ]);
});

test("five recent runs and a separately selected baseline survive restart", async () => {
    const baseline = await store.save(record());
    await store.setBaseline("authentication", baseline.id);
    for (let index = 1; index <= 8; index++) {
        await store.save(record(index));
    }
    const history = await new EvaluationStore(directory).history(
        "authentication",
    );
    expect(history).toHaveLength(6);
    expect(
        await readFile(path.join(store.directory, ".gitignore"), "utf8"),
    ).toBe("*\n");
    expect(Bun.spawnSync(["git", "init", "--quiet", directory]).exitCode).toBe(
        0,
    );
    expect(
        Bun.spawnSync(
            [
                "git",
                "check-ignore",
                ".rexa/past-evaluations/authentication/record.json",
            ],
            { cwd: directory },
        ).exitCode,
    ).toBe(0);
    expect(history.find((entry) => entry.baseline)?.record.id).toBe(
        baseline.id,
    );
    expect(history[0]?.record.comparison?.previousRun).toBe(baseline.id);
    await store.setBaseline("authentication", null);
    expect(await store.history("authentication")).toHaveLength(5);
});

test("retention is configurable through ten runs and rejects invalid settings", async () => {
    await store.configure({ recentRuns: 10, maxBytes: 100_000 });
    for (let index = 0; index < 12; index++) {
        await store.save(record(index));
    }
    expect(await store.history("authentication")).toHaveLength(10);
    await expect(
        store.configure({ recentRuns: 11, maxBytes: 100_000 }),
    ).rejects.toThrow();
    expect((await store.settings()).recentRuns).toBe(10);
});

test("global byte retention removes oldest unprotected records across tasks", async () => {
    const first = await store.save(record(0, "first-task"));
    const size = Buffer.byteLength(
        await readFile(
            path.join(store.directory, "first-task", first.id, "record.json"),
        ),
    );
    await store.configure({ recentRuns: 5, maxBytes: size * 2 + 100 });
    await store.save(record(1, "second-task"));
    await store.save(record(2, "third-task"));
    expect(await store.history("first-task")).toEqual([]);
    expect(await store.history("second-task")).toHaveLength(1);
    expect(await store.history("third-task")).toHaveLength(1);
});

test("protected baselines are never deleted to fit a new record or smaller budget", async () => {
    const baseline = await store.save(record());
    await store.setBaseline("authentication", baseline.id);
    const bytes = Buffer.byteLength(
        await readFile(
            path.join(
                store.directory,
                "authentication",
                baseline.id,
                "record.json",
            ),
        ),
    );
    await store.configure({ recentRuns: 5, maxBytes: bytes + 100 });
    await expect(store.save(record(1))).rejects.toThrow("protected baselines");
    expect(await store.history("authentication")).toHaveLength(1);
    await expect(
        store.configure({ recentRuns: 5, maxBytes: 1024 }),
    ).rejects.toThrow("protected baselines");
    expect((await store.settings()).maxBytes).toBe(bytes + 100);
});

test("comparisons reject changed requirements, initial state, model, mode, policy and command plans", () => {
    const previous = record();
    const current = record(1);
    current.rexa.revision = "new-rexa-revision";
    current.durationMs = 70;
    expect(compareRecords(current, previous)).toMatchObject({
        compatible: true,
        durationDeltaMs: -30,
    });
    for (const context of [
        { promptHash: "different" },
        { workspaceState: "different" },
        { workspaceState: null },
        { model: "different" },
        { mode: "plan" as const },
        { permissionsHash: null },
    ]) {
        expect(
            compareRecords(
                { ...current, context: { ...current.context, ...context } },
                previous,
            ).compatible,
        ).toBe(false);
    }
    previous.verification = summarizeVerification(evidence());
    expect(compareRecords(current, previous).compatible).toBe(false);
    current.verification = summarizeVerification(evidence());
    expect(compareRecords(current, previous).compatible).toBe(true);
});

test("store sanitizes secrets, refuses overwrites and never deletes unrelated files", async () => {
    const secret = "evaluation-test-secret-never-send";
    const previous = process.env.EVALUATION_TEST_API_KEY;
    process.env.EVALUATION_TEST_API_KEY = secret;
    try {
        const source = record();
        source.promptPreview = secret;
        const saved = await store.save(source);
        const text = await readFile(
            path.join(store.directory, source.taskId, saved.id, "record.json"),
            "utf8",
        );
        expect(text).not.toContain(secret);
        await expect(store.save(source)).rejects.toThrow("overwrite");
        await writeFile(
            path.join(store.directory, source.taskId, saved.id, "notes.txt"),
            "unrelated",
        );
        for (let index = 1; index < 5; index++) {
            await store.save(record(index));
        }
        await expect(store.save(record(5))).rejects.toThrow(
            "automatic removal refused",
        );
        expect(
            await readFile(
                path.join(
                    store.directory,
                    source.taskId,
                    saved.id,
                    "notes.txt",
                ),
                "utf8",
            ),
        ).toBe("unrelated");
    } finally {
        if (previous === undefined) {
            delete process.env.EVALUATION_TEST_API_KEY;
        } else {
            process.env.EVALUATION_TEST_API_KEY = previous;
        }
    }
});

test("history paths reject traversal and symbolic links", async () => {
    await expect(store.history("../outside")).rejects.toThrow();
    const target = path.join(directory, "other-storage");
    await mkdir(target);
    await mkdir(path.join(directory, ".rexa"));
    await symlink(target, store.directory, "junction");
    await expect(store.save(record())).rejects.toThrow("symbolic links");
    expect(await readdir(target)).toEqual([]);
});

test("tracker observes real orchestration and coding without creating another test pipeline", async () => {
    const sample = record();
    const tracker = new EvaluationTracker(store, async () => ({
        context: sample.context,
        rexa: sample.rexa,
    }));
    tracker.selectTask("authentication");
    const provider = tracker.observeProvider({
        generate: async () => ({ role: "assistant", text: "Plan prepared." }),
    });
    const agent = new Agent(provider, new ToolRegistry(), 2, "fixture", {
        stop: async () => {},
    });
    Object.assign(agent, {
        inputGuardrails: { validate: async () => ({ isSafe: true }) },
        outputGuardrails: { outputValidation: async () => ({ isSafe: true }) },
    });
    const orchestrator = new Orchestrator(
        { decide: async () => ({ route: "CODE_ONLY", reason: "fixture" }) },
        {
            execute: async () => {
                throw new Error("unexpected research");
            },
        },
        agent,
        { validate: async () => ({ isSafe: true }) },
    );
    const response = await tracker.run(
        orchestrator,
        "Plan authentication",
        "plan",
    );
    expect(response.text).toBe("Plan prepared.");
    const saved = (await store.history("authentication"))[0]!.record;
    expect(saved.route).toBe("CODE_ONLY");
    expect(saved.activity.modelRequests).toBe(1);
    expect(saved.verification).toBeNull();
});

test("tracker consumes existing verification evidence and forwards callbacks without rerunning checks", async () => {
    const sample = record();
    const tracker = new EvaluationTracker(store, async () => ({
        context: sample.context,
        rexa: sample.rexa,
    }));
    tracker.selectTask("authentication");
    let observations = 0;
    const response = await tracker.run(
        {
            run: async (_prompt, _mode, callbacks) => {
                emitEvidence(callbacks, {
                    kind: "verification",
                    evidence: evidence(),
                });
                emitEvidence(callbacks, {
                    kind: "tool",
                    source: "debugging",
                    name: "code_tool",
                    result: { status: "rejected", success: false },
                });
                emitEvidence(callbacks, {
                    kind: "session",
                    id: "existing-session",
                });
                return { role: "assistant", text: "Original response" };
            },
        },
        "Fix authentication",
        "act",
        {
            onEvidence: () => {
                observations++;
            },
        },
    );
    expect(response.text).toBe("Original response");
    const saved = (await store.history("authentication"))[0]!.record;
    expect(saved.verification?.repairRounds).toBe(1);
    expect(saved.verification?.latest.passed).toBe(1);
    expect(saved.activity.deniedTools).toBe(1);
    expect(saved.sessionId).toBe("existing-session");
    expect(observations).toBe(3);
});

test("real research retrieval evidence is captured without claiming factual correctness", async () => {
    const sample = record();
    const tracker = new EvaluationTracker(store, async () => ({
        context: sample.context,
        rexa: sample.rexa,
    }));
    tracker.selectTask("research");
    const registry = new ToolRegistry();
    registry.registerTool({
        name: "read_url",
        effect: "web",
        description: "fixture",
        parameters: z.object({ url: z.string() }),
        execute: async ({ url }) => ({
            success: true,
            content: "Fixture page",
            requestedUrl: url,
            finalUrl: url,
        }),
    });
    const researcher = new ResearchAgent(
        { generate: async () => ({ role: "assistant", text: "Page summary" }) },
        registry,
    );
    Object.assign(researcher, {
        inputGuardrails: { validate: async () => ({ isSafe: true }) },
        outputGuardrails: { outputValidation: async () => ({ isSafe: true }) },
    });
    await tracker.run(
        {
            run: (prompt, _mode, callbacks) =>
                researcher.execute(prompt, callbacks),
        },
        "Read https://example.com",
        "act",
    );
    const saved = (await store.history("research"))[0]!.record;
    expect(saved.activity.pageReads).toBe(1);
    expect(saved.activity.successfulPageReads).toBe(1);
    expect(saved.activity.sourceUrls).toEqual(["https://example.com/"]);
    expect(
        saved.limitations.some((limitation) =>
            limitation.includes("factual accuracy"),
        ),
    ).toBe(true);
});

test("recording failures never turn task success into failure or hide the original task error", async () => {
    await mkdir(store.directory, { recursive: true });
    await writeFile(
        path.join(store.directory, "settings.json"),
        "invalid JSON",
    );
    const warnings: string[] = [];
    const sample = record();
    const tracker = new EvaluationTracker(
        store,
        async () => ({ context: sample.context, rexa: sample.rexa }),
        (warning) => warnings.push(warning),
    );
    expect(
        (
            await tracker.run(
                {
                    run: async () => ({
                        role: "assistant",
                        text: "Successful task",
                    }),
                },
                "task",
            )
        ).text,
    ).toBe("Successful task");
    const original = new Error("Original task failure");
    await expect(
        tracker.run(
            {
                run: async () => {
                    throw original;
                },
            },
            "task",
        ),
    ).rejects.toBe(original);
    expect(warnings).toHaveLength(2);
});

test("guardrail blocks and cancellation retain their outcomes even when recording observers throw", async () => {
    const sample = record();
    const tracker = new EvaluationTracker(store, async () => ({
        context: sample.context,
        rexa: sample.rexa,
    }));
    tracker.selectTask("blocked");
    await expect(
        tracker.run(
            {
                run: async (_prompt, _mode, callbacks) => {
                    emitEvidence(callbacks, {
                        kind: "guardrail",
                        component: "input",
                        isSafe: false,
                    });
                    throw new Error("Input blocked");
                },
            },
            "task",
            "act",
            {
                onEvidence: () => {
                    throw new Error("observer failure");
                },
            },
        ),
    ).rejects.toThrow("Input blocked");
    expect((await store.history("blocked"))[0]?.record.outcome).toBe(
        "guardrail_blocked",
    );
    const controller = new AbortController();
    controller.abort();
    tracker.selectTask("cancelled");
    await expect(
        tracker.run(
            {
                run: async () => {
                    throw new Error("cancelled");
                },
            },
            "task",
            "act",
            { signal: controller.signal },
        ),
    ).rejects.toThrow("cancelled");
    expect((await store.history("cancelled"))[0]?.record.outcome).toBe(
        "cancelled",
    );
});

test("local controls select tasks, list comparisons, protect baselines and configure retention", async () => {
    const tracker = new EvaluationTracker(store);
    const commands = new EvaluationCommands(tracker);
    expect(
        await commands.handle("/evaluation-task", "authentication"),
    ).toContain("authentication");
    const first = await store.save(record());
    expect(await commands.handle("/evaluation-baseline", first.id)).toContain(
        "protected",
    );
    expect(await commands.handle("/evaluations")).toContain(first.id);
    await commands.handle("/evaluation-retention", "10:1");
    expect((await store.settings()).recentRuns).toBe(10);
    expect(await commands.handle("/evaluation-baseline", "clear")).toContain(
        "cleared",
    );
    expect(await commands.handle("/evaluation-task", "auto")).toContain(
        "exact prompt",
    );
    expect(await commands.handle("/unrelated-command")).toBeNull();
});
