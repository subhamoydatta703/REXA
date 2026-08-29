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

export class AgentUI {
    
    private static theme = gradient(["#f9f908", "#A1A1AA", "#52525B"]);
    
    private static accentTheme = gradient(["#ffff09ff","#ffff09ff"]);

    // Renders clear screen, monochrome ASCII logo, and pixel-perfect ANSI-safe box frame.
    static displayBanner(): void {
        console.clear();
        const asciiLogo = figlet.textSync("REXA", { font: "Standard" });

        // Print monochrome ASCII logo
        console.log(this.theme.multiline(asciiLogo));

        // Plain text components for accurate visible length calculation (ignoring ANSI codes)
        const label = "REXA CLI";
        const version = "v1.0.0";
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
    
    static async getPromptInput(): Promise<string> {
        return await input({
            message: chalk.cyan.bold(" ❯"),
            theme: {
                prefix: "",
            },
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

    
    static renderError(error: Error): void {
        console.log("");
        console.log("  " + chalk.red("err") + chalk.gray(" · ") + chalk.red(error.message));
        console.log("");
    }
}
