/** Stop waiting promptly, and remove the listener when either operation finishes. */
export async function waitWithCancellation<T>(
    operation: Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    if (!signal) {
        return operation;
    }
    let cancel: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
        cancel = () =>
            reject(
                signal.reason ?? new DOMException("Cancelled", "AbortError"),
            );
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) {
            cancel();
        }
    });
    try {
        const result = await Promise.race([operation, cancelled]);
        // Cancellation wins even if both promises settle in the same turn.
        signal.throwIfAborted();
        return result;
    } finally {
        signal.removeEventListener("abort", cancel);
    }
}
