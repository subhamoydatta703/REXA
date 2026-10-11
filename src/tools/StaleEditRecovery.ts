import { EditConflictError } from "./EditConflictError";
import type { Workspace } from "./Workspace";

const MAX_RECOVERY_ATTEMPTS = 2;

interface EditTarget {
    path: string;
    expected_hash?: string;
}

interface FileRecovery {
    path: string;
    attempts: number;
    readRevision: number;
    pending: boolean;
}

interface RecoveryAttempt {
    state: FileRecovery;
    hash: string;
    target: string;
    revision: number;
}

function retryLimitError(filePath: string): EditConflictError {
    return new EditConflictError(
        "STALE_RETRY_LIMIT",
        filePath,
        `Recovery stopped for ${filePath} after two attempts. Explain the conflict before further editing.`,
    );
}

/** Lives for one Agent.run(). Reads never reset the per-file attempt budget. */
export class StaleEditRecovery {
    private files = new Map<string, FileRecovery>();
    private unsafeFailure?: EditConflictError;
    private editIdentities = new Map<string, string>();

    async recordFailure(
        error: EditConflictError,
        workspace: Workspace,
    ): Promise<EditConflictError> {
        if (!error.retrySafe) {
            if (error.code === "RECOVERY_CONFLICT") {
                this.unsafeFailure = error;
            }
            return error;
        }
        if (error.code !== "STALE_FILE") {
            return error;
        }
        const identity = await workspace.fileIdentity(error.path);
        const previous = this.files.get(identity);
        const observation = await workspace.lastRead(error.path);
        this.files.set(identity, {
            path: error.path,
            attempts: previous?.attempts ?? 0,
            readRevision: observation?.revision ?? 0,
            pending: true,
        });
        if ((previous?.attempts ?? 0) >= MAX_RECOVERY_ATTEMPTS) {
            return retryLimitError(error.path);
        }
        return error;
    }

    async beforeEdit(
        targets: EditTarget[],
        workspace: Workspace,
    ): Promise<void> {
        if (this.unsafeFailure) {
            throw this.unsafeFailure;
        }
        const retries = new Map<string, RecoveryAttempt>();
        const identities = new Map<string, string>();
        for (const target of targets) {
            const identity = await workspace.fileIdentity(target.path);
            identities.set(target.path, identity);
            const state = this.files.get(identity);
            if (!state?.pending) {
                continue;
            }
            if (state.attempts >= MAX_RECOVERY_ATTEMPTS) {
                throw retryLimitError(state.path);
            }
            const observation = await workspace.lastRead(target.path);
            if (!observation || observation.revision <= state.readRevision) {
                throw new EditConflictError(
                    "FRESH_READ_REQUIRED",
                    state.path,
                    `Read ${state.path} again before retrying this edit. Supplying expected_hash alone is insufficient.`,
                    true,
                );
            }
            if (
                target.expected_hash &&
                target.expected_hash !== observation.hash
            ) {
                throw new EditConflictError(
                    "FRESH_READ_REQUIRED",
                    state.path,
                    `The supplied expected_hash does not match the latest read of ${state.path}. Inspect the file again and use the observed hash.`,
                    true,
                );
            }
            retries.set(identity, {
                state,
                hash: observation.hash,
                target: await workspace.resolve(target.path),
                revision: observation.revision,
            });
        }
        this.editIdentities = identities;
        // Check the whole batch before consuming any recovery attempts.
        for (const retry of retries.values()) {
            retry.state.attempts++;
            retry.state.readRevision = retry.revision;
            // A read through a different spelling/symlink still observes the same file.
            workspace.readHashes.set(retry.target, retry.hash);
        }
    }

    async recordSuccess(
        targets: EditTarget[],
        workspace: Workspace,
    ): Promise<void> {
        for (const target of targets) {
            // The file may have been deleted, so use its identity from before the edit.
            const identity =
                this.editIdentities.get(target.path) ??
                (await workspace.fileIdentity(target.path));
            const state = this.files.get(identity);
            if (state) {
                state.pending = false;
            }
        }
    }

    unresolvedNotice(): string {
        if (this.unsafeFailure) {
            return `Editing stopped: ${this.unsafeFailure.message}`;
        }
        const pending = [...this.files.values()].filter(
            (state) => state.pending,
        );
        if (pending.length === 0) {
            return "";
        }
        return `Unresolved edit conflicts: ${pending.map((state) => state.path).join(", ")}. These edits were not successfully recovered; inspect the latest files before continuing.`;
    }
}
