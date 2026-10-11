import { contentHash, type Workspace } from "../tools/Workspace";
import { stat } from "node:fs/promises";
import type { ToolDispatcher } from "../tools/ToolDispatcher";
import type { ToolExecutionContext } from "../tools/ToolRegistry";
import {
    verificationCheckSchema,
    type VerificationCheck,
    type CheckResult,
} from "./VerificationResults";
import { sanitizeStored } from "../utils/SanitizeStored";
import { sandboxManager } from "../tools/ExecutionManager";

const MAX_OUTPUT_CHARACTERS = 8000;

const TOTAL_CHECK_BUDGET_MS = 600000;

function resultRecord(
    check: VerificationCheck,
    status: CheckResult["status"],
    detail?: string,
): CheckResult {
    return {
        check,
        status,
        exitCode: null,
        stdout: "",
        stderr: "",
        detail,
        durationMs: 0,
    };
}

function objectResult(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
}

/** Uses the normal permission/command boundary, never a second execution path. */
export class VerificationRunner {
    private elapsedMs = 0;

    constructor(
        private workspace: Workspace,
        private dispatcher: ToolDispatcher,
        private context: ToolExecutionContext,
        private onProgress: () => Promise<void> = async () => {},
        private busy = () =>
            sandboxManager.processes
                .list()
                .some((process) => process.status === "running"),
    ) {}

    hasRunningProcesses(): boolean {
        return this.busy();
    }

    async validateChecks(
        input: VerificationCheck[],
    ): Promise<VerificationCheck[]> {
        if (!input.length || input.length > 10) {
            throw new Error("Select between one and ten finite checks.");
        }
        const checks = input.map((check) =>
            verificationCheckSchema.parse(check),
        );
        if (new Set(checks.map((check) => check.name)).size !== checks.length) {
            throw new Error("Check names must be unique.");
        }
        for (const check of checks) {
            const directory = await this.workspace.resolve(check.directory);
            if (!(await stat(directory)).isDirectory()) {
                throw new Error("Check directory does not exist.");
            }
            if (
                check.args.some((arg) =>
                    /^(--watch(?:=.*)?|--fix(?:=.*)?|-w)$/.test(arg),
                )
            ) {
                throw new Error(
                    "Verification requires finite checks without watch or autofix options.",
                );
            }
        }
        return checks;
    }

    /** Optional baseline commands. The debugging agent can select task-specific checks later. */
    async discoverChecks(): Promise<{
        checks: VerificationCheck[];
        notices: string[];
    }> {
        try {
            const configured = await readProjectJson(
                this.workspace,
                "rexa.verify.json",
            );
            if (configured !== undefined) {
                const config = configured as {
                    version?: unknown;
                    checks?: unknown;
                };
                if (config.version !== 1 || !Array.isArray(config.checks)) {
                    throw new Error("Invalid verification configuration.");
                }
                return {
                    checks: await this.validateChecks(config.checks),
                    notices: [],
                };
            }
            const manifest = ((await readProjectJson(
                this.workspace,
                "package.json",
            )) ?? {}) as {
                packageManager?: unknown;
                scripts?: Record<string, unknown>;
            };
            const manager = await discoverPackageManager(
                this.workspace,
                manifest.packageManager,
            );
            const checks: VerificationCheck[] = [];
            if (manager) {
                for (const name of [
                    "typecheck",
                    "lint",
                    "test:ci",
                    "test:run",
                ]) {
                    const script = manifest.scripts?.[name];
                    if (
                        typeof script === "string" &&
                        !/\bwatch\b|--fix\b/i.test(script)
                    ) {
                        checks.push(
                            verificationCheckSchema.parse({
                                name,
                                command: manager,
                                args: ["run", name],
                            }),
                        );
                    }
                }
            }
            return {
                checks,
                notices: checks.length
                    ? []
                    : [
                          "No baseline commands discovered; the debugging agent must inspect the project and select tests.",
                      ],
            };
        } catch {
            return {
                checks: [],
                notices: [
                    "Baseline configuration is invalid or unreadable; no baseline commands selected.",
                ],
            };
        }
    }

    async run(
        checks: VerificationCheck[],
        results: CheckResult[],
        pending = false,
    ): Promise<string | undefined> {
        this.context.signal?.throwIfAborted();
        if (!checks.length) {
            return;
        }
        if (pending || this.busy()) {
            results.push(
                ...checks.map((check) =>
                    resultRecord(
                        check,
                        "unavailable",
                        "An owned background process is unfinished; workspace stability is unknown.",
                    ),
                ),
            );
            return;
        }
        let before: string;
        try {
            before = await workspaceSnapshot(
                this.workspace,
                this.context.signal,
            );
        } catch (error) {
            this.context.signal?.throwIfAborted();
            const reason = sanitizeStored(
                error instanceof Error ? error.message : String(error),
            ).slice(0, 2000);
            results.push(
                ...checks.map((check) =>
                    resultRecord(
                        check,
                        "unavailable",
                        `Could not establish a bounded workspace snapshot: ${reason}`,
                    ),
                ),
            );
            return;
        }
        try {
            for (const check of checks) {
                this.context.signal?.throwIfAborted();
                const remaining = TOTAL_CHECK_BUDGET_MS - this.elapsedMs;
                if (remaining <= 0) {
                    results.push(
                        resultRecord(
                            check,
                            "unavailable",
                            "Task verification time budget exhausted.",
                        ),
                    );
                    continue;
                }
                this.context.onOutput?.(
                    `\nVerification: ${check.name} — ${check.command} ${check.args.join(" ")}\n`,
                    "stdout",
                );
                const startedAt = Date.now();
                const result = resultRecord(
                    check,
                    "unavailable",
                    "Check started; no outcome has been recorded yet.",
                );
                // Include the in-flight check in persisted state if cancellation interrupts it.
                results.push(result);
                await this.onProgress();
                try {
                    await this.validateChecks([check]);
                    await this.workspace.resolve(check.directory);
                    const executed = objectResult(
                        await this.dispatcher.execute(
                            "execute_command",
                            {
                                command: check.command,
                                args: check.args,
                                workdir:
                                    check.directory === "."
                                        ? "/app"
                                        : `/app/${check.directory}`,
                                timeoutMs: Math.min(check.timeoutMs, remaining),
                                background: false,
                            },
                            "act",
                            this.context,
                        ),
                    );
                    this.context.signal?.throwIfAborted();
                    const exitCode =
                        typeof executed.exitCode === "number"
                            ? executed.exitCode
                            : null;
                    let status: CheckResult["status"] = "unavailable";
                    if (executed.status === "rejected") {
                        status = "denied";
                    } else if (
                        executed.status === "timeout" ||
                        exitCode === 124
                    ) {
                        status = "timed_out";
                    } else if (executed.status === "cancelled") {
                        status = "cancelled";
                    } else if (
                        executed.success === true &&
                        exitCode === 0 &&
                        executed.status === "executed"
                    ) {
                        status = "passed";
                    } else if (
                        exitCode === 126 ||
                        exitCode === 127 ||
                        executed.status === "running" ||
                        /ENOENT|EACCES|posix_spawn/.test(
                            String(executed.stderr ?? ""),
                        )
                    ) {
                        status = "unavailable";
                    } else if (exitCode !== null) {
                        status = "failed";
                    }
                    Object.assign(result, {
                        status,
                        exitCode,
                        stdout: sanitizeStored(
                            String(executed.stdout ?? ""),
                        ).slice(0, MAX_OUTPUT_CHARACTERS),
                        stderr: sanitizeStored(
                            String(executed.stderr ?? ""),
                        ).slice(0, MAX_OUTPUT_CHARACTERS),
                        locations: reportedLocations(
                            String(executed.stderr ?? "") +
                                "\n" +
                                String(executed.stdout ?? ""),
                        ),
                        detail:
                            status === "unavailable"
                                ? "Command did not produce a conclusive completed result."
                                : undefined,
                    });
                } catch (error) {
                    if (this.context.signal?.aborted) {
                        result.status = "cancelled";
                        result.detail = "Task cancelled during verification.";
                        this.context.signal.throwIfAborted();
                    }
                    result.detail = sanitizeStored(
                        error instanceof Error ? error.message : String(error),
                    ).slice(0, 2000);
                } finally {
                    result.durationMs = Date.now() - startedAt;
                    this.elapsedMs += result.durationMs;
                    await this.onProgress();
                }
            }
            let after: string;
            try {
                after = await workspaceSnapshot(
                    this.workspace,
                    this.context.signal,
                );
            } catch (error) {
                this.context.signal?.throwIfAborted();
                const reason = sanitizeStored(
                    error instanceof Error ? error.message : String(error),
                ).slice(0, 2000);
                this.invalidate(
                    results,
                    `Workspace stability could not be confirmed after checks: ${reason}`,
                );
                return;
            }
            if (this.busy() || before !== after) {
                this.invalidate(
                    results,
                    "Eligible workspace files changed during verification, or a process is still running.",
                );
                return;
            }
            return before;
        } catch (error) {
            this.invalidate(
                results,
                "Workspace stability was not confirmed after verification.",
            );
            this.context.signal?.throwIfAborted();
            throw error;
        }
    }

    private invalidate(results: CheckResult[], detail: string): void {
        for (const result of results) {
            if (result.status === "passed" || result.status === "failed") {
                result.status = "invalidated";
                result.detail = detail;
            }
        }
    }
}

/** Keep locations reported by the command; do not infer a root cause from them. */
function reportedLocations(output: string): string[] {
    const matches =
        output.match(
            /(?:[a-zA-Z]:[\\/])?[\w./\\@-]+\.(?:[cm]?[jt]sx?|py|go|rs|java):\d+(?::\d+)?/g,
        ) ?? [];
    return [...new Set(matches)]
        .slice(0, 30)
        .map((location) => sanitizeStored(location));
}

async function readProjectJson(
    workspace: Workspace,
    filename: string,
): Promise<unknown | undefined> {
    const file = Bun.file(await workspace.resolve(filename));
    if (!(await file.exists())) {
        return undefined;
    }
    if (file.size > 256000) {
        throw new Error("Project configuration exceeds the size limit.");
    }
    return file.json();
}

async function discoverPackageManager(
    workspace: Workspace,
    declared: unknown,
): Promise<string | undefined> {
    if (typeof declared === "string") {
        const name = declared.split("@")[0];
        return name && ["bun", "npm", "pnpm", "yarn"].includes(name)
            ? name
            : undefined;
    }
    const found = new Set<string>();
    const lockfiles: Array<[string, string]> = [
        ["bun", "bun.lock"],
        ["bun", "bun.lockb"],
        ["npm", "package-lock.json"],
        ["pnpm", "pnpm-lock.yaml"],
        ["yarn", "yarn.lock"],
    ];
    for (const [manager, filename] of lockfiles) {
        if (await Bun.file(await workspace.resolve(filename)).exists()) {
            found.add(manager);
        }
    }
    return found.size === 1 ? [...found][0] : undefined;
}

/** A bounded observation, not a backup or a substitute for reading before editing. */
export async function workspaceSnapshot(
    workspace: Workspace,
    signal?: AbortSignal,
): Promise<string> {
    const entries: string[] = [];
    let totalBytes = 0;
    for (const filename of await workspace.files()) {
        signal?.throwIfAborted();
        const file = Bun.file(await workspace.resolve(filename));
        if (file.size > 2000000) {
            throw new Error("A discovered file exceeds the snapshot limit.");
        }
        totalBytes += file.size;
        if (totalBytes > 32000000) {
            throw new Error("Workspace exceeds the snapshot budget.");
        }
        const bytes = await file.bytes();
        if (!bytes.includes(0)) {
            entries.push(
                JSON.stringify([filename, contentHash(Buffer.from(bytes))]),
            );
        }
    }
    signal?.throwIfAborted();
    return contentHash(entries.join("\n"));
}
