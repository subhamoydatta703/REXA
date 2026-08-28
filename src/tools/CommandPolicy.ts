export interface CommandPolicy {
    safe: string[];
}

const GIT_MUTATING_OPERATIONS = new Set([
    "clone", "add", "commit", "push", "pull", "fetch", "merge", "rebase",
    "reset", "clean", "checkout", "switch", "branch", "tag",
]);

// Find the Git subcommand after global options and their values.
export function getGitOperation(args: string[]): string | undefined {
    const optionsWithValues = new Set(["-c", "-C", "--config-env", "--git-dir", "--work-tree", "--exec-path", "--namespace"]);
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]?.trim().toLowerCase();
        if (!arg) continue;
        if (optionsWithValues.has(arg)) {
            i++;
            continue;
        }
        if (arg === "--") return args[i + 1]?.trim().toLowerCase();
        if (arg.startsWith("-")) continue;
        return arg;
    }
    return undefined;
}

export function gitRequiresConfirmation(args: string[]): boolean {
    return GIT_MUTATING_OPERATIONS.has(getGitOperation(args) || "");
}
