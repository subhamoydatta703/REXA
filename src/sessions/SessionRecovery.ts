import type { FunctionCall } from "@google/genai";
import type { Message } from "../agent/Message";

function interruptedResponse(call: FunctionCall): Message {
    return {
        role: "tool",
        parts: [
            {
                functionResponse: {
                    name: call.name,
                    ...(call.id ? { id: call.id } : {}),
                    response: {
                        result: {
                            status: "interrupted",
                            error: "Execution outcome unknown. Inspect current files/process state before acting; do not automatically replay this call.",
                        },
                    },
                },
            },
        ],
    };
}

function completedToolNames(responses: Message[]): Array<string | undefined> {
    const names: Array<string | undefined> = [];
    for (const response of responses) {
        for (const part of response.parts ?? []) {
            if (part.functionResponse) {
                names.push(part.functionResponse.name);
            }
        }
    }
    return names;
}

/** Close missing tool results with explicit uncertainty; never execute calls on resume. */
export function recoverInterruptedMessages(messages: Message[]): Message[] {
    const recovered: Message[] = [];
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index]!;
        recovered.push(message);
        const calls =
            message.parts?.flatMap((part) =>
                part.functionCall ? [part.functionCall] : [],
            ) ?? [];
        if (calls.length === 0) {
            continue;
        }

        const responses: Message[] = [];
        while (messages[index + 1]?.role === "tool") {
            index++;
            responses.push(messages[index]!);
        }
        recovered.push(...responses);

        // Consume one matching response per call, including repeated calls to the same tool.
        const completed = completedToolNames(responses);
        for (const call of calls) {
            const responseIndex = completed.indexOf(call.name);
            if (responseIndex >= 0) {
                completed.splice(responseIndex, 1);
            } else {
                recovered.push(interruptedResponse(call));
            }
        }
    }
    return recovered;
}
