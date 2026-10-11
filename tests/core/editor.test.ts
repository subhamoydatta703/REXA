import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "../../src/tools/Workspace";
import { SafeEditor } from "../../src/tools/SafeEditor";
import { CheckpointStore, atomicText } from "../../src/tools/CheckpointStore";

let root: string, ws: Workspace, editor: SafeEditor;
beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "rexa-editor-"));
    await mkdir(path.join(root, "project"));
    ws = new Workspace(path.join(root, "project"));
    editor = new SafeEditor(
        ws,
        new CheckpointStore(ws, path.join(root, "checkpoints")),
    );
    await writeFile(path.join(ws.root, "a.ts"), "hello\r\nworld 🌍\r\n");
    await ws.read("a.ts");
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});
const text = () => readFile(path.join(ws.root, "a.ts"), "utf8");
test("exclusive create, stale edit, missing hash, and ambiguous targets preserve files", async () => {
    await expect(
        editor.execute({ operation: "create", path: "a.ts", content: "bad" }),
    ).rejects.toThrow("already exists");
    await writeFile(path.join(ws.root, "a.ts"), "hello hello");
    await expect(
        editor.execute({ operation: "write", path: "a.ts", content: "bad" }),
    ).rejects.toThrow("Stale");
    await ws.read("a.ts");
    await expect(
        editor.execute({
            operation: "edit",
            path: "a.ts",
            changes: [{ type: "replace", target: "hello", content: "bad" }],
        }),
    ).rejects.toThrow("AMBIGUOUS");
    ws.readHashes.clear();
    await expect(
        editor.execute({ operation: "delete", path: "a.ts" }),
    ).rejects.toThrow("Read");
    expect(await text()).toBe("hello hello");
});
test("validates entire batch before mutation and restores create/edit/delete", async () => {
    const original = await text();
    await expect(
        editor.execute({
            operations: [
                { operation: "write", path: "a.ts", content: "new" },
                { operation: "delete", path: "missing" },
            ],
        }),
    ).rejects.toThrow();
    expect(await text()).toBe(original);
    const result = await editor.execute({
        operations: [
            {
                operation: "edit",
                path: "a.ts",
                changes: [
                    { type: "replace", target: "hello", content: "greetings" },
                ],
            },
            { operation: "create", path: "new.ts", content: "new" },
        ],
    });
    expect(result.diff).toContain("--- a/a.ts");
    expect(result.changedFiles).toEqual(["a.ts", "new.ts"]);
    expect(await text()).toBe("greetings\r\nworld 🌍\r\n");
    await editor.checkpoints.undo();
    expect(await text()).toBe(original);
    expect(await Bun.file(path.join(ws.root, "new.ts")).exists()).toBe(false);
    await ws.read("a.ts");
    await editor.execute({ operation: "delete", path: "a.ts" });
    await editor.checkpoints.undo();
    expect(await text()).toBe(original);
});
test("write failure rolls back earlier changes and preserves unrelated work", async () => {
    await writeFile(path.join(ws.root, "b.ts"), "before");
    await ws.read("b.ts");
    let writes = 0;
    const store = new CheckpointStore(
        ws,
        path.join(root, "faults"),
        async (...args) => {
            if (++writes === 2) throw new Error("simulated disk failure");
            await atomicText(...args);
        },
    );
    const failing = new SafeEditor(ws, store);
    const original = await text();
    await expect(
        failing.execute({
            operations: [
                { operation: "write", path: "a.ts", content: "after" },
                { operation: "write", path: "b.ts", content: "after" },
            ],
        }),
    ).rejects.toThrow("disk failure");
    expect(await text()).toBe(original);
    expect((await store.list())[0]?.status).toBe("rolled_back");
});
test("undo refuses subsequent user edits before changing any file", async () => {
    await editor.execute({
        operations: [
            { operation: "write", path: "a.ts", content: "after" },
            { operation: "create", path: "new.ts", content: "new" },
        ],
    });
    await writeFile(path.join(ws.root, "a.ts"), "user change");
    await expect(editor.checkpoints.undo()).rejects.toThrow("Restore conflict");
    expect(await text()).toBe("user change");
    expect(await Bun.file(path.join(ws.root, "new.ts")).text()).toBe("new");
});
test("restart recovers a pending transaction without replaying edits", async () => {
    const original = await text();
    await mkdir(editor.checkpoints.directory, { recursive: true });
    await writeFile(
        path.join(
            editor.checkpoints.directory,
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json",
        ),
        JSON.stringify({
            version: 1,
            id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            createdAt: new Date().toISOString(),
            status: "pending",
            changes: [{ path: "a.ts", before: original, after: "interrupted" }],
        }),
    );
    await writeFile(path.join(ws.root, "a.ts"), "interrupted");
    await new CheckpointStore(ws, editor.checkpoints.directory).recover();
    expect(await text()).toBe(original);
});
