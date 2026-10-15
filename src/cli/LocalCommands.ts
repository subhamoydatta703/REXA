import { select, confirm } from "@inquirer/prompts";
import type { Agent } from "../agent/Agent";
import type { AgentMode } from "../agent/AgentMode";
import type { CheckpointStore } from "../tools/CheckpointStore";
import { permissions } from "../tools/PermissionService";
import { sandboxManager } from "../tools/ExecutionManager";
import type { EvaluationCommands } from "../evaluation/EvaluationCommands";

export interface LocalCommandResult {
    text: string;
    mode?: AgentMode;
}
export class LocalCommands {
    constructor(
        private agent: Pick<
            Agent,
            "listSessions" | "resumeSession" | "newSession" | "compactSession"
        >,
        private checkpoints: CheckpointStore,
        private choose = async (sessions: { id: string; label: string }[]) =>
            select({
                message: "Choose a saved conversation",
                choices: sessions.map((s) => ({ name: s.label, value: s.id })),
            }),
        private approveUndo = async () =>
            confirm({
                message:
                    "Restore the latest checkpoint? Conflicting user edits will be preserved.",
                default: false,
            }),
        private evaluations?: EvaluationCommands,
    ) {}

    async handle(input: string): Promise<LocalCommandResult | null> {
        if (!input.trim().startsWith("/")) {
            return null;
        }
        const [command, arg, ...extra] = input.trim().split(/\s+/);
        if (extra.length) {
            throw new Error("Too many command arguments.");
        }
        const evaluationResult = await this.evaluations?.handle(
            command?.toLowerCase() ?? "",
            arg,
        );
        if (evaluationResult !== undefined && evaluationResult !== null) {
            return { text: evaluationResult };
        }
        switch (command?.toLowerCase()) {
            case "/continue": {
                const session = await this.agent.resumeSession();
                return {
                    text: `Resumed ${session.id}. Workspace state will be checked before further changes.`,
                    mode: session.mode,
                };
            }
            case "/resume":
            case "/resume-chat": {
                const sessions = await this.agent.listSessions();
                if (!sessions.length) {
                    return { text: "No saved conversations for this project." };
                }
                const id =
                    arg ??
                    (await this.choose(
                        sessions.map((s) => ({
                            id: s.id,
                            label: `${s.updatedAt} · ${s.status} · ${s.messages.find((m) => m.role === "user")?.content?.slice(0, 70) ?? s.id}`,
                        })),
                    ));
                const session = await this.agent.resumeSession(id);
                return { text: `Resumed ${session.id}.`, mode: session.mode };
            }
            case "/new":
                permissions.clearGrants();
                await this.agent.newSession();
                return { text: "Started a new conversation.", mode: "act" };
            case "/compact":
                return { text: await this.agent.compactSession() };
            case "/diff":
                return { text: await this.checkpoints.diff() };
            case "/permissions":
                return {
                    text: JSON.stringify(permissions.describe(), null, 2),
                };
            case "/ps":
                return {
                    text: JSON.stringify(
                        sandboxManager.processes.list(),
                        null,
                        2,
                    ),
                };
            case "/stop": {
                if (arg) {
                    const result = await sandboxManager.processes.stop(arg);
                    return { text: JSON.stringify(result) };
                }
                await sandboxManager.processes.stopAll();
                return { text: "Stopped owned background processes." };
            }
            case "/undo": {
                if (!(await this.approveUndo())) {
                    return { text: "Restore cancelled." };
                }
                const result = await this.checkpoints.undo(arg);
                return { text: JSON.stringify(result) };
            }
            case "/help":
                return {
                    text: "/continue · /resume-chat [id] · /new · /compact · /diff · /undo [checkpoint-id] · /permissions · /ps · /stop [process-id] · /evaluations [task-id] · /evaluation-task [name|auto] · /evaluation-baseline <run-id|clear> · /evaluation-retention [5-10:MiB] · /help",
                };
            default:
                return {
                    text: `Unknown local command: ${command}. Use /help.`,
                };
        }
    }
}
