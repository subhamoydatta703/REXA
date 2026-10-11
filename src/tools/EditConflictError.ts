export type EditConflictCode =
    | "STALE_FILE"
    | "FRESH_READ_REQUIRED"
    | "STALE_RETRY_LIMIT"
    | "RECOVERY_CONFLICT";

/** A machine-readable editing failure, without exposing file contents or hashes. */
export class EditConflictError extends Error {
    constructor(
        readonly code: EditConflictCode,
        readonly path: string,
        message: string,
        readonly retrySafe = false,
        readonly checkpoint?: string,
    ) {
        super(message);
        this.name = "EditConflictError";
    }

    toResult() {
        const nextAction = this.retrySafe
            ? "Use read_file to inspect the latest contents and relevant surrounding code. Reconsider the edit against the original user request, preserve unrelated user changes, and submit a newly prepared edit. Never replay the old edit blindly or bypass the check with a command. Run relevant checks after a successful edit."
            : "Stop editing this path and explain the conflict. Do not force an overwrite. Inspect any retained checkpoint before further changes.";
        return {
            success: false,
            status: "conflict",
            code: this.code,
            path: this.path,
            error: this.message,
            retrySafe: this.retrySafe,
            checkpoint: this.checkpoint,
            nextAction,
        };
    }
}
