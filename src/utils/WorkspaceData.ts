import path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

/** Stable private storage location for a project, outside its working tree. */
export function workspaceDataDirectory(root: string): string {
    const absoluteRoot = path.resolve(root);
    const workspaceId = createHash("sha256")
        .update(absoluteRoot)
        .digest("hex")
        .slice(0, 24);
    return path.join(homedir(), ".rexa", "workspaces", workspaceId);
}
