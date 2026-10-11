import path from "node:path";
import { workspaceDataDirectory } from "../utils/WorkspaceData";
import {
    mkdir,
    readFile,
    writeFile,
    rename,
    unlink,
    readdir,
    stat,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Workspace, contentHash } from "./Workspace";
import { acquireFileLease } from "../utils/FileLease";
import { EditConflictError } from "./EditConflictError";

const MAX_SNAPSHOT_FILE_BYTES = 2_000_000;
const MAX_SNAPSHOT_BYTES = 20_000_000;
const MAX_SNAPSHOT_FILES = 5000;

export interface FileChange {
    path: string;
    before: string | null;
    after: string | null;
    mode?: number;
}
export interface Checkpoint {
    version: 1;
    id: string;
    createdAt: string;
    // pending: an edit may need rollback; recording: a command is not yet captured.
    // complete: undo is available; undone / rolled_back: terminal states.
    status: "pending" | "recording" | "complete" | "undone" | "rolled_back";
    changes: FileChange[];
}
export { workspaceDataDirectory } from "../utils/WorkspaceData";

export async function currentText(target: string): Promise<string | null> {
    try {
        return await readFile(target, "utf8");
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }
        throw e;
    }
}
export async function atomicText(
    target: string,
    text: string | null,
    mode = 0o600,
) {
    if (text === null) {
        await unlink(target);
        return;
    }
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.rexa-${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, text, { flag: "wx", mode });
        await rename(temporary, target);
    } finally {
        await unlink(temporary).catch(() => {});
    }
}
function diffLines(content: string | null): string[] {
    if (content === null || content === "") {
        return [];
    }
    return content.replace(/\n$/, "").split("\n");
}

function diffBlock(
    lines: string[],
    prefix: string,
    content: string | null,
): string {
    let block = lines.map((line) => prefix + line).join("\n");
    if (lines.length > 0) {
        block += "\n";
    }
    if (content && !content.endsWith("\n")) {
        block += "\\ No newline at end of file\n";
    }
    return block;
}

function fileDiff(change: FileChange): string {
    const before = diffLines(change.before);
    const after = diffLines(change.after);
    const oldPath = change.before === null ? "/dev/null" : `a/${change.path}`;
    const newPath = change.after === null ? "/dev/null" : `b/${change.path}`;
    const oldRange = `${before.length ? 1 : 0},${before.length}`;
    const newRange = `${after.length ? 1 : 0},${after.length}`;
    return (
        `--- ${oldPath}\n+++ ${newPath}\n@@ -${oldRange} +${newRange} @@\n` +
        diffBlock(before, "-", change.before) +
        diffBlock(after, "+", change.after)
    );
}

/** Full-file replacement hunks, including explicit markers for missing final newlines. */
export function unifiedDiff(changes: FileChange[]): string {
    return changes
        .filter((change) => change.before !== change.after)
        .map(fileDiff)
        .join("\n");
}

/** Local private snapshots; never modify the user's Git history. */
export class CheckpointStore {
    readonly directory: string;
    private queue: Promise<unknown> = Promise.resolve();
    constructor(
        readonly ws: Workspace,
        directory = path.join(workspaceDataDirectory(ws.root), "checkpoints"),
        private writer = atomicText,
    ) {
        this.directory = directory;
    }

    private async save(checkpoint: Checkpoint) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await atomicText(
            path.join(this.directory, checkpoint.id + ".json"),
            JSON.stringify(checkpoint),
        );
    }

    async list(): Promise<Checkpoint[]> {
        let names: string[];
        try {
            names = await readdir(this.directory);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") {
                return [];
            }
            throw e;
        }
        const checkpoints = await Promise.all(
            names
                .filter((filename) => /^[0-9a-f-]+\.json$/.test(filename))
                .map(
                    async (filename) =>
                        JSON.parse(
                            await readFile(
                                path.join(this.directory, filename),
                                "utf8",
                            ),
                        ) as Checkpoint,
                ),
        );
        return checkpoints.sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt),
        );
    }

    private exclusive<T>(operation: () => Promise<T>): Promise<T> {
        // Serialize callers in this process, then acquire the cross-process lease.
        const next = this.queue.then(async () => {
            const release = await acquireFileLease(this.directory + ".lock");
            try {
                return await operation();
            } finally {
                await release();
            }
        });
        this.queue = next.catch(() => {});
        return next;
    }

    private async validateChanges(changes: FileChange[]): Promise<void> {
        const seen = new Set<string>();
        for (const change of changes) {
            const target = await this.ws.resolve(change.path);
            if (seen.has(target)) {
                throw new Error("Duplicate path in edit transaction");
            }
            seen.add(target);
            if ((await currentText(target)) !== change.before) {
                throw new EditConflictError(
                    "STALE_FILE",
                    change.path,
                    `Stale file: ${change.path}`,
                    true,
                );
            }
            change.mode =
                change.before === null ? 0o644 : (await stat(target)).mode;
        }
    }

    private async applyChange(change: FileChange): Promise<void> {
        const target = await this.ws.resolve(change.path);
        if ((await currentText(target)) !== change.before) {
            throw new EditConflictError(
                "STALE_FILE",
                change.path,
                `Concurrent file change: ${change.path}`,
                true,
            );
        }
        if (change.before === null && change.after !== null) {
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, change.after, {
                flag: "wx",
                mode: change.mode,
            });
        } else {
            await this.writer(target, change.after, change.mode);
        }
        this.ws.readHashes.set(target, contentHash(change.after ?? ""));
    }

    async commit(changes: FileChange[], signal?: AbortSignal) {
        return this.exclusive(async () => {
            signal?.throwIfAborted();
            await this.recoverInternal();
            await this.validateChanges(changes);
            signal?.throwIfAborted();
            const checkpoint: Checkpoint = {
                version: 1,
                id: randomUUID(),
                createdAt: new Date().toISOString(),
                status: "pending",
                changes,
            };
            await this.save(checkpoint);
            try {
                for (const change of changes) {
                    signal?.throwIfAborted();
                    await this.applyChange(change);
                }
                signal?.throwIfAborted();
                checkpoint.status = "complete";
                await this.save(checkpoint);
            } catch (error) {
                try {
                    await this.restore(checkpoint, true);
                    checkpoint.status = "rolled_back";
                    await this.save(checkpoint);
                } catch (rollbackError) {
                    throw this.recoveryFailure(checkpoint, rollbackError);
                }
                throw error;
            }
            return {
                success: true,
                checkpoint: checkpoint.id,
                changedFiles: changes.map((change) => change.path),
                diff: unifiedDiff(changes),
            };
        });
    }

    private recoveryFailure(
        checkpoint: Checkpoint,
        error: unknown,
    ): EditConflictError {
        const detail = error instanceof Error ? error.message : String(error);
        return new EditConflictError(
            "RECOVERY_CONFLICT",
            error instanceof EditConflictError
                ? error.path
                : (checkpoint.changes[0]?.path ?? "."),
            `Checkpoint ${checkpoint.id} could not be safely restored: ${detail}`,
            false,
            checkpoint.id,
        );
    }

    private async restore(checkpoint: Checkpoint, partial = false) {
        // Validate every path before restoring any, preserving subsequent user edits.
        for (const change of checkpoint.changes) {
            const current = await currentText(
                await this.ws.resolve(change.path),
            );
            if (
                current !== change.after &&
                !(partial && current === change.before)
            ) {
                throw new EditConflictError(
                    "RECOVERY_CONFLICT",
                    change.path,
                    `Restore conflict: ${change.path}; checkpoint ${checkpoint.id} retained for recovery.`,
                    false,
                    checkpoint.id,
                );
            }
        }
        for (const change of [...checkpoint.changes].reverse()) {
            const target = await this.ws.resolve(change.path);
            if ((await currentText(target)) !== change.before) {
                await atomicText(target, change.before, change.mode);
            }
            this.ws.readHashes.delete(target);
        }
    }

    private async recoverInternal() {
        for (const checkpoint of (await this.list())
            .filter((checkpoint) => checkpoint.status === "pending")
            .reverse()) {
            try {
                await this.restore(checkpoint, true);
                checkpoint.status = "rolled_back";
                await this.save(checkpoint);
            } catch (error) {
                throw this.recoveryFailure(checkpoint, error);
            }
        }
    }

    async recover() {
        return this.exclusive(() => this.recoverInternal());
    }

    private async capture() {
        const snapshot = new Map<string, string>();
        let bytes = 0;
        for (const name of await this.ws.files()) {
            const target = await this.ws.resolve(name);
            const file = Bun.file(target);
            if (file.size > MAX_SNAPSHOT_FILE_BYTES) {
                continue;
            }
            const data = await file.bytes();
            if (data.includes(0)) {
                continue;
            }
            bytes += data.length;
            if (
                bytes > MAX_SNAPSHOT_BYTES ||
                snapshot.size >= MAX_SNAPSHOT_FILES
            ) {
                throw new Error(
                    "Command checkpoint exceeds 20 MB or 5000 text files. Narrow the workspace before executing.",
                );
            }
            snapshot.set(name, Buffer.from(data).toString("utf8"));
        }
        return snapshot;
    }

    async beginCommand() {
        const snapshot = await this.capture();
        const checkpoint: Checkpoint = {
            version: 1,
            id: randomUUID(),
            createdAt: new Date().toISOString(),
            status: "recording",
            changes: [...snapshot].map(([name, text]) => ({
                path: name,
                before: text,
                after: text,
            })),
        };
        await this.save(checkpoint);
        return checkpoint;
    }

    async finishCommand(checkpoint: Checkpoint) {
        const after = await this.capture();
        const before = new Map(
            checkpoint.changes.map((change) => [change.path, change.before]),
        );
        checkpoint.changes = [...new Set([...before.keys(), ...after.keys()])]
            .map((name) => ({
                path: name,
                before: before.get(name) ?? null,
                after: after.get(name) ?? null,
            }))
            .filter((change) => change.before !== change.after);
        checkpoint.status = "complete";
        checkpoint.createdAt = new Date().toISOString();
        await this.save(checkpoint);
        return {
            checkpoint: checkpoint.id,
            changedFiles: checkpoint.changes.map((change) => change.path),
            diff: unifiedDiff(checkpoint.changes),
            checkpointScope:
                "Nonignored, nonprotected UTF-8 text files <=2 MB; binaries, credentials, ignored files, /workspace clones and external effects are not covered.",
        };
    }

    async undo(id?: string) {
        return this.exclusive(async () => {
            await this.recoverInternal();
            const checkpoint = (await this.list()).find(
                (change) =>
                    change.status === "complete" && (!id || change.id === id),
            );
            if (!checkpoint) {
                throw new Error("No matching checkpoint to undo.");
            }
            await this.restore(checkpoint);
            checkpoint.status = "undone";
            await this.save(checkpoint);
            return {
                success: true,
                checkpoint: checkpoint.id,
                restoredFiles: checkpoint.changes.map((change) => change.path),
            };
        });
    }

    async diff() {
        const records = await this.list();
        const checkpoint = records.find(
            (change) => change.status === "complete",
        );
        return (
            (records.some((change) => change.status === "recording")
                ? "Warning: an unfinished command snapshot exists; its outcome needs manual inspection.\n"
                : "") +
            (checkpoint
                ? unifiedDiff(checkpoint.changes)
                : "No completed checkpoint.")
        );
    }
}
