import { readFile } from "node:fs/promises";
import path from "node:path";
import { select } from "@inquirer/prompts";
import { z } from "zod";
import type { Tool } from "./ToolRegistry";
import { workspaceDataDirectory } from "../utils/WorkspaceData";
import { pauseActiveSpinner, resumeActiveSpinner } from "../cli/TerminalState";
import { sanitizeStored } from "../utils/SanitizeStored";

export type PermissionAction = "allow" | "ask" | "deny";
const ruleSchema = z.object({
    tool: z.string().optional(),
    effect: z.enum(["read", "web", "edit", "command", "external"]).optional(),
    path: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    workdir: z.string().optional(),
    action: z.enum(["allow", "ask", "deny"]),
});
export type PermissionRule = z.infer<typeof ruleSchema>;
type PermissionRequest = {
    tool: string;
    effect: Tool["effect"];
    params: Record<string, unknown>;
};
function sortObjectKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortObjectKeys);
    }

    if (value && typeof value === "object") {
        const object = value as Record<string, unknown>;
        const entries = Object.keys(object)
            .sort()
            .map((key) => [key, sortObjectKeys(object[key])]);
        return Object.fromEntries(entries);
    }

    return value;
}

function requestedPaths(params: Record<string, unknown>): string[] {
    if (params.operations) {
        // Edit batches have already passed the tool's Zod schema.
        const operations = params.operations as { path: string }[];
        return operations.map((operation) => operation.path);
    }
    if (params.path) {
        return [params.path as string];
    }
    return [];
}

function matchesRule(
    rule: PermissionRule,
    request: PermissionRequest,
): boolean {
    const { params } = request;

    if (rule.tool && rule.tool !== request.tool) {
        return false;
    }
    if (rule.effect && rule.effect !== request.effect) {
        return false;
    }
    if (rule.command && rule.command !== params.command) {
        return false;
    }
    if (rule.workdir && rule.workdir !== params.workdir) {
        return false;
    }
    if (
        rule.args &&
        JSON.stringify(rule.args) !== JSON.stringify(params.args)
    ) {
        return false;
    }

    if (rule.path) {
        const paths = requestedPaths(params);
        const pattern = new Bun.Glob(rule.path);
        return (
            paths.length > 0 &&
            paths.every((filePath) => pattern.match(filePath))
        );
    }

    return true;
}

export class PermissionService {
    private grants = new Set<string>();
    constructor(
        private rules: PermissionRule[] = [],
        private ask = async (
            request: PermissionRequest,
        ): Promise<"once" | "session" | "deny"> => {
            if (!process.stdin.isTTY) {
                return "deny";
            }
            const paused = pauseActiveSpinner();
            try {
                return await select({
                    message: `Allow ${request.tool} (${request.effect ?? "unknown"})? ${JSON.stringify(sanitizeStored(request.params))}`,
                    choices: [
                        { name: "Allow once", value: "once" },
                        {
                            name: "Allow this exact operation for this session",
                            value: "session",
                        },
                        { name: "Deny", value: "deny" },
                    ],
                });
            } finally {
                resumeActiveSpinner(paused);
            }
        },
    ) {}

    static async load(
        filename = path.join(
            workspaceDataDirectory(process.cwd()),
            "permissions.json",
        ),
    ) {
        try {
            return new PermissionService(
                z
                    .object({ rules: z.array(ruleSchema) })
                    .parse(JSON.parse(await readFile(filename, "utf8"))).rules,
            );
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") {
                return new PermissionService();
            }
            throw new Error(
                `Invalid permissions configuration: ${(e as Error).message}`,
            );
        }
    }

    describe() {
        return {
            defaults: {
                read: "allow",
                web: "allow",
                edit: "ask",
                command: "ask",
                external: "ask",
                unknown: "ask",
            },
            rules: this.rules,
            sessionGrants: this.grants.size,
        };
    }

    clearGrants() {
        this.grants.clear();
    }

    async authorize(tool: Tool, params: Record<string, unknown>) {
        const request: PermissionRequest = {
            tool: tool.name,
            effect: tool.effect,
            params,
        };
        let action: PermissionAction =
            tool.effect === "read" || tool.effect === "web" ? "allow" : "ask";
        for (const rule of this.rules) {
            // Later matching rules override earlier ones.
            if (matchesRule(rule, request)) {
                action = rule.action;
            }
        }
        if (action === "deny") {
            return false;
        }
        const fingerprint = JSON.stringify(sortObjectKeys(request));
        if (action === "allow" || this.grants.has(fingerprint)) {
            return true;
        }
        const decision = await this.ask(request);
        if (decision === "session") {
            this.grants.add(fingerprint);
        }
        return decision !== "deny";
    }
}
export let permissions = new PermissionService();
export function setPermissions(service: PermissionService) {
    permissions = service;
}
