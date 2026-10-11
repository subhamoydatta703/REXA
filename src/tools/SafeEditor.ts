import { z } from "zod";
import type { Tool, ToolExecutionContext } from "./ToolRegistry";
import { EditConflictError } from "./EditConflictError";
import {
    Workspace,
    workspace as activeWorkspace,
    contentHash,
} from "./Workspace";
import {
    CheckpointStore,
    currentText,
    type FileChange,
} from "./CheckpointStore";

const textChangeSchema = z.object({
    type: z.enum(["before", "after", "replace", "delete"]),
    target: z.string().min(1),
    content: z.string().optional(),
});

const operationSchema = z.object({
    operation: z.enum(["create", "write", "edit", "delete"]),
    path: z.string().min(1),
    content: z.string().optional(),
    expected_hash: z.string().optional(),
    changes: z.array(textChangeSchema).min(1).optional(),
});

const editRequestSchema = z.union([
    operationSchema,
    z.object({ operations: z.array(operationSchema).min(1).max(30) }),
]);

type EditOperation = z.infer<typeof operationSchema>;
type TextChange = z.infer<typeof textChangeSchema>;

function replacementText(change: TextChange): string {
    if (change.type === "delete") {
        return "";
    }
    if (change.content === undefined) {
        throw new Error("Edit content is required");
    }
    if (change.type === "before") {
        return change.content + change.target;
    }
    if (change.type === "after") {
        return change.target + change.content;
    }
    return change.content;
}

function applyTextChanges(
    source: string,
    changes: TextChange[],
    filePath: string,
): string {
    let updated = source;

    for (const change of changes) {
        const matchIndex = updated.indexOf(change.target);
        if (matchIndex < 0) {
            throw new Error(`TARGET_NOT_FOUND: ${filePath}`);
        }
        if (updated.indexOf(change.target, matchIndex + 1) >= 0) {
            throw new Error(`AMBIGUOUS_TARGET: ${filePath}`);
        }

        updated =
            updated.slice(0, matchIndex) +
            replacementText(change) +
            updated.slice(matchIndex + change.target.length);
    }

    return updated;
}

export class SafeEditor {
    readonly checkpoints: CheckpointStore;

    constructor(
        readonly ws: Workspace = activeWorkspace,
        checkpoints?: CheckpointStore,
    ) {
        this.checkpoints = checkpoints ?? new CheckpointStore(ws);
    }

    private verifyExistingFile(
        operation: EditOperation,
        target: string,
        content: string | null,
    ) {
        if (content === null) {
            throw new Error(`File does not exist: ${operation.path}`);
        }

        const expectedHash =
            operation.expected_hash ?? this.ws.readHashes.get(target);
        if (!expectedHash) {
            throw new Error(
                `Read ${operation.path} before editing or supply expected_hash.`,
            );
        }
        if (expectedHash !== contentHash(content)) {
            throw new EditConflictError(
                "STALE_FILE",
                operation.path,
                `Stale file: ${operation.path}; read it again.`,
                true,
            );
        }
    }

    private async prepareChange(operation: EditOperation): Promise<FileChange> {
        const target = await this.ws.resolve(operation.path);
        const file = Bun.file(target);

        if (await file.exists()) {
            if (file.size > 2_000_000) {
                throw new Error("Cannot edit files larger than 2 MB.");
            }
            if ((await file.bytes()).includes(0)) {
                throw new Error("Cannot edit binary files.");
            }
        }

        const before = await currentText(target);
        if (operation.operation === "create") {
            if (before !== null) {
                throw new Error(`File already exists: ${operation.path}`);
            }
        } else {
            this.verifyExistingFile(operation, target, before);
        }

        let after: string | null;
        switch (operation.operation) {
            case "delete":
                after = null;
                break;
            case "create":
            case "write":
                if (operation.content === undefined) {
                    throw new Error("content is required");
                }
                after = operation.content;
                break;
            case "edit":
                if (!operation.changes) {
                    throw new Error("changes are required");
                }
                after = applyTextChanges(
                    before!,
                    operation.changes,
                    operation.path,
                );
                break;
        }

        if (before === after) {
            throw new Error(`No-op edit: ${operation.path}`);
        }
        return { path: operation.path, before, after };
    }

    async execute(input: unknown, context: ToolExecutionContext = {}) {
        const request = editRequestSchema.parse(input);
        const operations =
            "operations" in request ? request.operations : [request];
        context.signal?.throwIfAborted();
        try {
            await context.editRecovery?.beforeEdit(operations, this.ws);
            const changes: FileChange[] = [];
            // Prepare every change before allowing any filesystem mutation.
            for (const operation of operations) {
                context.signal?.throwIfAborted();
                changes.push(await this.prepareChange(operation));
            }
            context.signal?.throwIfAborted();
            const result = await this.checkpoints.commit(
                changes,
                context.signal,
            );
            await context.editRecovery?.recordSuccess(operations, this.ws);
            return result;
        } catch (error) {
            if (error instanceof EditConflictError) {
                const failure = await context.editRecovery?.recordFailure(
                    error,
                    this.ws,
                );
                throw failure ?? error;
            }
            throw error;
        }
    }

    tool(): Tool {
        return {
            name: "code_tool",
            effect: "edit",
            description:
                "Safely create/write/edit/delete files, or validate a batch via operations. Read existing files first; expected_hash detects stale edits. Targets must be unique. Returns checkpoint and unified diff. All changes are validated before writing; failures roll back or report recovery conflicts. After STALE_FILE, read the latest contents and reconsider the edit against the user's task. Recovery permits two attempts per file per task and requires an observed hash; never blindly replay or force an overwrite.",
            parameters: editRequestSchema,
            execute: (input, context) => this.execute(input, context),
        };
    }
}

export const editor = new SafeEditor();
