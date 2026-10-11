import path from "node:path";
import { realpath, stat, open } from "node:fs/promises";
import { createHash } from "node:crypto";

export const contentHash = (content: string | Buffer) =>
    createHash("sha256").update(content).digest("hex");
function protectedPath(name: string): boolean {
    for (const part of name.split(/[\\/]/)) {
        const protectedDirectory = [
            ".git",
            "node_modules",
            ".rexa",
            ".aws",
            ".ssh",
        ].includes(part);
        const sensitiveFile =
            /^(?:\.env(?:\..*)?|.*\.(?:pem|key))$/i.test(part) &&
            part !== ".env.example";
        if (protectedDirectory || sensitiveFile) {
            return true;
        }
    }
    return false;
}

/** Shared filesystem boundary. File tools never follow symlinks outside this root. */
export class Workspace {
    readonly root: string;
    readonly readHashes = new Map<string, string>();
    private readObservations = new Map<
        string,
        { revision: number; hash: string }
    >();
    constructor(root = process.cwd()) {
        this.root = path.resolve(root);
    }

    /** Normalize aliases so recovery cannot be bypassed by another spelling of a path. */
    async fileIdentity(name: string): Promise<string> {
        const target = await this.resolve(name);
        let identity = target;
        try {
            identity = await realpath(target);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
        return process.platform === "win32" ? identity.toLowerCase() : identity;
    }

    async lastRead(name: string) {
        return this.readObservations.get(await this.fileIdentity(name));
    }

    async resolve(name: string, allowProtected = false): Promise<string> {
        const target = path.resolve(this.root, name);
        const relative = path.relative(this.root, target);
        if (
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
        ) {
            throw new Error("Path must stay inside the active REXA project.");
        }
        if (!allowProtected && protectedPath(relative)) {
            throw new Error("Protected workspace path.");
        }
        const root = await realpath(this.root);
        let ancestor = target;
        for (;;) {
            try {
                const canonical = await realpath(ancestor);
                const canonicalRelativePath = path.relative(root, canonical);
                if (
                    canonicalRelativePath === ".." ||
                    canonicalRelativePath.startsWith(`..${path.sep}`) ||
                    path.isAbsolute(canonicalRelativePath)
                ) {
                    throw new Error(
                        "Path resolves outside the active REXA project.",
                    );
                }
                return target;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }
                const parent = path.dirname(ancestor);
                if (parent === ancestor) {
                    throw error;
                }
                ancestor = parent;
            }
        }
    }

    async files(pattern = "**/*", directory = "."): Promise<string[]> {
        const directoryPath = await this.resolve(directory);
        const args = [
            "rg",
            "--files",
            "--hidden",
            "--no-require-git",
            ...[
                ".git",
                "node_modules",
                "dist",
                "build",
                "coverage",
                ".next",
                ".venv",
                ".rexa",
            ].flatMap((filePath) => ["-g", `!${filePath}/**`]),
        ];
        const ignore = Bun.file(path.join(this.root, ".rexaignore"));
        if (await ignore.exists()) {
            args.push("--ignore-file", ignore.name!);
        }
        args.push("--", ".");
        let discoveryProcess;
        try {
            discoveryProcess = Bun.spawn(args, {
                cwd: directoryPath,
                stdout: "pipe",
                stderr: "pipe",
            });
        } catch (error) {
            const failure = error as NodeJS.ErrnoException;
            throw new Error(
                failure.code === "ENOENT"
                    ? "Repository discovery requires ripgrep (rg) on PATH. Install ripgrep and retry."
                    : `Cannot launch ripgrep: ${failure.code || failure.message}`,
            );
        }
        const [output, error, exit] = await Promise.all([
            new Response(discoveryProcess.stdout).text(),
            new Response(discoveryProcess.stderr).text(),
            discoveryProcess.exited,
        ]);
        if (exit > 1) {
            throw new Error(`File discovery failed: ${error.slice(0, 1000)}`);
        }
        const files = output
            .split(/\r?\n/)
            .filter(Boolean)
            .map((filePath) =>
                path
                    .relative(this.root, path.resolve(directoryPath, filePath))
                    .split(path.sep)
                    .join("/"),
            );
        if (files.length > 100_000) {
            throw new Error(
                "Repository exceeds 100,000 files; select a narrower directory.",
            );
        }
        const glob = new Bun.Glob(pattern);
        return files
            .filter(
                (filePath) =>
                    !protectedPath(filePath) &&
                    (glob.match(filePath) ||
                        (!pattern.includes("/") &&
                            glob.match(path.basename(filePath)))),
            )
            .sort();
    }

    async read(
        name: string,
        startLine = 1,
        endLine = startLine + 199,
        maxBytes = 32_000,
    ) {
        const target = await this.resolve(name);
        const info = await stat(target);
        if (!info.isFile()) {
            throw new Error(`Not a file: ${name}`);
        }
        if (info.size > 2_000_000) {
            throw new Error(
                "File exceeds 2 MB; use search_code or a narrower source file.",
            );
        }
        const handle = await open(target, "r");
        let buffer: Buffer;
        try {
            buffer = await handle.readFile();
        } finally {
            await handle.close();
        }
        if (buffer.includes(0)) {
            throw new Error("Binary files cannot be read as source text.");
        }
        const hash = contentHash(buffer);
        this.readHashes.set(target, hash);
        const lines = buffer.toString("utf8").split(/\r?\n/);
        const selected: string[] = [];
        let bytes = 0;
        for (
            let lineIndex = startLine - 1;
            lineIndex < Math.min(endLine, lines.length);
            lineIndex++
        ) {
            const line = `${lineIndex + 1}: ${lines[lineIndex]}`;
            if (bytes + Buffer.byteLength(line) + 1 > maxBytes) {
                break;
            }
            selected.push(line);
            bytes += Buffer.byteLength(line) + 1;
        }
        const lastLine = startLine + selected.length - 1;
        if (selected.length > 0) {
            const identity = await this.fileIdentity(name);
            const revision =
                (this.readObservations.get(identity)?.revision ?? 0) + 1;
            this.readObservations.set(identity, { revision, hash });
        }
        return {
            path: name,
            hash,
            content: selected.join("\n"),
            startLine,
            endLine: lastLine,
            totalLines: lines.length,
            truncated:
                lastLine < Math.min(endLine, lines.length) ||
                endLine < lines.length,
            nextLine:
                lastLine < lines.length
                    ? Math.max(startLine, lastLine + 1)
                    : null,
            warning:
                selected.length === 0 && startLine <= lines.length
                    ? "Line exceeds byte limit; use search_code."
                    : undefined,
        };
    }
}

export const workspace = new Workspace();
