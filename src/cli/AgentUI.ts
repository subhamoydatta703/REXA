import { input } from "@inquirer/prompts";
import chalk from "chalk";
import figlet from "figlet";
import gradient from "gradient-string";
import ora, { type Ora } from "ora";
import os from "node:os";
import path from "node:path";
import { clearActiveSpinner, setActiveSpinner } from "./TerminalState";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import * as readline from "node:readline";
import type { AgentMode, PromptInput } from "../agent/AgentMode";

export class AgentUI {
    
    private static theme = gradient(["#f9f908", "#A1A1AA", "#52525B"]);
    
    private static accentTheme = gradient(["#ffff09ff","#ffff09ff"]);
    private static readonly version = "v2.0.0";

    private static readonly ansiPattern = /\x1b\[[0-9;]*m/g;
    private static markdownConfigured = false;
    private static streamingBuffer = "";
    // Number of terminal rows between the banner's mode row and the prompt.
    // It changes only when the workspace warning is displayed.
    private static headerToPromptRows = 6;

    private static visibleLength(value: string): number {
        return Array.from(value.replace(this.ansiPattern, "")).length;
    }

    private static truncateToWidth(value: string, width: number): string {
        if (width <= 0) return "";
        if (value.length <= width) return value;
        return width === 1 ? "…" : `…${value.slice(-(width - 1))}`;
    }

    private static splitIntoDisplayLines(value: string, width: number): string[] {
        const safeWidth = Math.max(1, width);
        const lines: string[] = [];

        for (const sourceLine of value.split("\n")) {
            const characters = Array.from(sourceLine);
            if (characters.length === 0) {
                lines.push("");
                continue;
            }
            for (let index = 0; index < characters.length; index += safeWidth) {
                lines.push(characters.slice(index, index + safeWidth).join(""));
            }
        }

        return lines.length > 0 ? lines : [""];
    }

    private static configureMarkdown(): void {
        if (this.markdownConfigured) return;
        marked.use(markedTerminal({ showSectionPrefix: false }));
        this.markdownConfigured = true;
    }

    /** Wrap styled output without deleting its ANSI SGR sequences. */
    private static wrapStyledLine(line: string, width: number): string[] {
        if (!line || width <= 0) return [line];

        const chunks: string[] = [];
        let chunk = "";
        let visible = 0;
        let styleHistory = "";
        const tokens = line.split(/(\x1b\[[0-9;]*m)/g).filter(Boolean);

        const pushChunk = () => {
            chunks.push(`${chunk}\x1b[0m`);
            chunk = styleHistory;
            visible = 0;
        };

        for (const token of tokens) {
            if (this.ansiPattern.test(token)) {
                this.ansiPattern.lastIndex = 0;
                chunk += token;
                styleHistory += token;
                continue;
            }
            for (const character of Array.from(token)) {
                if (visible >= width) pushChunk();
                chunk += character;
                visible++;
            }
        }

        chunks.push(`${chunk}\x1b[0m`);
        return chunks;
    }

    private static printResponseHeader(): void {
        console.log("");
        const now = new Date();
        const time = chalk.gray(`${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`);
        console.log("  " + this.accentTheme("rexa") + chalk.gray(" · ") + time);
        console.log("");
    }

    private static printMarkdownLine(line: string): void {
        const gutter = "  ▎ ";
        const displayWidth = Math.max(1, (process.stdout.columns || 100) - this.visibleLength(gutter));
        const rendered = (marked(line) as string).trimEnd();
        for (const renderedLine of rendered.split("\n")) {
            for (const chunk of this.wrapStyledLine(renderedLine, displayWidth)) {
                console.log(chalk.hex("#3B3B4F")(gutter) + chunk);
            }
        }
    }

    private static displayHeader(mode: AgentMode = "act"): void {
        const label = "REXA CLI";
        const version = this.version;
        const tag = "Autonomous Agent Harness";
        const toggle = "[PLAN] ↹ ACT  · Tab switches";
        const content = `${label}  ${version}  |  ${tag}  |  ${toggle}`;
        const width = content.length + 4;

        const modeLabel = (target: AgentMode) => target === mode
            ? chalk.cyan.bold(`[${target.toUpperCase()}]`)
            : target.toUpperCase();
        const headerLine =
            chalk.gray("│  ") +
            chalk.bold.white(label) +
            chalk.gray(`  ${version}  |  `) +
            chalk.bold.yellow(tag) +
            chalk.gray("  |  ") +
            modeLabel("plan") +
            chalk.gray(" ↹ ") +
            modeLabel("act") +
            chalk.gray("  · Tab switches  │");

        console.log(chalk.gray(`╭${"─".repeat(width)}╮`));
        console.log(headerLine);
        console.log(chalk.gray(`╰${"─".repeat(width)}╯`));
    }

    private static updateHeaderMode(mode: AgentMode, composerContentRows: number = 0): void {
        const label = "REXA CLI";
        const version = this.version;
        const tag = "Autonomous Agent Harness";
        const modeLabel = (target: AgentMode) => target === mode
            ? chalk.cyan.bold(`[${target.toUpperCase()}]`)
            : target.toUpperCase();
        const headerLine =
            chalk.gray("│  ") +
            chalk.bold.white(label) +
            chalk.gray(`  ${version}  |  `) +
            chalk.bold.yellow(tag) +
            chalk.gray("  |  ") +
            modeLabel("plan") +
            chalk.gray(" ↹ ") +
            modeLabel("act") +
            chalk.gray("  · Tab switches  │");

        // Do not rely on ANSI cursor-save slots: Windows terminals may share
        // them. Address the known header row relative to the input instead.
        const rowsToHeader = this.headerToPromptRows + composerContentRows;
        process.stdout.write(
            `\x1b[${rowsToHeader}A\r\x1b[2K${headerLine}\x1b[${rowsToHeader}B\r`,
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

    // Renders clear screen, framed ASCII logo, and the CLI status strip.
    static displayBanner(mode: AgentMode = "act"): void {
        console.clear();
        const asciiLogo = figlet.textSync("REXA", { font: "ANSI Regular" }).trimEnd();
        const logoLines = asciiLogo.split("\n");
        const logoWidth = Math.max(...logoLines.map((line) => line.length));
        const logoBorder = "─".repeat(logoWidth + 4);

        // The wordmark gets its own frame so the heavier glyphs read clearly
        // at a glance while retaining the existing yellow-to-gray gradient.
        console.log(this.theme(`╭${logoBorder}╮`));
        for (const line of logoLines) {
            console.log(this.theme(`│  ${line.padEnd(logoWidth)}  │`));
        }
        console.log(this.theme(`╰${logoBorder}╯`));
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
            let previousContentRows = 0;

            const composer = () => {
                const terminalWidth = stdout.columns || 100;
                // No leading indent: this outer edge intentionally aligns with
                // the logo frame and the status strip above it.
                const innerWidth = Math.max(32, terminalWidth - 4);
                const textWidth = Math.max(1, innerWidth - 3);
                const contentLines = this.splitIntoDisplayLines(value, textWidth);
                const hint = innerWidth >= 52
                    ? " Enter send "
                    : " Enter send ";
                const availableBorder = Math.max(0, innerWidth - hint.length);
                const leftBorder = Math.floor(availableBorder / 2);
                const rightBorder = availableBorder - leftBorder;
                const top =
                    chalk.cyan("╭") +
                    chalk.cyan("─".repeat(leftBorder)) +
                    chalk.gray(hint) +
                    chalk.cyan("─".repeat(rightBorder)) +
                    chalk.cyan("╮");
                const bottom = chalk.cyan(`╰${"─".repeat(innerWidth)}╯`);
                const rows = contentLines.map((line, index) => {
                    const prefix = index === 0
                        ? chalk.cyan.bold(" ❯ ")
                        : chalk.gray("   ");
                    const padding = " ".repeat(Math.max(0, textWidth - this.visibleLength(line)));
                    return chalk.gray("│") + prefix + line + padding + chalk.gray("│");
                });

                return { top, rows, bottom, contentRows: contentLines.length, currentLine: contentLines.at(-1) || "" };
            };

            const erasePreviousComposer = () => {
                if (previousContentRows === 0) return;

                // The cursor rests on the last content row. Move to the top,
                // erase the old box, then return to its top-left corner.
                stdout.write(`\x1b[${previousContentRows}A\r`);
                const totalRows = previousContentRows + 2;
                for (let index = 0; index < totalRows; index++) {
                    stdout.write("\x1b[2K");
                    if (index < totalRows - 1) stdout.write("\x1b[1B\r");
                }
                stdout.write(`\x1b[${totalRows - 1}A\r`);
            };

            const render = () => {
                const view = composer();
                erasePreviousComposer();
                stdout.write(`${view.top}\n${view.rows.join("\n")}\n${view.bottom}`);

                // Return from the lower border to the final editable row and
                // put the cursor immediately after the user's final character.
                stdout.write("\x1b[1A\r");
                const cursorColumn = 4 + this.visibleLength(view.currentLine);
                stdout.write(`\x1b[${cursorColumn}C`);
                previousContentRows = view.contentRows;
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
                    this.updateHeaderMode(mode, previousContentRows);
                    render();
                    return;
                }
                const insertsNewLine =
                    (key.name === "return" || key.name === "enter") && key.shift ||
                    key.ctrl && key.name === "j";
                if (insertsNewLine) {
                        value += "\n";
                        render();
                        return;
                }
                if (key.name === "return" || key.name === "enter") {
                    cleanup();
                    // Leave the completed composer intact and start the agent
                    // activity on a clean line directly beneath it.
                    stdout.write("\x1b[1B\r\n");
                    resolve({ value, mode });
                    return;
                }
                if (key.name === "backspace") {
                    value = Array.from(value).slice(0, -1).join("");
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

    
    static updateSpinner(spinner: Ora, status: string): void {
        if (!spinner.isSpinning) return;
        const toolStatus = /^(\[[^\]]+\])(.*)$/.exec(status);
        spinner.text = toolStatus
            ? chalk.cyan(toolStatus[1] || "") + chalk.gray(toolStatus[2] || "")
            : chalk.gray(status);
    }

    static beginStreamingResponse(spinner: Ora): void {
        if (spinner.isSpinning) spinner.stop();
        clearActiveSpinner(spinner);
        this.configureMarkdown();
        this.streamingBuffer = "";
        this.printResponseHeader();
    }

    /** Render complete Markdown lines only, preventing raw syntax from flashing. */
    static writeStreamingToken(token: string): void {
        this.streamingBuffer += token;
        let newlineIndex = this.streamingBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
            const line = this.streamingBuffer.slice(0, newlineIndex).replace(/\r$/, "");
            this.streamingBuffer = this.streamingBuffer.slice(newlineIndex + 1);
            this.printMarkdownLine(line);
            newlineIndex = this.streamingBuffer.indexOf("\n");
        }
    }

    static finishStreamingResponse(): void {
        if (this.streamingBuffer) this.printMarkdownLine(this.streamingBuffer);
        this.streamingBuffer = "";
        console.log("");
    }

    //   Renders the agent's response 
    
    static renderResponse(text: string): void {
        const cleaned = text?.trim();
        if (!cleaned) return;

        // Set up marked to render markdown for the terminal (marked-terminal v7+ API)
        this.configureMarkdown();

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
            // marked-terminal embeds ANSI styling; wrap while retaining it.
            for (const chunk of this.wrapStyledLine(line, displayWidth)) {
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
