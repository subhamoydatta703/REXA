import { EvaluationTracker } from "./EvaluationTracker";

/** Local history controls; never sent to the model or counted as a task. */
export class EvaluationCommands {
    constructor(private tracker: EvaluationTracker) {}

    async handle(command: string, argument?: string): Promise<string | null> {
        if (command === "/evaluation-task") {
            if (!argument) {
                return `Current evaluation task: ${this.tracker.currentTask() ?? "automatic prompt grouping"}. Use /evaluation-task <name> or /evaluation-task auto.`;
            }
            this.tracker.selectTask(argument === "auto" ? undefined : argument);
            return argument === "auto"
                ? "Evaluation task grouping follows the exact prompt again."
                : `Subsequent tasks will be recorded under ${argument}. Comparisons still require matching context.`;
        }
        if (command === "/evaluations") {
            const taskId = argument ?? this.tracker.currentTask();
            if (!taskId) {
                return "No task selected yet. Run a task or use /evaluation-task <name>.";
            }
            const history = await this.tracker.store.history(taskId);
            if (!history.length) {
                return `No saved evaluations for ${taskId}.`;
            }
            return JSON.stringify(
                history.map(({ record, baseline }) => ({
                    id: record.id,
                    date: record.createdAt,
                    baseline,
                    outcome: record.outcome,
                    durationMs: record.durationMs,
                    verification: record.verification,
                    activity: record.activity,
                    rexa: record.rexa,
                    comparison: record.comparison,
                })),
                null,
                2,
            );
        }
        if (command === "/evaluation-baseline") {
            const taskId = this.tracker.currentTask();
            if (!taskId || !argument) {
                return "Select a task, then use /evaluation-baseline <run-id> or /evaluation-baseline clear.";
            }
            await this.tracker.store.setBaseline(
                taskId,
                argument === "clear" ? null : argument,
            );
            return argument === "clear"
                ? "Baseline protection cleared for this task."
                : "Selected baseline protected for this task.";
        }
        if (command === "/evaluation-retention") {
            if (argument) {
                const [recentRuns, maxMiB, ...extra] = argument.split(":");
                if (extra.length || !recentRuns || !maxMiB) {
                    throw new Error(
                        "Use /evaluation-retention <5-10>:<budget-in-MiB>.",
                    );
                }
                await this.tracker.store.configure({
                    recentRuns: Number(recentRuns),
                    maxBytes: Number(maxMiB) * 1024 * 1024,
                });
            }
            return JSON.stringify(await this.tracker.store.settings(), null, 2);
        }
        return null;
    }
}
