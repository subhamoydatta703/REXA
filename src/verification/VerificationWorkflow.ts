import { contentHash, type Workspace } from "../tools/Workspace";
import type { Tool, ToolExecutionContext } from "../tools/ToolRegistry";
import type { ToolDispatcher } from "../tools/ToolDispatcher";
import type { Message } from "../agent/Message";
import { VerificationRunner, workspaceSnapshot } from "./VerificationRunner";
import {
    debuggingSubmissionSchema,
    recordedDebuggingMessage,
    verificationReport,
    type VerificationCheck,
    type VerificationEvidence,
    type DebuggingService,
    type DebuggingSubmission,
    type CheckResult,
} from "./VerificationResults";

export function mayModifyWorkspace(tool: Tool): boolean {
    return tool.effect !== "read" && tool.effect !== "web";
}

/** Owns decisions for one task. It never writes tests or diagnoses source code itself. */
export class VerificationWorkflow {
    private runner: VerificationRunner;
    private evidence: VerificationEvidence;
    private baselineChecks: VerificationCheck[] = [];
    private baselineStarted = false;
    private unsafe = false;
    private finished = false;
    private verifiedSnapshot?: string;
    private selectedChecks: VerificationCheck[] = [];
    private uncertainChanges = false;

    private constructor(
        private workspace: Workspace,
        dispatcher: ToolDispatcher,
        private context: ToolExecutionContext,
        refresh: boolean,
        private onProgress: () => Promise<void>,
    ) {
        this.runner = new VerificationRunner(
            workspace,
            dispatcher,
            context,
            onProgress,
        );
        this.evidence = {
            source: "task-specific debugging workflow",
            notices: [],
            baseline: [],
            runs: [],
            changedFiles: [],
            repairRounds: 0,
            pendingProcesses: [],
            dirty: refresh,
            stage: "inspecting",
            coverage: [],
            findings: [],
            testChangesReasons: [],
            debuggingMessages: [],
        };
    }

    static async create(
        workspace: Workspace,
        dispatcher: ToolDispatcher,
        context: ToolExecutionContext,
        refresh = false,
        onProgress: () => Promise<void> = async () => {},
    ) {
        const workflow = new VerificationWorkflow(
            workspace,
            dispatcher,
            context,
            refresh,
            onProgress,
        );
        const discovered = await workflow.runner.discoverChecks();
        workflow.baselineChecks = discovered.checks;
        workflow.evidence.notices.push(...discovered.notices);
        context.signal?.throwIfAborted();
        return workflow;
    }

    async beforeMutation(): Promise<void> {
        if (this.baselineStarted) {
            return;
        }
        this.baselineStarted = true;
        await this.runner.run(this.baselineChecks, this.evidence.baseline);
        this.evidence.stage = "implementing";
    }

    observe(tool: Tool, value: unknown): void {
        const result =
            value && typeof value === "object"
                ? (value as Record<string, unknown>)
                : {};
        if (["rejected", "blocked"].includes(String(result.status))) {
            if (mayModifyWorkspace(tool)) {
                this.unsafe = true;
            }
            return;
        }
        if (
            ["RECOVERY_CONFLICT", "STALE_RETRY_LIMIT"].includes(
                String(result.code),
            )
        ) {
            this.unsafe = true;
        }
        if (typeof result.id === "string") {
            this.evidence.pendingProcesses =
                this.evidence.pendingProcesses.filter((id) => id !== result.id);
            if (result.status === "running") {
                this.evidence.pendingProcesses.push(result.id);
            }
        }
        const changedFiles = Array.isArray(result.changedFiles)
            ? result.changedFiles.filter(
                  (file): file is string => typeof file === "string",
              )
            : [];
        this.evidence.changedFiles = [
            ...new Set([...this.evidence.changedFiles, ...changedFiles]),
        ];
        if (mayModifyWorkspace(tool) || changedFiles.length) {
            this.uncertainChanges ||=
                tool.effect !== "edit" || changedFiles.length === 0;
            this.evidence.dirty = true;
            this.verifiedSnapshot = undefined;
        }
    }

    async recordMessage(message: Message): Promise<void> {
        this.evidence.debuggingMessages!.push(
            recordedDebuggingMessage(message),
        );
        await this.onProgress();
    }

    async finish(
        debuggerAgent: DebuggingService,
        userRequest: string,
        implementationSummary: string,
    ): Promise<void> {
        if (this.finished) {
            return;
        }
        this.finished = true;
        this.context.signal?.throwIfAborted();
        const codingRequest =
            /\b(fix|implement|build|create|refactor|debug|test|repair)\b/i.test(
                userRequest,
            );
        if (!this.evidence.dirty && !this.unsafe && !codingRequest) {
            this.evidence.stage = "completed";
            this.evidence.notices.push(
                "No potentially modifying operation was observed; feature testing was not started.",
            );
            return;
        }
        if (
            this.unsafe ||
            this.evidence.pendingProcesses.length ||
            this.runner.hasRunningProcesses()
        ) {
            await this.block(
                "Testing stopped: a permission/recovery decision or unfinished process requires attention.",
            );
            return;
        }
        // Documentation-only edits do not need artificial executable tests.
        if (
            !this.uncertainChanges &&
            this.evidence.changedFiles.length &&
            this.evidence.changedFiles.every((file) =>
                /\.(md|mdx|rst)$/i.test(file),
            )
        ) {
            this.evidence.stage = "completed";
            this.evidence.notices.push(
                "Only documentation/text paths were reported changed; executable test coverage was not requested.",
            );
            await this.onProgress();
            return;
        }
        try {
            await this.setStage("preparing_tests");
            const preparation = debuggingSubmissionSchema.parse(
                await debuggerAgent.execute({
                    phase: "prepare",
                    userRequest,
                    implementationSummary,
                    evidence: this.handoffEvidence(),
                }),
            );
            if (preparation.blockedReason) {
                await this.block(preparation.blockedReason);
                return;
            }
            await this.acceptPreparation(preparation);
            while (true) {
                await this.setStage("running_tests");
                const results: CheckResult[] = [];
                this.evidence.runs.push(results);
                this.verifiedSnapshot = await this.runner.run(
                    this.selectedChecks,
                    results,
                    this.evidence.pendingProcesses.length > 0,
                );
                if (
                    !this.verifiedSnapshot ||
                    results.length !== this.selectedChecks.length ||
                    results.some(
                        (result) =>
                            !["passed", "failed"].includes(result.status),
                    )
                ) {
                    await this.block(
                        "Checks did not complete conclusively against stable code; automatic repair stopped.",
                    );
                    return;
                }
                this.evidence.dirty = false;
                if (results.every((result) => result.status === "passed")) {
                    await this.setStage("completed");
                    return;
                }
                if (this.unsafe || this.evidence.repairRounds >= 2) {
                    await this.block(
                        "Failures remain and the automatic repair limit or editing safety limit was reached.",
                    );
                    return;
                }
                // A new feature test may fail without a baseline. Old unchanged failures
                // are reported instead of silently expanding the user's request.
                const actionable = results.some(
                    (result) =>
                        result.status === "failed" &&
                        !this.evidence.baseline.some(
                            (baseline) =>
                                baseline.status === "failed" &&
                                sameCheck(baseline.check, result.check),
                        ),
                );
                const baselineIncomplete = this.evidence.baseline.some(
                    (result) => !["passed", "failed"].includes(result.status),
                );
                if (!actionable || baselineIncomplete) {
                    await this.block(
                        "Only existing baseline failures remain, or baseline checks were incomplete; no automatic repair requested.",
                    );
                    return;
                }
                this.evidence.repairRounds++;
                await this.setStage("investigating");
                const testHashes = await this.testFingerprints();
                await this.setStage("repairing");
                const repair = debuggingSubmissionSchema.parse(
                    await debuggerAgent.execute({
                        phase: "repair",
                        userRequest,
                        implementationSummary,
                        evidence: this.handoffEvidence(),
                    }),
                );
                if (repair.blockedReason) {
                    await this.block(repair.blockedReason);
                    return;
                }
                if (
                    JSON.stringify(repair.coverage) !==
                        JSON.stringify(this.evidence.coverage) ||
                    JSON.stringify(
                        await this.runner.validateChecks(repair.checks),
                    ) !== JSON.stringify(this.selectedChecks)
                ) {
                    await this.block(
                        "Repair changed selected checks or coverage; review is required before continuing.",
                    );
                    return;
                }
                if (
                    testHashes !== (await this.testFingerprints()) &&
                    !repair.testChangesReason.trim()
                ) {
                    await this.block(
                        "Tests changed during repair without an explanation; verification is incomplete.",
                    );
                    return;
                }
                this.recordFindings(repair);
                if (this.unsafe) {
                    await this.block(
                        "Repair encountered a permission or edit recovery limit.",
                    );
                    return;
                }
                // Always rerun against current code, including when no successful edit was reported.
                this.evidence.dirty = true;
            }
        } catch (error) {
            this.context.signal?.throwIfAborted();
            await this.block(
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private async acceptPreparation(
        submission: DebuggingSubmission,
    ): Promise<void> {
        if (!submission.coverage.length) {
            throw new Error(
                "No requested behavior has test coverage recorded.",
            );
        }
        const checks = await this.runner.validateChecks(submission.checks);
        // Keep baseline checks, so focused feature tests cannot quietly drop existing checks.
        for (const baseline of this.baselineChecks) {
            const existing = checks.find(
                (check) => check.name === baseline.name,
            );
            if (existing && !sameCheck(existing, baseline)) {
                throw new Error(
                    "A selected check reuses a baseline name for a different command.",
                );
            }
            if (!existing) {
                checks.push(baseline);
            }
        }
        this.selectedChecks = await this.runner.validateChecks(checks);
        const names = new Set(this.selectedChecks.map((check) => check.name));
        for (const coverage of submission.coverage) {
            if (coverage.checkNames.some((name) => !names.has(name))) {
                throw new Error(
                    "Coverage refers to a check that was not selected.",
                );
            }
        }
        this.evidence.coverage = submission.coverage;
        await this.testFingerprints();
        this.recordFindings(submission);
        if (this.unsafe) {
            throw new Error(
                "Test preparation encountered an editing safety limit.",
            );
        }
        await this.onProgress();
    }

    private recordFindings(submission: DebuggingSubmission): void {
        this.evidence.findings!.push(...submission.findings);
        if (submission.testChangesReason) {
            this.evidence.testChangesReasons!.push(
                submission.testChangesReason,
            );
        }
    }

    private async testFingerprints(): Promise<string> {
        const fingerprints: string[] = [];
        const files = [
            ...new Set(
                this.evidence.coverage!.flatMap((item) => item.testFiles),
            ),
        ].sort();
        for (const filename of files) {
            const file = Bun.file(await this.workspace.resolve(filename));
            if (!(await file.exists()) || file.size > 2000000) {
                throw new Error(
                    "A listed test file is missing or exceeds the size limit.",
                );
            }
            fingerprints.push(
                JSON.stringify([
                    filename,
                    contentHash(Buffer.from(await file.bytes())),
                ]),
            );
        }
        return contentHash(fingerprints.join("\n"));
    }

    async confirmCurrent(): Promise<void> {
        if (!this.verifiedSnapshot) {
            return;
        }
        let stable = false;
        try {
            stable =
                !this.runner.hasRunningProcesses() &&
                this.evidence.pendingProcesses.length === 0 &&
                this.verifiedSnapshot ===
                    (await workspaceSnapshot(
                        this.workspace,
                        this.context.signal,
                    ));
        } catch {
            this.context.signal?.throwIfAborted();
        }
        if (!stable) {
            for (const result of this.evidence.runs.at(-1) ?? []) {
                if (["passed", "failed"].includes(result.status)) {
                    result.status = "invalidated";
                    result.detail =
                        "Observed code changed or stability became unknown after testing.";
                }
            }
            await this.block(
                "Results became outdated before the final report; current code is not verified.",
            );
        }
    }

    private async setStage(
        stage: VerificationEvidence["stage"],
    ): Promise<void> {
        this.evidence.stage = stage;
        await this.onProgress();
    }

    private async block(reason: string): Promise<void> {
        this.evidence.dirty = true;
        this.evidence.notices.push(reason);
        await this.setStage("blocked");
    }

    snapshot(): VerificationEvidence {
        return structuredClone(this.evidence);
    }

    private handoffEvidence(): VerificationEvidence {
        const evidence = this.snapshot();
        // Do not recursively embed earlier debugging conversations in new handoffs.
        evidence.debuggingMessages = [];
        return evidence;
    }

    report(): string {
        return verificationReport(this.evidence);
    }
}

function sameCheck(
    first: VerificationCheck,
    second: VerificationCheck,
): boolean {
    return (
        first.name === second.name &&
        first.command === second.command &&
        first.directory === second.directory &&
        JSON.stringify(first.args) === JSON.stringify(second.args)
    );
}
