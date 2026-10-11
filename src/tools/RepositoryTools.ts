import { z } from "zod";
import type { Tool } from "./ToolRegistry";
import { Workspace, workspace as activeWorkspace } from "./Workspace";

const listSchema = z.object({
    pattern: z.string().default("**/*"),
    directory: z.string().default("."),
    cursor: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(100),
});
const readSchema = z.object({
    path: z.string(),
    start_line: z.number().int().min(1).default(1),
    end_line: z.number().int().min(1).optional(),
    max_bytes: z.number().int().min(256).max(64_000).default(32_000),
});
const searchSchema = z.object({
    pattern: z.string().min(1).max(2000),
    glob: z.string().default("**/*"),
    directory: z.string().default("."),
    literal: z.boolean().default(true),
    cursor: z.number().int().min(0).default(0),
    max_results: z.number().int().min(1).max(200).default(50),
});

interface SearchMatch {
    path: string;
    line: number;
    text: string;
}

interface RipgrepEvent {
    type: string;
    data: {
        path: { text: string };
        lines: { text: string };
        line_number: number;
    };
}

const SEARCH_BATCH_SIZE = 50;
const MAX_SEARCH_LINE_CHARACTERS = 2000;

/** Read incrementally and stop as soon as the requested page plus lookahead is available. */
async function collectSearchMatches(
    output: ReadableStream<Uint8Array>,
    matches: SearchMatch[],
    wanted: number,
    stopSearch: () => void,
): Promise<boolean> {
    let truncated = false;
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of output) {
        pending += decoder.decode(chunk, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newlineIndex);
            pending = pending.slice(newlineIndex + 1);
            const event = JSON.parse(line) as RipgrepEvent;
            if (
                event.type === "match" &&
                event.data.lines.text.length <= MAX_SEARCH_LINE_CHARACTERS + 1
            ) {
                matches.push({
                    path: event.data.path.text.replaceAll("\\", "/"),
                    line: event.data.line_number,
                    text: event.data.lines.text.trimEnd(),
                });
            }
            if (matches.length >= wanted) {
                truncated = true;
                stopSearch();
                break;
            }
        }
        if (truncated) {
            break;
        }
    }
    return truncated;
}

async function searchRepository(workspace: Workspace, input: unknown) {
    const request = searchSchema.parse(input);
    // Discover first so the same ignore and protected-path rules govern search.
    const files = await workspace.files(request.glob, request.directory);
    const matches: SearchMatch[] = [];
    const wanted = request.cursor + request.max_results + 1;
    let truncated = false;
    for (
        let offset = 0;
        offset < files.length && matches.length < wanted;
        offset += SEARCH_BATCH_SIZE
    ) {
        const batch = files.slice(offset, offset + SEARCH_BATCH_SIZE);
        for (const file of batch) {
            await workspace.resolve(file);
        }
        const searchProcess = Bun.spawn(
            [
                "rg",
                "--threads",
                "1",
                "--json",
                "--max-columns",
                "2000",
                "--max-count",
                String(wanted),
                ...(request.literal ? ["--fixed-strings"] : []),
                "--",
                request.pattern,
                ...batch,
            ],
            { cwd: workspace.root, stdout: "pipe", stderr: "pipe" },
        );
        truncated = await collectSearchMatches(
            searchProcess.stdout,
            matches,
            wanted,
            () => searchProcess.kill(),
        );
        const error = await new Response(searchProcess.stderr).text();
        const exit = await searchProcess.exited;
        if (exit > 1 && !truncated) {
            throw new Error(`Search failed: ${error.slice(0, 1000)}`);
        }
    }
    return {
        matches: matches.slice(
            request.cursor,
            request.cursor + request.max_results,
        ),
        truncated,
        nextCursor: truncated ? request.cursor + request.max_results : null,
        warning:
            "Binary files and lines longer than 2000 characters are omitted.",
    };
}

export function repositoryTools(
    workspace: Workspace = activeWorkspace,
): Tool[] {
    const list: Tool = {
        name: "glob_files",
        effect: "read",
        description:
            "Discover files respecting .gitignore and .rexaignore. Paginated; use nextCursor until null.",
        parameters: listSchema,
        execute: async (input) => {
            const request = listSchema.parse(input);
            const files = await workspace.files(
                request.pattern,
                request.directory,
            );
            return {
                files: files.slice(
                    request.cursor,
                    request.cursor + request.limit,
                ),
                total: files.length,
                nextCursor:
                    request.cursor + request.limit < files.length
                        ? request.cursor + request.limit
                        : null,
            };
        },
    };
    const read: Tool = {
        name: "read_file",
        effect: "read",
        description:
            "Read bounded source lines with line numbers and a file hash for safe edits. Protected credential paths are denied.",
        parameters: readSchema,
        execute: async (input) => {
            const request = readSchema.parse(input);
            const end = request.end_line ?? request.start_line + 199;
            if (end < request.start_line) {
                throw new Error("end_line must be >= start_line");
            }
            return workspace.read(
                request.path,
                request.start_line,
                end,
                request.max_bytes,
            );
        },
    };
    const search: Tool = {
        name: "search_code",
        effect: "read",
        description:
            "Search repository text with ripgrep. Returns bounded matches with exact paths and line numbers. Literal search by default.",
        parameters: searchSchema,
        execute: (input) => searchRepository(workspace, input),
    };
    return [
        list,
        read,
        search,
        {
            ...list,
            name: "get_project_tree",
            description:
                "Paginated project file listing. Use nextCursor to continue.",
        },
        {
            name: "read_multiple_files",
            effect: "read",
            description:
                "Read up to ten files with bounded line-numbered output and explicit per-file errors.",
            parameters: z.object({ paths: z.array(z.string()).min(1).max(10) }),
            execute: async (input) => {
                const { paths } = z
                    .object({ paths: z.array(z.string()).min(1).max(10) })
                    .parse(input);
                return {
                    files: await Promise.all(
                        paths.map(async (filePath) => {
                            try {
                                return await workspace.read(filePath);
                            } catch (e) {
                                return { path: filePath, error: String(e) };
                            }
                        }),
                    ),
                };
            },
        },
        {
            name: "coding_context_tool",
            effect: "read",
            description:
                "Read source context with line numbers and hash. Use read_file for specific line ranges.",
            parameters: z.object({
                path: z.string(),
                instruction: z.string().optional(),
            }),
            execute: async (input) =>
                workspace.read(
                    z.object({ path: z.string() }).parse(input).path,
                ),
        },
    ];
}
