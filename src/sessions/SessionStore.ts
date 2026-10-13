import {
    mkdir,
    appendFile,
    readFile,
    readdir,
    writeFile,
    truncate,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Message } from "../agent/Message";
import { messageSchema } from "../agent/Message";
import { legacyGeminiMessageSchema, migrateLegacyMessages } from "../providers/gemini/GeminiProtocol";
import type { AgentMode } from "../agent/AgentMode";
import { sanitizeStored } from "../utils/SanitizeStored";
import { workspaceDataDirectory } from "../utils/WorkspaceData";
import { acquireFileLease } from "../utils/FileLease";
import {
    verificationEvidenceSchema,
    type VerificationEvidence,
} from "../verification/VerificationResults";

const recordSchema = z.object({
    version: z.literal(1),
    id: z.string().uuid(),
    workspace: z.string(),
    updatedAt: z.string(),
    mode: z.enum(["plan", "act"]),
    status: z.enum(["idle", "running", "complete", "interrupted"]),
    messages: z.array(z.union([messageSchema, legacyGeminiMessageSchema])),
    verification: verificationEvidenceSchema.optional(),
});
export interface SessionRecord {
    version: 1;
    id: string;
    workspace: string;
    updatedAt: string;
    mode: AgentMode;
    status: "idle" | "running" | "complete" | "interrupted";
    messages: Message[];
    verification?: VerificationEvidence;
}

// Keep this export for callers using the original module path.
export { sanitizeStored } from "../utils/SanitizeStored";

/** Append-only transcript snapshots scoped to one workspace. */
export class SessionStore {
    readonly workspace: string;
    readonly directory: string;
    constructor(
        workspace = process.cwd(),
        directory = path.join(workspaceDataDirectory(workspace), "sessions"),
    ) {
        this.workspace = path.resolve(workspace);
        this.directory = directory;
    }

    private filename(id: string) {
        z.string().uuid().parse(id);
        return path.join(this.directory, id + ".jsonl");
    }

    async claim(id: string) {
        return acquireFileLease(this.filename(id) + ".lock");
    }

    async create(): Promise<SessionRecord> {
        const record: SessionRecord = {
            version: 1,
            id: randomUUID(),
            workspace: this.workspace,
            updatedAt: new Date().toISOString(),
            mode: "act",
            status: "idle",
            messages: [],
        };
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writeFile(
            this.filename(record.id),
            JSON.stringify(record) + "\n",
            { flag: "wx", mode: 0o600 },
        );
        return record;
    }

    private async discardIncompleteTail(filename: string): Promise<void> {
        const source = await readFile(filename, "utf8");
        if (!source.endsWith("\n")) {
            await truncate(
                filename,
                Buffer.byteLength(
                    source.slice(0, source.lastIndexOf("\n") + 1),
                ),
            );
        }
    }

    async save(record: SessionRecord) {
        if (record.workspace !== this.workspace) {
            throw new Error("Session belongs to another workspace.");
        }
        record.updatedAt = new Date().toISOString();
        // Validate before persistence and append a complete snapshot at each boundary.
        recordSchema.parse(record);
        await this.discardIncompleteTail(this.filename(record.id));
        await appendFile(
            this.filename(record.id),
            JSON.stringify(sanitizeStored(record)) + "\n",
            { mode: 0o600 },
        );
    }

    async load(id: string): Promise<SessionRecord> {
        const source = await readFile(this.filename(id), "utf8");
        const lines = source.split("\n");
        // Only an incomplete last line is recoverable; corruption in a committed record is an error.
        if (!source.endsWith("\n")) {
            lines.pop();
        }
        const committed = lines.filter(Boolean);
        if (!committed.length) {
            throw new Error("Session has no complete records.");
        }
        let latest = recordSchema.parse(JSON.parse(committed[0]!));
        for (const line of committed.slice(1)) {
            latest = recordSchema.parse(JSON.parse(line));
        }
        if (latest.workspace !== this.workspace || latest.id !== id) {
            throw new Error("Session workspace or ID mismatch.");
        }
        return { ...latest, messages: migrateLegacyMessages(latest.messages) };
    }

    async list() {
        let names: string[];
        try {
            names = await readdir(this.directory);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") {
                return [];
            }
            throw e;
        }
        const records = await Promise.all(
            names
                .filter((filename) => /^[0-9a-f-]+\.jsonl$/.test(filename))
                .map((filename) => this.load(filename.slice(0, -6))),
        );
        return records
            .filter((record) => record.messages.length > 0)
            .sort((left, right) =>
                right.updatedAt.localeCompare(left.updatedAt),
            );
    }
}

// Keep the original public import path available.
export { recoverInterruptedMessages } from "./SessionRecovery";
