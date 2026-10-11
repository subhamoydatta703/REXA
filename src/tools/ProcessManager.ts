import { randomUUID } from "node:crypto";
import { sanitizeStored } from "../utils/SanitizeStored";

const MAX_PROCESS_HANDLES = 100;
const MAX_OUTPUT_LINE_CHARACTERS = 8192;

type OutputStream = "stdout" | "stderr";
type StopReason = "timeout" | "cancelled";
export type ProcessStatus = "running" | "executed" | "failed" | StopReason;

export interface ProcessResult {
    id: string;
    status: ProcessStatus;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
    success: boolean;
}

interface ManagedProcess {
    id: string;
    process: ReturnType<typeof Bun.spawn>;
    stdout: string;
    stderr: string;
    truncated: boolean;
    status: ProcessStatus;
    exitCode: number | null;
    completion: Promise<void>;
    stop: (reason: StopReason) => Promise<void>;
}
export interface ProcessOptions {
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
    onOutput?: (text: string, stream: "stdout" | "stderr") => void;
    terminate?: () => Promise<void>;
}

export class ProcessManager {
    private handles = new Map<string, ManagedProcess>();
    constructor(private maxOutput = 64_000) {}

    async start(command: string[], options: ProcessOptions): Promise<string> {
        options.signal?.throwIfAborted();
        this.pruneCompletedHandles();
        const childProcess = Bun.spawn(command, {
            cwd: options.cwd,
            env: options.env,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });
        const handle: ManagedProcess = {
            id: randomUUID(),
            process: childProcess,
            stdout: "",
            stderr: "",
            truncated: false,
            status: "running",
            exitCode: null,
            completion: Promise.resolve(),
            stop: async () => {},
        };
        this.handles.set(handle.id, handle);
        handle.stop = this.createStopHandler(handle, options.terminate);
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (options.timeoutMs) {
            timer = setTimeout(() => {
                void handle.stop("timeout").catch(() => {});
            }, options.timeoutMs);
        }
        const abort = () => {
            void handle.stop("cancelled").catch(() => {});
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        handle.completion = this.monitorProcess(handle, options, timer, abort);
        if (options.signal?.aborted) {
            abort();
        }
        return handle.id;
    }

    private async monitorProcess(
        handle: ManagedProcess,
        options: ProcessOptions,
        timer: ReturnType<typeof setTimeout> | undefined,
        abort: () => void,
    ): Promise<void> {
        const childProcess = handle.process;
        try {
            const [, , code] = await Promise.all([
                this.consumeOutput(
                    childProcess.stdout as ReadableStream<Uint8Array>,
                    "stdout",
                    handle,
                    options.onOutput,
                ),
                this.consumeOutput(
                    childProcess.stderr as ReadableStream<Uint8Array>,
                    "stderr",
                    handle,
                    options.onOutput,
                ),
                childProcess.exited,
            ]);
            handle.exitCode = code;
            if (handle.status === "running") {
                handle.status = code === 0 ? "executed" : "failed";
            }
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
            options.signal?.removeEventListener("abort", abort);
        }
    }

    private createStopHandler(
        handle: ManagedProcess,
        terminateRemote: ProcessOptions["terminate"],
    ): ManagedProcess["stop"] {
        let stopping: Promise<void> | undefined;
        const stop = async (reason: StopReason): Promise<void> => {
            if (handle.status !== "running") {
                return;
            }
            handle.status = reason;
            // Stop the container group before closing its host Docker client.
            try {
                if (terminateRemote) {
                    await terminateRemote();
                }
            } finally {
                try {
                    handle.process.kill();
                } catch {
                    // The process may have exited during remote termination.
                }
            }
        };
        return (reason) => {
            if (!stopping) {
                stopping = stop(reason);
            }
            return stopping;
        };
    }

    private pruneCompletedHandles(): void {
        // Prune completed handles; active workloads are never silently discarded.
        for (const [id, item] of this.handles) {
            if (
                this.handles.size >= MAX_PROCESS_HANDLES &&
                item.status !== "running"
            ) {
                this.handles.delete(id);
            }
        }
        if (this.handles.size >= MAX_PROCESS_HANDLES) {
            throw new Error("Too many active processes; stop one first.");
        }
    }

    private async consumeOutput(
        stream: ReadableStream<Uint8Array>,
        kind: OutputStream,
        handle: ManagedProcess,
        onOutput: ProcessOptions["onOutput"],
    ): Promise<void> {
        const decoder = new TextDecoder();
        let pending = "";
        let dropping = false;
        const emit = (text: string) => {
            const safe = sanitizeStored(text);
            const available = this.maxOutput - handle[kind].length;
            if (available > 0) {
                handle[kind] += safe.slice(0, available);
            }
            if (safe.length > available) {
                handle.truncated = true;
            }
            onOutput?.(safe, kind);
        };
        for await (const chunk of stream) {
            pending += decoder.decode(chunk, { stream: true });
            let newlineIndex: number;
            while ((newlineIndex = pending.indexOf("\n")) >= 0) {
                const line = pending.slice(0, newlineIndex + 1);
                pending = pending.slice(newlineIndex + 1);
                if (!dropping) {
                    emit(
                        line.length <= MAX_OUTPUT_LINE_CHARACTERS
                            ? line
                            : "[oversized output line omitted]\n",
                    );
                }
                dropping = false;
            }
            if (pending.length > MAX_OUTPUT_LINE_CHARACTERS) {
                if (!dropping) {
                    emit("[oversized output line omitted]\n");
                }
                pending = "";
                dropping = true;
                handle.truncated = true;
            }
        }
        if (pending && !dropping) {
            emit(pending + decoder.decode());
        }
    }

    private get(id: string) {
        const handle = this.handles.get(id);
        if (!handle) {
            throw new Error(
                "Unknown process handle (processes do not survive REXA restarts).",
            );
        }
        return handle;
    }

    poll(id: string): ProcessResult {
        const handle = this.get(id);
        return {
            id,
            status: handle.status,
            exitCode: handle.exitCode,
            stdout: handle.stdout,
            stderr: handle.stderr,
            truncated: handle.truncated,
            success: handle.status === "executed",
        };
    }

    async wait(id: string): Promise<ProcessResult> {
        await this.get(id).completion;
        return this.poll(id);
    }

    async write(id: string, input: string) {
        const handle = this.get(id);
        if (handle.status !== "running") {
            throw new Error("Process is not running.");
        }
        const stdin = handle.process.stdin;
        if (typeof stdin === "object" && stdin && "write" in stdin) {
            stdin.write(input);
            await stdin.flush();
        }
    }

    async stop(id: string) {
        const handle = this.get(id);
        await handle.stop("cancelled");
        await handle.completion;
        return this.poll(id);
    }

    async stopAll() {
        await Promise.all(
            [...this.handles.keys()]
                .filter((id) => this.get(id).status === "running")
                .map((id) => this.stop(id)),
        );
    }

    list(): ProcessResult[] {
        return [...this.handles.keys()].map((id) => this.poll(id));
    }
}
