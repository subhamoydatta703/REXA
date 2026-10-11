/** UI-neutral events emitted while an agent run is in progress. */
export interface RunCallbacks {
    signal?: AbortSignal;
    onCommandOutput?: (text: string, stream: "stdout" | "stderr") => void;
    onStatus?: (status: string) => void;
    onToken?: (token: string) => void;
}
