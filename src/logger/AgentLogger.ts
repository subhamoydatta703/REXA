import chalk from "chalk";

/**
 * Styled CLI logger that replaces raw Winston JSON output with
 * clean, minimal terminal output matching REXA's dark monochrome theme.
 *
 * - info:  dim gray status lines
 * - tool:  highlighted tool execution status
 * - warn:  yellow warning lines
 * - error: red error lines
 * - debug: only visible when LOG_LEVEL=debug
 */
class AgentLogger {
    private debugEnabled: boolean;

    constructor() {
        this.debugEnabled = process.env.LOG_LEVEL === "debug";
    }

    /** General info — subtle, doesn't clutter the terminal */
    info(message: string, meta?: Record<string, any>): void {
        const metaStr = meta ? chalk.gray(` ${JSON.stringify(meta)}`) : "";
        console.log(chalk.gray("  ·") + chalk.gray(` ${message}`) + metaStr);
    }

    /** Tool execution status — slightly more visible */
    tool(toolName: string, status: "running" | "done" | "error", detail?: string): void {
        const name = chalk.cyan(toolName);
        switch (status) {
            case "running":
                console.log(chalk.gray("  ▸ ") + name + chalk.gray(" running..."));
                break;
            case "done":
                console.log(chalk.gray("  ✓ ") + name + chalk.green(" done") + (detail ? chalk.gray(` — ${detail}`) : ""));
                break;
            case "error":
                console.log(chalk.gray("  ✗ ") + name + chalk.red(" failed") + (detail ? chalk.gray(` — ${detail}`) : ""));
                break;
        }
    }

    /** Warning — yellow, visible but not alarming */
    warn(message: string, detail?: string): void {
        const extra = detail ? chalk.gray(` ${detail}`) : "";
        console.log(chalk.yellow("  ⚠ ") + chalk.yellow(message) + extra);
    }

    /** Error — red, clearly stands out */
    error(message: string, detail?: string): void {
        const extra = detail ? chalk.gray(` ${detail}`) : "";
        console.log(chalk.red("  ✗ ") + chalk.red(message) + extra);
    }

    /** Debug — only shows when LOG_LEVEL=debug */
    debug(message: string, meta?: Record<string, any>): void {
        if (!this.debugEnabled) return;
        const metaStr = meta ? chalk.gray(` ${JSON.stringify(meta)}`) : "";
        console.log(chalk.gray("  [dbg]") + chalk.gray(` ${message}`) + metaStr);
    }
}

export const logger = new AgentLogger();