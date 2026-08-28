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

/**
 * Clone is the one Git command that must always create its working copy in the
 * sandbox volume.  Do not allow global-directory options or an output path
 * that can point from /workspace back to the host-mounted /app directory.
 */
export function validateSandboxedGitClone(args: string[]): string | undefined {
    const cloneIndex = args.findIndex((_, index) => getGitOperation(args.slice(0, index + 1)) === "clone");
    if (cloneIndex === -1) return undefined;

    const globalDirectoryOptions = new Set(["-c", "--git-dir", "--work-tree", "--exec-path"]);
    for (const rawArg of args.slice(0, cloneIndex)) {
        const arg = rawArg.trim().toLowerCase();
        if (
            globalDirectoryOptions.has(arg) ||
            arg.startsWith("-c") ||
            arg.startsWith("--git-dir=") ||
            arg.startsWith("--work-tree=") ||
            arg.startsWith("--exec-path=")
        ) {
            return "Git clone cannot override its working directory or Git executable path.";
        }
    }

    const cloneArgs = args.slice(cloneIndex + 1);
    const optionsWithValues = new Set([
        "-b", "--branch", "-c", "--config", "--depth", "--filter", "-j", "--jobs",
        "--origin", "-o", "--reference", "--reference-if-able", "--server-option",
        "--shallow-exclude", "--shallow-since", "--template", "-u", "--upload-pack",
        "--bundle-uri", "--separate-git-dir",
    ]);
    const positionalArgs: string[] = [];
    for (let index = 0; index < cloneArgs.length; index++) {
        const arg = cloneArgs[index];
        if (arg === undefined) continue;
        const normalized = arg.toLowerCase();
        if (arg === "--") {
            positionalArgs.push(...cloneArgs.slice(index + 1));
            break;
        }
        if (optionsWithValues.has(normalized)) {
            index++;
            continue;
        }
        if (normalized.startsWith("--branch=") || normalized.startsWith("--config=") ||
            normalized.startsWith("--depth=") || normalized.startsWith("--filter=") ||
            normalized.startsWith("--jobs=") || normalized.startsWith("--origin=") ||
            normalized.startsWith("--reference=") || normalized.startsWith("--reference-if-able=") ||
            normalized.startsWith("--server-option=") || normalized.startsWith("--shallow-exclude=") ||
            normalized.startsWith("--shallow-since=") || normalized.startsWith("--template=") ||
            normalized.startsWith("--upload-pack=") || normalized.startsWith("--bundle-uri=") ||
            normalized.startsWith("--separate-git-dir=")) {
            continue;
        }
        if (arg.startsWith("-")) continue;
        positionalArgs.push(arg);
    }

    if (positionalArgs.length > 2) {
        return "Git clone accepts only a repository URL and an optional destination directory.";
    }

    const destination = positionalArgs[1];
    if (!destination) return undefined;
    const isAbsolute = /^(?:[a-z]:[\\/]|[\\/]{1,2}|~[\\/])/.test(destination);
    const escapesWorkspace = destination.split(/[\\/]+/).some((segment) => segment === "..");
    if (isAbsolute || escapesWorkspace) {
        return "Git clone destination must be a relative path contained in the sandbox workspace.";
    }

    return undefined;
}
