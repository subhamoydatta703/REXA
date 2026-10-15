import type { VerificationEvidence } from "../verification/VerificationResults";

export type RunEvidenceEvent =
    | { kind: "guardrail"; component: string; isSafe: boolean }
    | { kind: "route"; route: string }
    | {
          kind: "tool";
          source: "coding" | "research" | "debugging";
          name: string;
          result: unknown;
      }
    | { kind: "verification"; evidence: VerificationEvidence }
    | { kind: "session"; id: string };

/** Evidence observers must never change a task's result if recording fails. */
export function emitEvidence(
    callbacks: RunCallbacks | undefined,
    event: RunEvidenceEvent,
): void {
    try {
        callbacks?.onEvidence?.(event);
    } catch {
        /* Optional observation is best effort. */
    }
}

/** UI-neutral events emitted while an agent run is in progress. */
export interface RunCallbacks {
    signal?: AbortSignal;
    onCommandOutput?: (text: string, stream: "stdout" | "stderr") => void;
    onStatus?: (status: string) => void;
    onToken?: (token: string) => void;
    onEvidence?: (event: RunEvidenceEvent) => void;
}
