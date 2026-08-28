import chalk from "chalk";
import { SecretScanner } from "../guardrails/types/SecretScanner";

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

    private redactValue(value: unknown, key?: string): unknown {
        if (key && /key|token|secret|password|authorization|credential/i.test(key)) {
            return "[REDACTED]";
        }
        if (typeof value === "string") return SecretScanner.redact(value);
        if (Array.isArray(value)) return value.map((item) => this.redactValue(item));
        if (value && typeof value === "object") {
            return Object.fromEntries(Object.entries(value).map(([nestedKey, nestedValue]) => [
                nestedKey,
                this.redactValue(nestedValue, nestedKey),
            ]));
        }
        return value;
    }

    private formatMeta(meta?: Record<string, any>): string {
        if (!meta) return "";
        try {
            const safe = this.redactValue(meta);
            return chalk.gray(` ${JSON.stringify(safe)}`);
        } catch {
            return chalk.gray(" [unserializable metadata]");
        }
    }

    /** General info — subtle, doesn't clutter the terminal */
    info(message: string, meta?: Record<string, any>): void {
        message = SecretScanner.redact(message);
        const metaStr = this.formatMeta(meta);
        console.log(chalk.gray("  ·") + chalk.gray(` ${message}`) + metaStr);
    }

    /** Tool execution status — showing exact command/param details with clean terminal line clearing */
    tool(toolName: string, status: "running" | "done" | "error", detail?: string): void {
        detail = detail ? SecretScanner.redact(detail) : detail;
        const name = chalk.cyan(toolName);
        const detailStr = detail ? chalk.gray(` ${detail}`) : "";

        // Clear active spinner line before printing tool status to avoid visual collision
        if (process.stdout.isTTY) {
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
        }

        switch (status) {
            case "running":
                console.log(chalk.gray("  ▸ ") + name + chalk.gray(" running...") + detailStr);
                break;
            case "done":
                console.log(chalk.gray("  ✓ ") + name + chalk.green(" done") + detailStr);
                break;
            case "error":
                console.log(chalk.gray("  ✗ ") + name + chalk.red(" failed") + detailStr);
                break;
        }
    }

    /** Warning — yellow, visible but not alarming */
    warn(message: string, detail?: string): void {
        message = SecretScanner.redact(message);
        detail = detail ? SecretScanner.redact(detail) : detail;
        const extra = detail ? chalk.gray(` ${detail}`) : "";
        console.log(chalk.yellow("  ⚠ ") + chalk.yellow(message) + extra);
    }

    /** Error — red, clearly stands out */
    error(message: string, detail?: string): void {
        message = SecretScanner.redact(message);
        detail = detail ? SecretScanner.redact(detail) : detail;
        const extra = detail ? chalk.gray(` ${detail}`) : "";
        console.log(chalk.red("  ✗ ") + chalk.red(message) + extra);
    }

    /** Debug — only shows when LOG_LEVEL=debug */
    debug(message: string, meta?: Record<string, any>): void {
        if (!this.debugEnabled) return;
        message = SecretScanner.redact(message);
        const metaStr = this.formatMeta(meta);
        console.log(chalk.gray("  [dbg]") + chalk.gray(` ${message}`) + metaStr);
    }
}

export const logger = new AgentLogger();
