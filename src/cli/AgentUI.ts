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
    static displayBanner(): void {
        console.clear();
        const asciiLogo = figlet.textSync("REXA", { font: "Standard" });

        // Print monochrome ASCII logo
        console.log(this.theme.multiline(asciiLogo));

        // Plain text components for accurate visible length calculation (ignoring ANSI codes)
        const label = "REXA CLI";
        const version = "v1.1.0";
        const tag = "Autonomous Agent Harness";

        const plainText = `${label}  ${version}  │  ${tag}`;
        const padding = 4;
        const width = plainText.length + padding;

        const top = chalk.gray("┌" + "─".repeat(width) + "┐");
        const mid =
            chalk.gray("│  ") +
            chalk.bold.white(label) +
            chalk.gray(`  ${version}  │  `) +
            chalk.bold.yellow(tag) +
            chalk.gray("  │");
        const bot = chalk.gray("└" + "─".repeat(width) + "┘");

        console.log(top);
        console.log(mid);
        console.log(bot);

        
        console.log("");
        console.log(chalk.bold.yellow("  ❯ ") + chalk.gray("Yo, it's me... ") + chalk.bold.white("REXA") + chalk.gray(". What's the plan?"));
        console.log("");
    }

    /** Make the sandbox's host-file boundary visible before the agent starts. */
    static displayWorkspace(workspace: string): void {
        const resolved = path.resolve(workspace);
        const home = path.resolve(os.homedir());
        const isBroadWorkspace = resolved === home || resolved === path.parse(resolved).root;

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
                const modeLabel = mode === "plan" ? chalk.white.bold("PLAN") : chalk.yellow.bold("ACT");
                stdout.clearLine(0);
                stdout.cursorTo(0);
                stdout.write(` ${chalk.cyan.bold("❯")} ${value}${chalk.gray("  [")}${modeLabel}${chalk.gray(" · Tab switches]")}`);
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

        // Reserve space for the gutter prefix "  ▎ " (4 visible chars + 2 spaces = 6)
        const gutterWidth = 6;
        const termWidth = (process.stdout.columns || 100) - gutterWidth;

        // Word-wrap a plain string to termWidth
        const wrapLine = (str: string): string[] => {
            const words = str.split(" ");
            const wrapped: string[] = [];
            let current = "";
            for (const word of words) {
                if ((current + (current ? " " : "") + word).length > termWidth) {
                    if (current) wrapped.push(current);
                    current = word;
                } else {
                    current = current ? `${current} ${word}` : word;
                }
            }
            if (current) wrapped.push(current);
            return wrapped.length ? wrapped : [""];
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
            // Strip ANSI for length measurement, then wrap on visible length
            const visibleLine = line.replace(/\x1b\[[0-9;]*m/g, "");
            if (visibleLine.length <= termWidth) {
                console.log(chalk.hex("#3B3B4F")("  ▎ ") + line);
            } else {
                const chunks = wrapLine(visibleLine);
                for (const chunk of chunks) {
                    console.log(chalk.hex("#3B3B4F")("  ▎ ") + chunk);
                }
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
