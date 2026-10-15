import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { AgentMode } from "../agent/AgentMode";
import type { RunCallbacks, RunEvidenceEvent } from "../agent/RunCallbacks";
import { emitEvidence } from "../agent/RunCallbacks";
import type { LLMProvider } from "../providers/LLMProvider";
import type { LLMResponse } from "../providers/LLMResponse";
import { DEFAULT_GEMINI_MODEL } from "../providers/gemini/GeminiProtocol";
import { workspaceSnapshot } from "../verification/VerificationRunner";
import { Workspace } from "../tools/Workspace";
import { permissions } from "../tools/PermissionService";
import { sanitizeStored } from "../utils/SanitizeStored";
import {
    fingerprint,
    summarizeVerification,
    taskIdSchema,
    type EvaluationRecord,
} from "./EvaluationRecord";
import { EvaluationStore } from "./EvaluationStore";

interface TaskRunner {
    run(
        content: string,
        mode?: AgentMode,
        callbacks?: RunCallbacks,
    ): Promise<LLMResponse>;
}
type RunMetadata = Pick<EvaluationRecord, "context" | "rexa">;

async function observeWorkspace(directory: string): Promise<string | null> {
    try {
        return await workspaceSnapshot(new Workspace(directory));
    } catch {
        return null;
    }
}

/** Snapshot hashes are fingerprints only; no project contents are copied into history. */
export async function collectMetadata(
    workspace: string,
    prompt: string,
    mode: AgentMode,
): Promise<RunMetadata> {
    const sourceRoot = path.resolve(import.meta.dir, "../..");
    let packageVersion = "unknown";
    let revision: string | null = null;
    try {
        packageVersion = JSON.parse(
            await readFile(path.join(sourceRoot, "package.json"), "utf8"),
        ).version;
    } catch {
        /* Unknown version is recorded explicitly. */
    }
    try {
        const process = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
            cwd: sourceRoot,
        });
        if (process.exitCode === 0) {
            revision = process.stdout.toString().trim();
        }
    } catch {
        /* A packaged install need not have Git metadata. */
    }
    const policy = permissions.describe();
    const [workspaceState, sourceHash] = await Promise.all([
        observeWorkspace(workspace),
        observeWorkspace(sourceRoot),
    ]);
    return {
        rexa: { packageVersion, revision, sourceHash },
        context: {
            promptHash: fingerprint(prompt),
            mode,
            workspaceState,
            permissionsHash:
                policy.sessionGrants === 0 ? fingerprint(policy.rules) : null,
            provider: "gemini",
            model: DEFAULT_GEMINI_MODEL,
            reasoning: "default",
            platform: `${process.platform}-${process.arch}`,
            runtime: `bun-${Bun.version}`,
        },
    };
}

/** Observes normal tasks. It never generates tests, executes commands, or requests repairs. */
export class EvaluationTracker {
    private active?: EvaluationRecord;
    private selectedTask?: string;
    private lastTask?: string;

    constructor(
        readonly store: EvaluationStore,
        private metadata: (
            prompt: string,
            mode: AgentMode,
        ) => Promise<RunMetadata> = (prompt, mode) =>
            collectMetadata(
                path.resolve(store.directory, "../.."),
                prompt,
                mode,
            ),
        private warn: (message: string) => void = (message) =>
            console.warn(message),
    ) {}

    selectTask(taskId?: string): void {
        this.selectedTask = taskId ? taskIdSchema.parse(taskId) : undefined;
    }

    currentTask(): string | undefined {
        return this.selectedTask ?? this.lastTask;
    }

    /** Counts only this shared provider, not the supervisor/guardrails' direct Google calls. */
    observeProvider(provider: LLMProvider): LLMProvider {
        return {
            generate: async (...args) => {
                const record = this.active;
                if (record) {
                    record.activity.modelRequests++;
                }
                try {
                    const response = await provider.generate(...args);
                    if (record && response.error) {
                        record.activity.modelErrors++;
                    }
                    return response;
                } catch (error) {
                    if (record) {
                        record.activity.modelErrors++;
                    }
                    throw error;
                }
            },
        };
    }

    private observe(record: EvaluationRecord, event: RunEvidenceEvent): void {
        if (event.kind === "route") {
            record.route = event.route;
            return;
        }
        if (event.kind === "session") {
            record.sessionId = event.id;
            return;
        }
        if (event.kind === "guardrail") {
            if (!event.isSafe) {
                record.activity.guardrailBlocks++;
            }
            return;
        }
        if (event.kind === "verification") {
            record.verification = summarizeVerification(event.evidence);
            return;
        }
        record.activity.toolResults++;
        const result = event.result;
        if (!result || typeof result !== "object") {
            if (
                typeof result === "string" &&
                result.startsWith("Error executing tool:")
            ) {
                record.activity.toolFailures++;
            }
            return;
        }
        const data = result as Record<string, unknown>;
        if (
            data.success === false ||
            data.error ||
            ["failed", "rejected", "blocked", "timeout", "cancelled"].includes(
                String(data.status),
            )
        ) {
            record.activity.toolFailures++;
        }
        if (["rejected", "blocked"].includes(String(data.status))) {
            record.activity.deniedTools++;
        }
        if (event.name === "read_url") {
            record.activity.pageReads++;
            if (
                data.success === true &&
                typeof data.content === "string" &&
                data.content.trim()
            ) {
                record.activity.successfulPageReads++;
            }
            const url = data.finalUrl ?? data.requestedUrl;
            if (
                typeof url === "string" &&
                record.activity.sourceUrls.length < 20 &&
                !record.activity.sourceUrls.includes(url)
            ) {
                record.activity.sourceUrls.push(url.slice(0, 500));
            }
        }
    }

    async run(
        runner: TaskRunner,
        prompt: string,
        mode: AgentMode = "act",
        callbacks?: RunCallbacks,
    ): Promise<LLMResponse> {
        if (this.active) {
            throw new Error(
                "Finish the current task before starting another tracked task.",
            );
        }
        let metadata: RunMetadata;
        try {
            metadata = await this.metadata(prompt, mode);
        } catch {
            this.warn(
                "Evaluation context could not be captured; this task will run without a history record.",
            );
            return runner.run(prompt, mode, callbacks);
        }
        const record: EvaluationRecord = {
            version: 1,
            id: randomUUID(),
            taskId:
                this.selectedTask ?? `task-${fingerprint(prompt).slice(0, 16)}`,
            createdAt: new Date().toISOString(),
            promptPreview: prompt.slice(0, 300),
            ...metadata,
            route: null,
            outcome: "completed",
            durationMs: 0,
            error: null,
            sessionId: null,
            activity: {
                modelRequests: 0,
                modelErrors: 0,
                toolResults: 0,
                toolFailures: 0,
                deniedTools: 0,
                guardrailBlocks: 0,
                pageReads: 0,
                successfulPageReads: 0,
                sourceUrls: [],
            },
            verification: null,
            comparison: null,
            limitations: [
                "Verification counts command checks, not individual assertions; test-file references are not a quality score.",
                "Coverage and test-change reasons come from debugging submissions, not independent proof of correctness.",
                "Research factual accuracy and planning usefulness have not been reviewed; retrieved pages are evidence of access only.",
                "Model counts cover the shared provider only. Supervisor/guardrail calls, retries, and token usage are not available.",
                "No independent tests are generated or run by evaluation. No overall score or causal improvement claim is made.",
                "Session ID is a reference to external session storage; source evidence may later be unavailable.",
            ],
        };
        this.active = record;
        this.lastTask = record.taskId;
        const startedAt = Date.now();
        try {
            const response = await runner.run(prompt, mode, {
                ...callbacks,
                onEvidence: (event) => {
                    this.observe(record, event);
                    emitEvidence(callbacks, event);
                },
            });
            if (record.verification?.stage === "blocked") {
                record.outcome = "verification_blocked";
            }
            if (record.activity.guardrailBlocks > 0) {
                record.outcome = "guardrail_blocked";
            }
            if (response.error) {
                record.outcome = "error";
                record.error = response.error.message.slice(0, 1000);
            }
            return response;
        } catch (error) {
            record.outcome = callbacks?.signal?.aborted ? "cancelled" : "error";
            if (
                !callbacks?.signal?.aborted &&
                record.activity.guardrailBlocks > 0
            ) {
                record.outcome = "guardrail_blocked";
            }
            record.error = String(error).slice(0, 1000);
            throw error;
        } finally {
            this.active = undefined;
            record.durationMs = Date.now() - startedAt;
            try {
                await this.store.save(sanitizeStored(record));
            } catch {
                this.warn(
                    "Evaluation history could not be saved or fully pruned. The task result is unchanged; inspect .rexa/past-evaluations/ and its retention settings.",
                );
            }
        }
    }
}
