/** UI-neutral events emitted while an agent run is in progress. */
export interface RunCallbacks {
    onStatus?: (status: string) => void;
    onToken?: (token: string) => void;
}
