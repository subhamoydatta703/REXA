import {
    mkdir,
    lstat,
    readdir,
    readFile,
    writeFile,
    rename,
    unlink,
    rmdir,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Workspace } from "../tools/Workspace";
import { acquireFileLease } from "../utils/FileLease";
import { sanitizeStored } from "../utils/SanitizeStored";
import {
    compareRecords,
    evaluationRecordSchema,
    taskIdSchema,
    type EvaluationRecord,
} from "./EvaluationRecord";

export const retentionSchema = z
    .object({
        recentRuns: z.number().int().min(5).max(10).default(5),
        maxBytes: z
            .number()
            .int()
            .min(1024)
            .max(1_073_741_824)
            .default(20 * 1024 * 1024),
    })
    .strict();
export type RetentionSettings = z.infer<typeof retentionSchema>;
const MAX_RECORD_BYTES = 64_000;
const baselineSchema = z.object({ runId: z.string().uuid() }).strict();

interface StoredRun {
    record: EvaluationRecord;
    bytes: number;
    baseline: boolean;
}

/** Owns only compact JSON records under this workspace's past-evaluations folder. */
export class EvaluationStore {
    readonly directory: string;
    private workspace: Workspace;

    constructor(workspace = process.cwd()) {
        this.workspace = new Workspace(workspace);
        this.directory = path.join(
            this.workspace.root,
            ".rexa",
            "past-evaluations",
        );
    }

    private async safePath(relative = ""): Promise<string> {
        const target = await this.workspace.resolve(
            path.join(".rexa", "past-evaluations", relative),
            true,
        );
        const pieces = path
            .relative(this.workspace.root, target)
            .split(path.sep);
        let current = this.workspace.root;
        for (const piece of pieces) {
            current = path.join(current, piece);
            try {
                if ((await lstat(current)).isSymbolicLink()) {
                    throw new Error(
                        "Evaluation storage refuses symbolic links.",
                    );
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }
            }
        }
        return target;
    }

    private async atomicJson(relative: string, value: unknown): Promise<void> {
        const filename = await this.safePath(relative);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        const temporary = await this.safePath(
            `${relative}.${randomUUID()}.tmp`,
        );
        try {
            await writeFile(temporary, JSON.stringify(value, null, 4) + "\n", {
                flag: "wx",
                mode: 0o600,
            });
            await rename(temporary, filename);
        } finally {
            await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") {
                    throw error;
                }
            });
        }
    }

    private async readJson(relative: string): Promise<unknown> {
        const filename = await this.safePath(relative);
        const size = (await lstat(filename)).size;
        if (size > MAX_RECORD_BYTES) {
            throw new Error("Evaluation record exceeds its size limit.");
        }
        return JSON.parse(await readFile(filename, "utf8"));
    }

    /** Commit a complete run directory, so a failed write cannot expose half a record. */
    private async writeRecord(record: EvaluationRecord): Promise<void> {
        const pending = `.pending-${randomUUID()}`;
        const staging = await this.safePath(pending);
        await mkdir(staging, { mode: 0o700 });
        try {
            await writeFile(
                await this.safePath(`${pending}/record.json`),
                JSON.stringify(record, null, 4) + "\n",
                { flag: "wx", mode: 0o600 },
            );
            await mkdir(await this.safePath(record.taskId), {
                recursive: true,
                mode: 0o700,
            });
            await rename(
                staging,
                await this.safePath(`${record.taskId}/${record.id}`),
            );
        } finally {
            await unlink(await this.safePath(`${pending}/record.json`)).catch(
                (error: NodeJS.ErrnoException) => {
                    if (error.code !== "ENOENT") {
                        throw error;
                    }
                },
            );
            await rmdir(staging).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") {
                    throw error;
                }
            });
        }
    }

    async settings(): Promise<RetentionSettings> {
        try {
            return retentionSchema.parse(await this.readJson("settings.json"));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return retentionSchema.parse({});
            }
            throw error;
        }
    }

    private async locked<T>(operation: () => Promise<T>): Promise<T> {
        await mkdir(await this.safePath(), { recursive: true, mode: 0o700 });
        const release = await acquireFileLease(await this.safePath(".lock"));
        try {
            // Protect records in projects that do not inherit REXA's .gitignore.
            const ignoreFile = await this.safePath(".gitignore");
            try {
                await writeFile(ignoreFile, "*\n", { flag: "wx", mode: 0o600 });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                    throw error;
                }
                if ((await readFile(ignoreFile, "utf8")).trim() !== "*") {
                    throw new Error(
                        "Evaluation ignore rule was changed; inspect it before recording private history.",
                    );
                }
            }
            return await operation();
        } finally {
            await release();
        }
    }

    private async runs(): Promise<StoredRun[]> {
        const runs: StoredRun[] = [];
        let tasks;
        try {
            tasks = await readdir(await this.safePath(), {
                withFileTypes: true,
            });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return runs;
            }
            throw error;
        }
        for (const task of tasks) {
            if (/^\.pending-[0-9a-f-]{36}$/.test(task.name)) {
                continue;
            }
            if (["settings.json", ".lock", ".gitignore"].includes(task.name)) {
                continue;
            }
            taskIdSchema.parse(task.name);
            if (!task.isDirectory() || task.isSymbolicLink()) {
                throw new Error(
                    "Unexpected evaluation task entry; inspect storage before cleanup.",
                );
            }
            let baseline: string | undefined;
            try {
                baseline = baselineSchema.parse(
                    await this.readJson(`${task.name}/baseline.json`),
                ).runId;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }
            }
            for (const run of await readdir(await this.safePath(task.name), {
                withFileTypes: true,
            })) {
                if (run.name === "baseline.json") {
                    continue;
                }
                z.string().uuid().parse(run.name);
                if (!run.isDirectory() || run.isSymbolicLink()) {
                    throw new Error(
                        "Unexpected evaluation run entry; cleanup refused.",
                    );
                }
                const relative = `${task.name}/${run.name}/record.json`;
                const record = evaluationRecordSchema.parse(
                    await this.readJson(relative),
                );
                if (record.id !== run.name || record.taskId !== task.name) {
                    throw new Error(
                        "Evaluation identity does not match its directory.",
                    );
                }
                runs.push({
                    record,
                    bytes: (await lstat(await this.safePath(relative))).size,
                    baseline: run.name === baseline,
                });
            }
            if (
                baseline &&
                !runs.some(
                    (run) =>
                        run.record.taskId === task.name &&
                        run.record.id === baseline,
                )
            ) {
                throw new Error("Selected evaluation baseline is missing.");
            }
        }
        return runs.sort(
            (a, b) =>
                b.record.createdAt.localeCompare(a.record.createdAt) ||
                b.record.id.localeCompare(a.record.id),
        );
    }

    async history(
        taskId: string,
    ): Promise<{ record: EvaluationRecord; baseline: boolean }[]> {
        taskIdSchema.parse(taskId);
        return (await this.runs())
            .filter((run) => run.record.taskId === taskId)
            .map(({ record, baseline }) => ({ record, baseline }));
    }

    private async removeRun(run: StoredRun): Promise<void> {
        const relative = `${run.record.taskId}/${run.record.id}`;
        const entries = await readdir(await this.safePath(relative));
        if (entries.length !== 1 || entries[0] !== "record.json") {
            throw new Error(
                "Unexpected files in evaluation run; automatic removal refused.",
            );
        }
        await unlink(await this.safePath(`${relative}/record.json`));
        await rmdir(await this.safePath(relative));
        const taskDirectory = await this.safePath(run.record.taskId);
        if ((await readdir(taskDirectory)).length === 0) {
            await rmdir(taskDirectory);
        }
    }

    private async prune(
        settings: RetentionSettings,
        newestRun?: string,
    ): Promise<void> {
        let runs = await this.runs();
        const recentCounts = new Map<string, number>();
        for (const run of runs) {
            if (run.baseline) {
                continue;
            }
            const count = (recentCounts.get(run.record.taskId) ?? 0) + 1;
            recentCounts.set(run.record.taskId, count);
            if (count > settings.recentRuns && run.record.id !== newestRun) {
                await this.removeRun(run);
            }
        }
        runs = await this.runs();
        let bytes = runs.reduce((sum, run) => sum + run.bytes, 0);
        for (const run of [...runs].reverse()) {
            if (bytes <= settings.maxBytes) {
                break;
            }
            if (!run.baseline && run.record.id !== newestRun) {
                await this.removeRun(run);
                bytes -= run.bytes;
            }
        }
        if (bytes > settings.maxBytes) {
            throw new Error(
                "Protected evaluation records exceed the storage budget; change retention or unpin a baseline.",
            );
        }
    }

    async save(input: EvaluationRecord): Promise<EvaluationRecord> {
        return this.locked(async () => {
            const settings = await this.settings();
            const runs = await this.runs();
            const related = runs.filter(
                (run) => run.record.taskId === input.taskId,
            );
            const previous = related.find((run) => run.baseline) ?? related[0];
            const record = evaluationRecordSchema.parse(
                sanitizeStored({
                    ...input,
                    comparison: compareRecords(input, previous?.record),
                }),
            );
            const bytes = Buffer.byteLength(
                JSON.stringify(record, null, 4) + "\n",
            );
            if (bytes > MAX_RECORD_BYTES) {
                throw new Error(
                    "Compact evaluation record exceeds 64 KB; it was not saved.",
                );
            }
            const protectedBytes = runs
                .filter((run) => run.baseline)
                .reduce((sum, run) => sum + run.bytes, 0);
            if (protectedBytes + bytes > settings.maxBytes) {
                throw new Error(
                    "New record cannot fit alongside protected baselines; nothing was deleted.",
                );
            }
            if (runs.some((run) => run.record.id === record.id)) {
                throw new Error(
                    "Evaluation run already exists; refusing overwrite.",
                );
            }
            await this.writeRecord(record);
            await this.prune(settings, record.id);
            return record;
        });
    }

    async setBaseline(taskId: string, runId: string | null): Promise<void> {
        taskIdSchema.parse(taskId);
        if (runId) {
            z.string().uuid().parse(runId);
        }
        await this.locked(async () => {
            if (!runId) {
                await unlink(
                    await this.safePath(`${taskId}/baseline.json`),
                ).catch((error: NodeJS.ErrnoException) => {
                    if (error.code !== "ENOENT") {
                        throw error;
                    }
                });
            } else {
                if (
                    !(await this.history(taskId)).some(
                        ({ record }) => record.id === runId,
                    )
                ) {
                    throw new Error("Baseline run not found for this task.");
                }
                await this.atomicJson(`${taskId}/baseline.json`, { runId });
            }
            await this.prune(await this.settings());
        });
    }

    async configure(input: RetentionSettings): Promise<void> {
        const settings = retentionSchema.parse(input);
        await this.locked(async () => {
            const protectedBytes = (await this.runs())
                .filter((run) => run.baseline)
                .reduce((sum, run) => sum + run.bytes, 0);
            if (protectedBytes > settings.maxBytes) {
                throw new Error(
                    "Selected budget is smaller than protected baselines; settings unchanged.",
                );
            }
            await this.atomicJson("settings.json", settings);
            await this.prune(settings);
        });
    }
}
