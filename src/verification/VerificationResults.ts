import { z } from "zod";
import type { Message } from "../agent/Message";
import { sanitizeStored } from "../utils/SanitizeStored";

export const verificationCheckSchema = z
    .object({
        name: z
            .string()
            .min(1)
            .max(100)
            .regex(/^[^\x00-\x1f\x7f]+$/),
        command: z.string().regex(/^[a-zA-Z0-9_.+-]+$/),
        args: z.array(z.string().max(2000)).max(100).default([]),
        directory: z
            .string()
            .default(".")
            .refine(
                (directory) =>
                    directory === "." ||
                    (/^[^\\:]+$/.test(directory) &&
                        directory
                            .split("/")
                            .every(
                                (part) =>
                                    part !== ".." &&
                                    part !== "." &&
                                    part !== "",
                            )),
                "Use a relative project directory without traversal.",
            ),
        timeoutMs: z.number().int().positive().max(300000).default(60000),
    })
    .strict();

export type VerificationCheck = z.infer<typeof verificationCheckSchema>;

export const checkResultSchema = z.object({
    check: verificationCheckSchema,
    status: z.enum([
        "passed",
        "failed",
        "denied",
        "timed_out",
        "cancelled",
        "unavailable",
        "invalidated",
    ]),
    exitCode: z.number().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    detail: z.string().optional(),
    durationMs: z.number(),
    // Raw output remains authoritative; locations are clues, not root causes.
    locations: z.array(z.string()).optional(),
});

export type CheckResult = z.infer<typeof checkResultSchema>;

const coverageSchema = z
    .object({
        behavior: z.string().min(1).max(1000),
        testFiles: z.array(z.string().min(1).max(500)).min(1).max(20),
        checkNames: z.array(z.string().min(1)).min(1).max(10),
    })
    .strict();

export const debuggingSubmissionSchema = z
    .object({
        coverage: z.array(coverageSchema).max(30),
        checks: z.array(verificationCheckSchema).max(10),
        findings: z
            .array(
                z
                    .object({
                        explanation: z.string().min(1).max(2000),
                        files: z.array(z.string().max(500)).max(20),
                        evidence: z.string().min(1).max(4000),
                        changes: z.string().max(2000),
                    })
                    .strict(),
            )
            .max(20),
        testChangesReason: z.string().max(2000).default(""),
        blockedReason: z.string().max(2000).default(""),
    })
    .strict();

export type DebuggingSubmission = z.infer<typeof debuggingSubmissionSchema>;

export interface DebuggingRequest {
    phase: "prepare" | "repair";
    userRequest: string;
    implementationSummary: string;
    evidence: VerificationEvidence;
}

export interface DebuggingService {
    execute(request: DebuggingRequest): Promise<DebuggingSubmission>;
}

export const verificationEvidenceSchema = z.object({
    source: z.string(),
    notices: z.array(z.string()),
    baseline: z.array(checkResultSchema),
    runs: z.array(z.array(checkResultSchema)),
    changedFiles: z.array(z.string()),
    repairRounds: z.number().int().min(0).max(2),
    pendingProcesses: z.array(z.string()),
    dirty: z.boolean(),
    // Optional fields allow older saved sessions to remain readable.
    stage: z
        .enum([
            "inspecting",
            "implementing",
            "preparing_tests",
            "running_tests",
            "investigating",
            "repairing",
            "completed",
            "blocked",
        ])
        .optional(),
    coverage: z.array(coverageSchema).optional(),
    findings: debuggingSubmissionSchema.shape.findings.optional(),
    testChangesReasons: z.array(z.string()).optional(),
    debuggingMessages: z.array(z.record(z.string(), z.unknown())).optional(),
});

export type VerificationEvidence = z.infer<typeof verificationEvidenceSchema>;

export function recordedDebuggingMessage(
    message: Message,
): Record<string, unknown> {
    const record = sanitizeStored({ ...message });
    const serialized = JSON.stringify(record);
    if (serialized.length > 24000) {
        return {
            role: message.role,
            truncated: true,
            preview: serialized.slice(0, 24000),
        };
    }
    return record;
}

/** Reports recorded commands separately from model-authored investigation findings. */
export function verificationReport(evidence: VerificationEvidence): string {
    const lines = [
        "Verification (recorded results):",
        `- Stage: ${evidence.stage ?? "historical"}.`,
    ];
    for (const coverage of evidence.coverage ?? []) {
        lines.push(
            `- Behavior: ${coverage.behavior}. Tests: ${coverage.testFiles.join(", ")}.`,
        );
    }
    const latest = evidence.runs.at(-1) ?? [];
    if (evidence.changedFiles.length) {
        lines.push(
            `- Changed paths reported by tools: ${evidence.changedFiles.join(", ")}.`,
        );
    }
    if (!latest.length) {
        lines.push(
            "- No current post-change checks completed; this task has not verified the current code.",
        );
    }
    for (const result of latest) {
        const baseline = evidence.baseline.find(
            (item) => item.check.name === result.check.name,
        );
        const comparison =
            baseline?.status === "passed"
                ? "baseline passed"
                : baseline?.status === "failed"
                  ? "failed at baseline; additional regressions are not ruled out"
                  : "baseline unavailable";
        lines.push(
            `- ${result.check.name}: ${result.status.replaceAll("_", " ")} (${comparison}).${result.detail ? ` ${result.detail}` : ""}`,
        );
        if (result.status !== "passed") {
            lines.push(
                `  Command: ${result.check.command} ${result.check.args.join(" ")}`,
            );
            if (result.locations?.length) {
                lines.push(
                    `  Reported locations: ${result.locations.join(", ")}`,
                );
            }
            if (result.stderr || result.stdout) {
                lines.push(
                    `  Output: ${(result.stderr || result.stdout).slice(0, 2000)}`,
                );
            }
        }
    }
    for (const finding of evidence.findings ?? []) {
        lines.push(
            `- Agent investigation: ${finding.explanation} Files: ${finding.files.join(", ")}. Evidence: ${finding.evidence}. Changes: ${finding.changes || "none reported"}.`,
        );
    }
    lines.push(
        ...(evidence.testChangesReasons ?? []).map(
            (reason) => `- Test revision explanation: ${reason}`,
        ),
    );
    if (evidence.dirty) {
        lines.push("- Current verification is incomplete or outdated.");
    }
    lines.push(...evidence.notices.map((notice) => `- ${notice}`));
    lines.push(
        `- Automatic repair rounds used: ${evidence.repairRounds} of 2.`,
    );
    lines.push(
        "- Passing selected checks does not prove complete correctness or test adequacy.",
    );
    return sanitizeStored(lines.join("\n"));
}
