import { z } from "zod";
import { readdir } from "fs/promises";
import { type Tool } from "./ToolRegistry";
import { write } from "bun";
import { join } from "path";
import { glob } from "node:fs/promises";
import { confirm } from "@inquirer/prompts";
import { pauseActiveSpinner, resumeActiveSpinner } from "../cli/TerminalState";


// Count files directly inside a directory.
const countFileSchema = z.object({
    path: z
        .string()
        .min(1)
        .describe(
            "Path of the directory whose files should be counted. " +
            "Example: 'src/tools'."
        )
});


// Create a new file and immediately execute it.
const createAndExecuteFileSchema = z.object({
    path: z
        .string()
        .min(1)
        .describe(
            "Path where the new file should be created. " +
            "Example: 'src/test.ts'."
        ),

    code: z
        .string()
        .min(1)
        .describe(
            "Complete code to write into the new file before executing it."
        )
});


// Append content strictly to the end of an existing file.
const appendFileSchema = z.object({
    path: z
        .string()
        .min(1)
        .describe(
            "Exact path of the existing file to append content to."
        ),

    text: z
        .string()
        .min(1)
        .describe(
            "Text that should be added strictly at the end of the file."
        )
});


// Find one specific file.
const findFileSchema = z.object({
    name: z
        .string()
        .min(1)
        .describe(
            "Name or part of the name of ONE specific file to find. " +
            "Examples: 'Math.ts', 'Agent.ts', or 'Math'."
        )
});


// Read one known file.
const readFileSchema = z.object({
    path: z
        .string()
        .min(1)
        .describe(
            "Exact path of ONE existing file to read. " +
            "Example: 'src/Math.ts'."
        )
});


// Read multiple known files.
const readMultipleFilesSchema = z.object({
    paths: z
        .array(z.string().min(1))
        .min(1)
        .describe(
            "Exact paths of multiple existing files to read. " +
            "Example: ['src/Math.ts', 'src/Agent.ts']. " +
            "Do not pass a directory path."
        )
});


// Read all files recursively inside a directory.
const readDirectorySchema = z.object({
    dir: z
        .string()
        .min(1)
        .describe(
            "Path of a directory whose files should be read recursively. " +
            "Example: 'src/tools'."
        )
});


// List file paths inside a directory without reading file contents.
const listFilesSchema = z.object({
    dir: z
        .string()
        .min(1)
        .describe(
            "Path of a directory whose file paths should be listed recursively. " +
            "Example: 'src/tools'."
        )
});


// Create a new file.
const createFileSchema = z.object({
    path: z
        .string()
        .min(1)
        .describe(
            "Path where the NEW file should be created."
        ),

    text: z
        .string()
        .min(1)
        .describe(
            "Complete initial content of the new file."
        )
});


// Create a file containing a plan.
const createAndWritePlanSchema = z.object({
    filePath: z
        .string()
        .min(1)
        .describe(
            "Path where the new plan file should be created."
        ),

    plan: z
        .string()
        .min(1)
        .describe(
            "Plan content that should be written into the plan file."
        )
});


// Edit an existing file.
const editFileSchema = z.object({
    path: z
        .string()
        .min(1)
        .describe(
            "Exact path of the EXISTING file to edit."
        ),

    target: z
        .string()
        .optional()
        .describe(
            "Existing text identifying where the edit should happen. " +
            "Required for 'before', 'after', and 'replace'. " +
            "Not required for 'start' or 'end'."
        ),

    text: z
        .string()
        .describe(
            "New content to insert or use as replacement."
        ),

    position: z
        .enum([
            "start",
            "end",
            "before",
            "after",
            "replace"
        ])
        .describe(
            "Edit operation: 'start' inserts at the beginning, " +
            "'end' inserts at the end, " +
            "'before' inserts before the target, " +
            "'after' inserts after the target, " +
            "'replace' replaces the target."
        )
});



const getProjectTreeSchema = z.object({});


// Find one specific file in the codebase.
export const findFile: Tool = {
    name: "find_file",

    description:
        "Find ONE specific file in the codebase and return its actual path. " +
        "USE THIS when you need to locate a single file before reading or editing it. " +
        "Examples: 'Find Math.ts', 'Locate Agent.ts', 'Find the Math file'. " +
        "DO NOT use this to read the file. " +
        "DO NOT use this to list files in a directory.",

    parameters: findFileSchema,

    execute: async (
        args: z.infer<typeof findFileSchema>
    ) => {
        const { name } =
            findFileSchema.parse(args);

        const paths =
            await getFilePaths(process.cwd());

        const matches =
            paths.filter((filePath) =>
                filePath
                    .toLowerCase()
                    .includes(name.toLowerCase())
            );

        if (matches.length === 0) {
            throw new Error(
                `No file found matching: ${name}`
            );
        }

        if (matches.length > 1) {
            return {
                output:
                    "Multiple files found. Select the correct file path.",
                files: matches
            };
        }

        return {
            path: matches[0]
        };
    }
};


// Read one existing file from an exact path.
export const readFile: Tool = {
    name: "read_file",

    description:
        "Read ONE existing file from its exact path and return its contents. " +
        "USE THIS when you already know the path of one file. " +
        "Example: 'Read src/Math.ts'. " +
        "If you do not know the path, use find_file first. " +
        "DO NOT use this for directories or multiple files.",

    parameters: readFileSchema,

    execute: async (
        args: z.infer<typeof readFileSchema>
    ) => {
        const { path } =
            readFileSchema.parse(args);

        const file =
            Bun.file(path);

        if (!(await file.exists())) {
            throw new Error(
                `File does not exist: ${path}`
            );
        }

        const content =
            await file.text();

        return {
            path,
            content
        };
    }
};


// Read multiple existing files from exact paths.
export const readMultipleFiles: Tool = {
    name: "read_multiple_files",

    description:
        "Read MULTIPLE existing files from their exact file paths. " +
        "USE THIS when you already know the paths of two or more files. " +
        "Example: ['src/Math.ts', 'src/Agent.ts']. " +
        "DO NOT use this to find files. " +
        "DO NOT pass a directory path. " +
        "If you need to find one file, use find_file. " +
        "If you need to read an entire directory recursively, use read_directory.",

    parameters: readMultipleFilesSchema,

    execute: async (
        args: z.infer<typeof readMultipleFilesSchema>
    ) => {
        const { paths } =
            readMultipleFilesSchema.parse(args);

        const files: {
            path: string;
            content: string;
        }[] = [];

        for (const path of paths) {
            try {
                const file =
                    Bun.file(path);

                if (!(await file.exists())) {
                    continue;
                }

                const content =
                    await file.text();

                files.push({
                    path,
                    content
                });
            } catch {
                // Skip files that cannot be read.
            }
        }

        return {
            files
        };
    }
};


// Read every file recursively inside a directory.
export const readDirectory: Tool = {
    name: "read_directory",

    description:
        "Read ALL readable files recursively inside a directory and return their paths and contents. " +
        "USE THIS when the user wants to inspect an entire directory or directory tree. " +
        "Examples: 'Read everything inside src/tools' or 'Inspect the whole src directory'. " +
        "DO NOT use this for one specific file. " +
        "DO NOT pass a file path. " +
        "For one known file use read_file.",

    parameters: readDirectorySchema,

    execute: async (
        args: z.infer<typeof readDirectorySchema>
    ) => {
        const { dir } =
            readDirectorySchema.parse(args);

        const paths =
            await getFilePaths(dir);

        const files: {
            path: string;
            content: string;
        }[] = [];

        for (const path of paths) {
            try {
                const file =
                    Bun.file(path);

                if (!(await file.exists())) {
                    continue;
                }

                const content =
                    await file.text();

                files.push({
                    path,
                    content
                });
            } catch {
                // Skip files that cannot be read.
            }
        }

        return {
            files
        };
    }
};


// List file paths recursively without reading file contents.
export const listFiles: Tool = {
    name: "list_files",

    description:
        "List file paths inside a directory recursively without reading their contents. " +
        "USE THIS for any task that needs to know which files exist in a directory — " +
        "including simple one-off checks like 'what's in docs/' or 'find files in src'. " +
        "This is always the correct tool for listing. " +
        "DO NOT write and execute a script (Python, Node, shell, or otherwise) to list " +
        "a directory — that is slower and creates unnecessary files. " +
        "list_files or read_directory are always preferred over create_and_execute_file " +
        "or execute_command for directory inspection. " +
        "DO NOT use this when the user wants file contents. " +
        "Use read_file or read_directory when content is needed.",

    parameters: listFilesSchema,

    execute: async (
        args: z.infer<typeof listFilesSchema>
    ) => {
        const { dir } =
            listFilesSchema.parse(args);

        const paths =
            await getFilePaths(dir);

        return {
            files: paths
        };
    }
};


// Count files directly inside a directory.
export const countFile: Tool = {
    name: "count_file",

    description:
        "Count the entries directly inside a directory. " +
        "USE THIS only when the user asks how many files or entries are in a directory. " +
        "Example: 'How many files are in src/tools?'. " +
        "DO NOT use this to find, list, or read files.",

    parameters: countFileSchema,

    execute: async (
        args: z.infer<typeof countFileSchema>
    ) => {
        const parsed =
            countFileSchema.parse(args);

        const files =
            await readdir(parsed.path);

        return {
            count: files.length
        };
    }
};



const deleteFileSchema = z.object({
    path: z.string().describe("The path to the file to delete").min(1)
});


// Create a new file without executing it.
export const createFile: Tool = {
    name: "create_file",

    description:
        "Create a NEW file and write initial content into it. " +
        "USE THIS when the requested file does not already exist. " +
        "Example: 'Create src/utils/Math.ts'. " +
        "DO NOT use this to modify an existing file. " +
        "Use edit_file for existing files. " +
        "DO NOT use this when the new file should immediately be executed; use create_and_execute_file.",

    parameters: createFileSchema,

    execute: async (
        args: z.infer<typeof createFileSchema>
    ) => {
        const parsed =
            createFileSchema.parse(args);

        await write(
            parsed.path,
            parsed.text
        );

        return {
            output: "File created successfully"
        };
    }
};


// Create a new file and immediately execute it, capturing real output.
export const createAndExecuteFile: Tool = {
    name: "create_and_execute_file",

    description:
        "Create a NEW standalone script file and immediately execute it, capturing its " +
        "stdout, stderr, and exit code. " +
        "USE THIS only when the user explicitly wants a script created and run as part " +
        "of the deliverable (e.g. 'write and run a build script'). " +
        "DO NOT use this to inspect, list, or read files or directories — " +
        "use list_files, find_file, read_file, or read_directory for that; writing a " +
        "throwaway script to do what those tools already do is never correct, and this " +
        "tool will reject scripts that only list/inspect files or directories. " +
        "DO NOT use this to modify an existing file. " +
        "DO NOT use this when the user only wants to create a file; use create_file.",

    parameters: createAndExecuteFileSchema,

    execute: async (
        args: z.infer<typeof createAndExecuteFileSchema>
    ) => {
        const parsed =
            createAndExecuteFileSchema.parse(args);

        // Reject scripts whose only purpose is listing/inspecting files or
        // directories — that's what list_files / read_directory are for.
        const inspectionSignals =
            /os\.listdir|os\.walk|glob\.glob|pathlib\.Path\([^)]*\)\.iterdir|fs\.readdirSync|fs\.readdir\(|fs\/promises['"]\).*readdir/i;

        if (inspectionSignals.test(parsed.code)) {
            return {
                success: false,
                status: "rejected",
                path: parsed.path,
                error:
                    "This script only lists or inspects files/directories, which " +
                    "list_files or read_directory already do. No file was created " +
                    "and nothing was executed — call list_files or read_directory instead.",
            };
        }

        await write(
            parsed.path,
            parsed.code
        );

        try {
            const proc = Bun.spawn(
                ["bun", "run", parsed.path],
                {
                    stdout: "pipe",
                    stderr: "pipe",
                }
            );

            const stdout =
                await new Response(proc.stdout).text();

            const stderr =
                await new Response(proc.stderr).text();

            const exitCode =
                await proc.exited;

            return {
                success: exitCode === 0,
                path: parsed.path,
                exitCode,
                stdout,
                stderr,
            };
        } catch (error) {
            return {
                success: false,
                path: parsed.path,
                exitCode: null,
                stdout: "",
                stderr:
                    error instanceof Error
                        ? error.message
                        : String(error),
            };
        }
    }
};

// Append content strictly to the end of an existing file.
export const appendFileTool: Tool = {
    name: "append_file",

    description:
        "Add text strictly to the END of an existing file. " +
        "USE THIS only when the new content should always be at the end. " +
        "Example: 'Append this log entry to the file'. " +
        "DO NOT use this for inserting content in the middle or beginning. " +
        "Use edit_file when the location matters.",

    parameters: appendFileSchema,

    execute: async (
        args: z.infer<typeof appendFileSchema>
    ) => {
        const parsed =
            appendFileSchema.parse(args);

        const file =
            Bun.file(parsed.path);

        if (!(await file.exists())) {
            throw new Error(
                `File does not exist: ${parsed.path}`
            );
        }

        const existingText =
            await file.text();

        const updatedContent =
            existingText +
            "\n" +
            parsed.text;

        await Bun.write(
            parsed.path,
            updatedContent
        );

        return {
            success: true,
            output:
                "File appended successfully",
            path: parsed.path,
            currentFileContent: updatedContent
        };
    }
};


// Edit an existing file at a specific location.
export const editFile: Tool = {
    name: "edit_file",

    description:
        "Edit an EXISTING file by inserting or replacing content at a specific location. " +
        "USE THIS when the user wants to modify an existing file. " +
        "Use 'start' to insert at the beginning. " +
        "Use 'end' to insert at the end. " +
        "Use 'before' to insert before target text. " +
        "Use 'after' to insert after target text. " +
        "Use 'replace' to replace target text. " +
        "Examples: 'Add an import at the top' -> start. " +
        "'Add a function at the bottom' -> end. " +
        "'Add power() after divide()' -> after with divide as target. " +
        "'Replace return a + b with return a - b' -> replace. " +
        "DO NOT use this to create a new file. " +
        "DO NOT use append_file when the content needs a specific location.",

    parameters: editFileSchema,

    execute: async (
        args: z.infer<typeof editFileSchema>
    ) => {
        const parsed =
            editFileSchema.parse(args);

        const file =
            Bun.file(parsed.path);

        if (!(await file.exists())) {
            throw new Error(
                `File does not exist: ${parsed.path}`
            );
        }

        const content =
            await file.text();

        let updatedContent: string;

        if (parsed.position === "start") {
            updatedContent =
                parsed.text + content;
        }

        else if (parsed.position === "end") {
            updatedContent =
                content + parsed.text;
        }

        else {
            if (!parsed.target) {
                throw new Error(
                    `Target is required when position is "${parsed.position}".`
                );
            }

            const targetIndex =
                content.indexOf(parsed.target);

            if (targetIndex === -1) {
                return {
                    success: false,
                    error: "TARGET_NOT_FOUND",
                    path: parsed.path,
                    target: parsed.target,
                };
            }

            if (parsed.position === "before") {
                updatedContent =
                    content.slice(
                        0,
                        targetIndex
                    ) +
                    parsed.text +
                    content.slice(
                        targetIndex
                    );
            }

            else if (parsed.position === "after") {
                const endOfTarget =
                    targetIndex +
                    parsed.target.length;

                updatedContent =
                    content.slice(
                        0,
                        endOfTarget
                    ) +
                    parsed.text +
                    content.slice(
                        endOfTarget
                    );
            }

            else {
                updatedContent =
                    content.slice(
                        0,
                        targetIndex
                    ) +
                    parsed.text +
                    content.slice(
                        targetIndex +
                        parsed.target.length
                    );
            }
        }

        await Bun.write(
            parsed.path,
            updatedContent
        );

        return {
            success: true,
            message:
                "File edited successfully",
            path: parsed.path,
            // Ground-truth current content — trust this over any earlier
            // assumption about the file's state.
            currentFileContent: updatedContent
        };
    }
};


// Create a new file containing an execution plan.
export const createAndWritePlan: Tool = {
    name: "create_and_write_plan",

    description:
        "Create a NEW file specifically for storing a plan for a multi-step task. " +
        "USE THIS when the agent needs to persist a plan before executing the task. " +
        "Example: 'Create a plan for adding authentication'. " +
        "DO NOT use this for normal source-code files; use create_file.",

    parameters: createAndWritePlanSchema,

    execute: async (
        args: z.infer<typeof createAndWritePlanSchema>
    ) => {
        const parsed =
            createAndWritePlanSchema.parse(args);

        await write(
            parsed.filePath,
            parsed.plan
        );

        return {
            output:
                "File created and plan written successfully"
        };
    }
};


// Recursively find every file path inside a directory.
async function getFilePaths(
    dir: string
): Promise<string[]> {
    const entries =
        await readdir(dir, {
            withFileTypes: true
        });

    const paths: string[] = [];

    for (const entry of entries) {
        const fullPath =
            join(
                dir,
                entry.name
            );

        if (entry.isFile()) {
            paths.push(fullPath);
        }
        

        if (entry.isDirectory()) {
            const nestedPaths =
                await getFilePaths(fullPath);

            paths.push(
                ...nestedPaths
            );
        }
    }

    return paths;
}





export const deleteFile: Tool = {
    name: "delete_file",

    description:
        "Delete a file from the filesystem. " +
        "USE THIS when the agent needs to remove a file with user permission. " +
        "Example: 'Delete src/utils/Math.ts'. " +
        "DO NOT use this for normal source-code files; use create_file." +
        "Do NOT delete files without explicit user permission or mention by the user.",

    parameters: deleteFileSchema,

    execute: async (
        args: z.infer<typeof deleteFileSchema>
    ) => {
        const parsed =
            deleteFileSchema.parse(args);

        const path = parsed.path;
        const spinnerWasActive = pauseActiveSpinner();
        let approved = false;
        try {
            approved = await confirm({
                message: `Delete file ${path}?`,
                default: false,
            });
        } finally {
            resumeActiveSpinner(spinnerWasActive);
        }
        if (!approved) {
            return { success: false, status: "rejected", path, output: "File deletion rejected by the user." };
        }
        const file = Bun.file(path);

        await file.delete();

        return {
            output:
                "File deleted successfully"
        };
    }
};



export const getAllFiles = async () => {
    const allFiles = await Array.fromAsync(
        glob("**/*", {
            exclude: ["node_modules/**", "dist/**", ".git/**", "build/**", ".next/**", "coverage/**", "*.log"],
        })
    );

    return {
        total: allFiles.length,
        files: allFiles.slice(0, 300),
        truncated: allFiles.length > 300,
    };
};



export const getProjectTree: Tool = {
    name: "get_project_tree",
    description:
        "Return the project's file listing (excluding node_modules, dist, build, .git, " +
        "and similar generated directories). USE THIS FIRST whenever a task does not " +
        "specify a file path — call this before find_file, list_files, or read_directory " +
        "to see what actually exists. Do not guess directory names or write a script to " +
        "discover files (os.walk, listdir, readdirSync, etc.).",
    parameters: getProjectTreeSchema,
    execute: async () => {
        const { total, files, truncated } = await getAllFiles();
        return { total, files, truncated };
    },
};
