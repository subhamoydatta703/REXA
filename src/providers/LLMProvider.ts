import { type Message } from "../agent/Message";
import { type Tool } from "../tools/ToolRegistry";
import type { LLMResponse } from "../providers/LLMResponse";
import type { RunCallbacks } from "../agent/RunCallbacks";

export interface LLMProvider {
    generate(
        messages: Message[],
        tools?: Tool[],
        systemInstruction?: string,
        memorySearchInstruction?: string,
        callbacks?: Pick<RunCallbacks, "onToken">,
    ): Promise<LLMResponse>;
}
