import { toolResultMessage, type Message } from "../agent/Message";

/** Close missing tool results with explicit uncertainty; never execute calls on resume. */
export function recoverInterruptedMessages(messages: Message[]): Message[] {
    const recovered: Message[] = [];
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index]!;
        recovered.push(message);
        const calls = message.toolCalls ?? [];
        if (calls.length === 0) {
            continue;
        }

        const responses: Message[] = [];
        while (messages[index + 1]?.role === "tool") {
            index++;
            responses.push(messages[index]!);
        }
        recovered.push(...responses);

        const completed = new Set<string>();
        for (const result of responses.flatMap(
            (response) => response.toolResults ?? [],
        )) {
            const call = calls.find(
                (candidate) => candidate.id === result.callId,
            );
            if (
                !call ||
                call.name !== result.name ||
                completed.has(result.callId)
            ) {
                throw new Error(
                    "Saved tool result has an invalid or duplicate call identity.",
                );
            }
            completed.add(result.callId);
        }
        for (const call of calls) {
            if (!completed.has(call.id)) {
                recovered.push(
                    toolResultMessage(call, {
                        result: {
                            status: "interrupted",
                            error: "Execution outcome unknown. Inspect current files/process state before acting; do not automatically replay this call.",
                        },
                    }),
                );
            }
        }
    }
    return recovered;
}
