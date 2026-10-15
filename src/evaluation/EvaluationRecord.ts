import { createHash } from "node:crypto";
import { z } from "zod";
import type {
    VerificationEvidence,
    CheckResult,
} from "../verification/VerificationResults";

export const fingerprint = (value: unknown): string =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const taskIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const count = z.number().int().nonnegative();
const countsSchema = z.object({
    passed: count,
    failed: count,
    denied: count,
    timed_out: count,
    cancelled: count,
    unavailable: count,
    invalidated: count,
});

export const contextSchema = z.object({
    promptHash: z.string(),
    mode: z.enum(["plan", "act"]),
    workspaceState: z.string().nullable(),
    permissionsHash: z.string().nullable(),
    provider: z.string(),
    model: z.string(),
    reasoning: z.string(),
    platform: z.string(),
    runtime: z.string(),
});

export const comparisonSchema = z.object({
    previousRun: z.string().uuid().nullable(),
    compatible: z.boolean(),
    explanation: z.string(),
    durationDeltaMs: z.number().optional(),
    repairRoundsDelta: z.number().optional(),
    failedChecksDelta: z.number().optional(),
    modelRequestsDelta: z.number().optional(),
});

export const evaluationRecordSchema = z.object({
    version: z.literal(1),
    id: z.string().uuid(),
    taskId: taskIdSchema,
    createdAt: z.string().datetime(),
    promptPreview: z.string().max(300),
    rexa: z.object({
        packageVersion: z.string(),
        revision: z.string().nullable(),
        sourceHash: z.string().nullable(),
    }),
    context: contextSchema,
    route: z.string().nullable(),
    outcome: z.enum([
        "completed",
        "verification_blocked",
        "guardrail_blocked",
        "error",
        "cancelled",
    ]),
    durationMs: z.number().nonnegative(),
    error: z.string().max(1000).nullable(),
    sessionId: z.string().nullable(),
    activity: z.object({
        modelRequests: count,
        modelErrors: count,
        toolResults: count,
        toolFailures: count,
        deniedTools: count,
        guardrailBlocks: count,
        pageReads: count,
        successfulPageReads: count,
        sourceUrls: z.array(z.string().max(500)).max(20),
    }),
    verification: z
        .object({
            stage: z.string().nullable(),
            repairRounds: count,
            baseline: countsSchema,
            first: countsSchema,
            latest: countsSchema,
            checkPlanHash: z.string(),
            coveredBehaviors: z.array(z.string().max(500)).max(30),
            testFiles: z.array(z.string().max(500)).max(100),
            changedFiles: z.array(z.string().max(500)).max(100),
            testChangesReasons: z.array(z.string().max(500)).max(20),
            failures: z
                .array(
                    z.object({
                        check: z.string().max(100),
                        status: z.string(),
                        exitCode: z.number().nullable(),
                        message: z.string().max(1000),
                        locations: z.array(z.string().max(500)).max(10),
                    }),
                )
                .max(20),
            firstFailures: z
                .array(
                    z.object({
                        check: z.string().max(100),
                        message: z.string().max(1000),
                    }),
                )
                .max(10),
            reportedFindings: z
                .array(
                    z.object({
                        explanation: z.string().max(500),
                        files: z.array(z.string().max(500)).max(10),
                        changes: z.string().max(500),
                    }),
                )
                .max(10),
        })
        .nullable(),
    limitations: z.array(z.string().max(500)).max(15),
    comparison: comparisonSchema.nullable(),
});
export type EvaluationRecord = z.infer<typeof evaluationRecordSchema>;
export type EvaluationContext = z.infer<typeof contextSchema>;
export type Comparison = z.infer<typeof comparisonSchema>;

function countChecks(checks: CheckResult[]) {
    const counts = {
        passed: 0,
        failed: 0,
        denied: 0,
        timed_out: 0,
        cancelled: 0,
        unavailable: 0,
        invalidated: 0,
    };
    for (const check of checks) {
        counts[check.status]++;
    }
    return counts;
}

/** Counts command checks, not assertions or test cases parsed from free-form output. */
export function summarizeVerification(
    evidence: VerificationEvidence,
): NonNullable<EvaluationRecord["verification"]> {
    const latest = evidence.runs.at(-1) ?? [];
    return {
        stage: evidence.stage ?? null,
        repairRounds: evidence.repairRounds,
        baseline: countChecks(evidence.baseline),
        first: countChecks(evidence.runs[0] ?? []),
        latest: countChecks(latest),
        checkPlanHash: fingerprint(
            latest
                .map(({ check }) => check)
                .sort((a, b) => a.name.localeCompare(b.name)),
        ),
        coveredBehaviors: (evidence.coverage ?? [])
            .map(({ behavior }) => behavior.slice(0, 500))
            .slice(0, 30),
        testFiles: [
            ...new Set(
                (evidence.coverage ?? []).flatMap(({ testFiles }) => testFiles),
            ),
        ]
            .map((file) => file.slice(0, 500))
            .slice(0, 100),
        changedFiles: evidence.changedFiles
            .map((file) => file.slice(0, 500))
            .slice(0, 100),
        testChangesReasons: (evidence.testChangesReasons ?? [])
            .map((reason) => reason.slice(0, 500))
            .slice(0, 20),
        failures: latest
            .filter((check) => check.status !== "passed")
            .slice(0, 20)
            .map((check) => ({
                check: check.check.name.slice(0, 100),
                status: check.status,
                exitCode: check.exitCode,
                message: (check.detail ?? check.stderr ?? "").slice(0, 1000),
                locations: (check.locations ?? [])
                    .map((location) => location.slice(0, 500))
                    .slice(0, 10),
            })),
        firstFailures: (evidence.runs[0] ?? [])
            .filter((check) => check.status !== "passed")
            .slice(0, 10)
            .map((check) => ({
                check: check.check.name.slice(0, 100),
                message: (check.detail || check.stderr || check.stdout).slice(
                    0,
                    1000,
                ),
            })),
        reportedFindings: (evidence.findings ?? [])
            .slice(0, 10)
            .map((finding) => ({
                explanation: finding.explanation.slice(0, 500),
                files: finding.files
                    .slice(0, 10)
                    .map((file) => file.slice(0, 500)),
                changes: finding.changes.slice(0, 500),
            })),
    };
}

export function compareRecords(
    current: EvaluationRecord,
    previous?: EvaluationRecord,
): Comparison {
    const noComparison = (explanation: string): Comparison => ({
        previousRun: previous?.id ?? null,
        compatible: false,
        explanation,
    });
    if (!previous) {
        return noComparison(
            "No previous run or selected baseline exists for this task.",
        );
    }
    if (
        current.taskId !== previous.taskId ||
        !current.context.workspaceState ||
        !previous.context.workspaceState ||
        !current.context.permissionsHash ||
        !previous.context.permissionsHash
    ) {
        return noComparison(
            "Task identity or starting context is missing or differs.",
        );
    }
    if (
        fingerprint(current.context) !== fingerprint(previous.context) ||
        current.route !== previous.route
    ) {
        return noComparison(
            "Requirements, initial project state, model settings, environment, permissions, or route differ. No fair automatic comparison.",
        );
    }
    if (
        current.verification?.checkPlanHash !==
        previous.verification?.checkPlanHash
    ) {
        return noComparison("The recorded verification command plans differ.");
    }
    const comparison: Comparison = {
        previousRun: previous.id,
        compatible: true,
        explanation:
            "Recorded contexts match. Deltas are observations, not proof of causation or overall quality; repeat tasks to assess model variation.",
        durationDeltaMs: current.durationMs - previous.durationMs,
        modelRequestsDelta:
            current.activity.modelRequests - previous.activity.modelRequests,
    };
    if (current.verification && previous.verification) {
        comparison.repairRoundsDelta =
            current.verification.repairRounds -
            previous.verification.repairRounds;
        comparison.failedChecksDelta =
            current.verification.latest.failed -
            previous.verification.latest.failed;
    }
    return comparison;
}
