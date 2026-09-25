import { input } from "@inquirer/prompts";
import chalk from "chalk";
import figlet from "figlet";
import gradient from "gradient-string";
import ora, { type Ora } from "ora";
import os from "node:os";
import path from "node:path";
import { setActiveSpinner } from "./TerminalState";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import * as readline from "node:readline";
import type { AgentMode, PromptInput } from "../agent/AgentMode";

export class AgentUI {
    
    private static theme = gradient(["#f9f908", "#A1A1AA", "#52525B"]);
    
    private static accentTheme = gradient(["#ffff09ff","#ffff09ff"]);

    private static readonly ansiPattern = /\x1b\[[0-9;]*m/g;
    // Number of terminal rows between the banner's mode row and the prompt.
    // It changes only when the workspace warning is displayed.
    private static headerToPromptRows = 6;

    private static visibleLength(value: string): number {
        return value.replace(this.ansiPattern, "").length;
    }

    private static truncateToWidth(value: string, width: number): string {
        if (width <= 0) return "";
        if (value.length <= width) return value;
        return width === 1 ? "…" : `…${value.slice(-(width - 1))}`;
    }

    private static displayHeader(mode: AgentMode = "act"): void {
        const label = "REXA CLI";
        const version = "v1.1.0";
        const tag = "Autonomous Agent Harness";
        const toggle = "[PLAN] ↹ ACT  · Tab switches";
        const content = `${label}  ${version}  |  ${tag}  |  ${toggle}`;
        const width = content.length + 4;

        const modeLabel = (target: AgentMode) => target === mode
            ? chalk.cyan.bold(`[${target.toUpperCase()}]`)
            : target.toUpperCase();
        const headerLine =
            chalk.gray("|  ") +
            chalk.bold.white(label) +
            chalk.gray(`  ${version}  |  `) +
            chalk.bold.yellow(tag) +
            chalk.gray("  |  ") +
            modeLabel("plan") +
            chalk.gray(" ↹ ") +
            modeLabel("act") +
            chalk.gray("  · Tab switches  |");

        console.log(chalk.gray(`+${"-".repeat(width)}+`));
        console.log(headerLine);
        console.log(chalk.gray(`+${"-".repeat(width)}+`));
    }

    private static updateHeaderMode(mode: AgentMode): void {
        const label = "REXA CLI";
        const version = "v1.1.0";
        const tag = "Autonomous Agent Harness";
        const modeLabel = (target: AgentMode) => target === mode
            ? chalk.cyan.bold(`[${target.toUpperCase()}]`)
            : target.toUpperCase();
        const headerLine =
            chalk.gray("|  ") +
            chalk.bold.white(label) +
            chalk.gray(`  ${version}  |  `) +
            chalk.bold.yellow(tag) +
            chalk.gray("  |  ") +
            modeLabel("plan") +
            chalk.gray(" ↹ ") +
            modeLabel("act") +
            chalk.gray("  · Tab switches  |");

        // Do not rely on ANSI cursor-save slots: Windows terminals may share
        // them. Address the known header row relative to the input instead.
        process.stdout.write(
            `\x1b[${this.headerToPromptRows}A\r\x1b[2K${headerLine}\x1b[${this.headerToPromptRows}B\r`,
        );
    }

    private static getErrorMessage(error: unknown): string {
        const details = error && typeof error === "object" ? error as Record<string, unknown> : {};
        const nested = details.error && typeof details.error === "object"
            ? details.error as Record<string, unknown>
            : {};
        const message = [details.message, nested.message]
            .filter((value): value is string => typeof value === "string")
            .join(" ")
            .toLowerCase();
        const status = details.status ?? details.statusCode ?? details.code ?? nested.status ?? nested.code;

        if (status === 401 || status === 403 || /api[_ ]key|unauthenticated|permission denied/.test(message)) {
            return "Looks like your Gemini API key isn't working or expired. Run 'rexa config set-key' to update it, bro.";
        }
        if (status === 429 || /rate limit|resource exhausted|quota exceeded/.test(message)) {
            return "Hold up, Gemini hit a rate limit. Give it a moment, then try again, bro.";
        }
        if (status === 503 || /high demand|overloaded|service unavailable|temporarily unavailable/.test(message)) {
            return "Gemini is under heavy load right now. Give it a sec and run that again, bro.";
        }
        if (status === 504 || /timed out|deadline exceeded/.test(message)) {
            return "Gemini took too long to answer. Give it another shot, bro.";
        }
        if (/fetch failed|network error|econnrefused|enotfound|ehostunreach|connection (?:refused|reset)/.test(message)) {
            return "Can't connect to Gemini right now. Check your internet connection or VPN and let's try again.";
        }
        if (/model.*not found|unsupported model|invalid model/.test(message)) {
            return "Gemini couldn't find that model. Double-check the model name in your config, bro.";
        }
        if (/context|token limit|input token count/.test(message)) {
            return "This conversation got too long for the model. Start a fresh session or trim the history, bro.";
        }
        if (/potential secret detected|input too long|guardrail returned an invalid classification/.test(message)) {
            return error instanceof Error ? error.message : "That request was blocked by a safety check.";
        }

        return "Ran into a bump while processing that. Lemme know if you want me to try again.";
    }

    // Renders clear screen, monochrome ASCII logo, and pixel-perfect ANSI-safe box frame.
    static displayBanner(mode: AgentMode = "act"): void {
        console.clear();
        const asciiLogo = figlet.textSync("REXA", { font: "Standard" });

        // Print monochrome ASCII logo
        console.log(this.theme.multiline(asciiLogo));
        this.displayHeader(mode);

        console.log("");
        console.log(chalk.bold.yellow("  ❯ ") + chalk.gray("Yo, it's me... ") + chalk.bold.white("REXA") + chalk.gray(". What's the plan?"));
        console.log("");
    }

    /** Make the sandbox's host-file boundary visible before the agent starts. */
    static displayWorkspace(workspace: string): void {
        const resolved = path.resolve(workspace);
        const home = path.resolve(os.homedir());
        const isBroadWorkspace = resolved === home || resolved === path.parse(resolved).root;
        this.headerToPromptRows = isBroadWorkspace ? 7 : 6;

        // console.log(chalk.gray("  Workspace mounted read/write in sandbox: ") + chalk.white(resolved));
        if (isBroadWorkspace) {
            console.log(chalk.yellow("  Warning: start REXA inside a project folder, not your home or drive root."));
        }
        console.log("");
    }

    //   Prompt for user input
    
    static async getPromptInput(initialMode: AgentMode): Promise<PromptInput> {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            const value = await input({
                message: chalk.cyan.bold(" ❯"),
                theme: { prefix: "" },
            });
            return { value, mode: initialMode };
        }

        return new Promise((resolve, reject) => {
            const stdin = process.stdin;
            const stdout = process.stdout;
            const wasRaw = stdin.isRaw;
            let mode = initialMode;
            let value = "";

            const render = () => {
                const prefix = ` ${chalk.cyan.bold("❯")} `;
                const availableWidth = Math.max(1, (stdout.columns || 100) - this.visibleLength(prefix));
                stdout.clearLine(0);
                stdout.cursorTo(0);
                // Keep the active mode visible without allowing long input to wrap.
                stdout.write(`${prefix}${this.truncateToWidth(value, availableWidth)}`);
            };

            const cleanup = () => {
                stdin.off("keypress", onKeypress);
                if (!wasRaw) stdin.setRawMode(false);
            };

            const onKeypress = (character: string, key: readline.Key) => {
                if (key.ctrl && key.name === "c") {
                    cleanup();
                    reject(new Error("Prompt cancelled."));
                    return;
                }
                if (key.name === "tab") {
                    mode = mode === "plan" ? "act" : "plan";
                    this.updateHeaderMode(mode);
                    render();
                    return;
                }
                if (key.name === "return" || key.name === "enter") {
                    cleanup();
                    stdout.write("\n");
                    resolve({ value, mode });
                    return;
                }
                if (key.name === "backspace") {
                    value = value.slice(0, -1);
                    render();
                    return;
                }
                if (!key.ctrl && !key.meta && character) {
                    value += character;
                    render();
                }
            };

            readline.emitKeypressEvents(stdin);
            stdin.setRawMode(true);
            stdin.resume();
            stdin.on("keypress", onKeypress);
            render();
        });
    }

    // Creates and starts a processing spinner
    
    static startSpinner(): Ora {
        const spinner = ora({
            text: chalk.gray("thinking..."),
            spinner: "dots",
            prefixText: " ",
        }).start();
        setActiveSpinner(spinner);
        return spinner;
    }

    
    //   Renders the agent's response 
    
    static renderResponse(text: string): void {
        const cleaned = text?.trim();
        if (!cleaned) return;

        // Set up marked to render markdown for the terminal (marked-terminal v7+ API)
        marked.use(markedTerminal());

        const gutter = "  ▎ ";
        const displayWidth = Math.max(1, (process.stdout.columns || 100) - gutter.length);
        const wrapPlainLine = (line: string): string[] => {
            const chunks: string[] = [];
            let remaining = line;
            while (remaining.length > displayWidth) {
                let breakAt = remaining.lastIndexOf(" ", displayWidth);
                if (breakAt <= 0) breakAt = displayWidth;
                chunks.push(remaining.slice(0, breakAt));
                remaining = remaining.slice(breakAt).trimStart();
            }
            chunks.push(remaining);
            return chunks;
        };

        console.log("");

        const now = new Date();
        const time = chalk.gray(`${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`);
        console.log("  " + this.accentTheme("rexa") + chalk.gray(" · ") + time);
        console.log("");

        // Render markdown first, then wrap each output line
        const rendered = (marked(cleaned) as string).trimEnd();
        const lines = rendered.split("\n");
        for (const line of lines) {
            // marked-terminal embeds ANSI styling, which is not display width.
            // Wrap the visible text so every response line aligns with the gutter.
            const plainLine = line.replace(this.ansiPattern, "");
            for (const chunk of wrapPlainLine(plainLine)) {
                console.log(chalk.hex("#3B3B4F")(gutter) + chunk);
            }
        }

        console.log("");
    }

    // Renders exit / termination message.
    
    static renderExit(): void {
        console.log("");
        console.log(chalk.gray("  peace out."));
        console.log("");
    }

    
    static renderError(error: unknown): void {
        const message = this.getErrorMessage(error);
        console.log("");
        console.log("  " + this.accentTheme("rexa") + chalk.gray(" · ") + chalk.yellow(message));
        if (process.env.LOG_LEVEL === "debug" && error instanceof Error && error.stack) {
            console.log(chalk.gray(`\n${error.stack}`));
        }
        console.log("");
    }

}
