import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Workspace } from "../../src/tools/Workspace";
import { repositoryTools } from "../../src/tools/RepositoryTools";

let root: string;
let ws: Workspace;
beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "rexa-repository-"));
    ws = new Workspace(root);
    await mkdir(path.join(root, "src"));
    await Promise.all(
        Array.from({ length: 320 }, (_, i) =>
            writeFile(
                path.join(root, "src", `file ${String(i).padStart(3, "0")}.ts`),
                "const value = 1;\r\nfunction caller() { return value; }\r\n",
            ),
        ),
    );
    await writeFile(path.join(root, ".gitignore"), "ignored.ts\n");
    await writeFile(path.join(root, ".rexaignore"), "private.ts\n");
    for (const name of ["ignored.ts", "private.ts", ".env"])
        await writeFile(path.join(root, name), "hidden");
});
afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});
function tool(name: string) {
    return repositoryTools(ws).find((t) => t.name === name)!;
}

test("discovery paginates beyond 300 files and respects ignore files", async () => {
    const first = await tool("glob_files").execute({
        pattern: "*.ts",
        limit: 300,
    });
    const last = await tool("glob_files").execute({
        pattern: "*.ts",
        cursor: first.nextCursor,
        limit: 300,
    });
    expect(first.files.length).toBe(300);
    expect(last.files.length).toBe(20);
    expect(last.nextCursor).toBeNull();
    expect(first.files).not.toContain("ignored.ts");
    expect(first.files).not.toContain("private.ts");
});
test("reads bounded numbered lines and reports missing and binary files", async () => {
    const result = await tool("read_file").execute({
        path: "src/file 000.ts",
        start_line: 2,
        end_line: 2,
    });
    expect(result.content).toBe("2: function caller() { return value; }");
    expect(result.hash).toHaveLength(64);
    await expect(ws.read("missing.ts")).rejects.toThrow();
    await writeFile(path.join(root, "binary"), Buffer.from([0, 1, 2]));
    await expect(ws.read("binary")).rejects.toThrow("Binary");
    await writeFile(path.join(root, "long.ts"), "x".repeat(5000));
    const long = await ws.read("long.ts", 1, 1, 256);
    expect(long.content).toBe("");
    expect(long.warning).toContain("byte limit");
    const multi = await tool("read_multiple_files").execute({
        paths: ["missing.ts", "src/file 000.ts"],
    });
    expect(multi.files[0].error).toBeDefined();
    expect(multi.files[1].hash).toHaveLength(64);
});
test("search returns exact lines, paginates, and rejects invalid regex", async () => {
    const result = await tool("search_code").execute({
        pattern: "caller",
        max_results: 3,
    });
    expect(result.matches.length).toBe(3);
    expect(result.matches[0].line).toBe(2);
    expect(result.nextCursor).toBe(3);
    const next = await tool("search_code").execute({
        pattern: "caller",
        max_results: 3,
        cursor: 3,
    });
    expect(next.matches[0].path).not.toBe(result.matches[0].path);
    await expect(
        tool("search_code").execute({ pattern: "[", literal: false }),
    ).rejects.toThrow("Search failed");
});
test("rejects traversal, protected files, and escaping symlinks", async () => {
    await expect(ws.resolve("../outside")).rejects.toThrow("inside");
    await expect(ws.read(".env")).rejects.toThrow("Protected");
    await symlink(
        tmpdir(),
        path.join(root, "escape"),
        process.platform === "win32" ? "junction" : "dir",
    );
    await expect(ws.resolve("escape/file.ts")).rejects.toThrow("outside");
});
