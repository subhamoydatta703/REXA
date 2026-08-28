import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Agent } from "../agent/Agent";

export class CLI {
    private rl = readline.createInterface({
        input,
        output,
    });


    constructor(private agent: Agent) { }
    
       async start() {
        while (true) {
            const userInput = await this.rl.question(">> Yo!! It's me... REXA.... Sooo, what's the plan, man?\n>> ");

            if (
                userInput.trim().toLowerCase() === "exit" ||
                userInput.trim().toLowerCase() === "quit" ||
                userInput.trim().toLowerCase() === "q"    ||
                userInput.trim().toLowerCase() === "e"
            ) {
                break;
            }
            
            const output = await this.agent.run(userInput);
            const cleaned = output!.text?.replace(/^\s*\*\s*/gm, "")
                                         .replace(/\*\*/g, "")
                                         .replace(/`/g, "");
            console.log("AI AGENT: \n" + cleaned);
        }

        this.rl.close();
    }

}

