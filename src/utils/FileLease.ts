import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Prevent two REXA processes from writing the same state concurrently. */
export async function acquireFileLease(
    filename: string,
): Promise<() => Promise<void>> {
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const owner = { pid: process.pid, token: randomUUID() };

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            await writeFile(filename, JSON.stringify(owner), {
                flag: "wx",
                mode: 0o600,
            });
            return async () => {
                const saved = JSON.parse(await readFile(filename, "utf8"));
                if (saved.token === owner.token) {
                    await unlink(filename);
                }
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }

            const saved = JSON.parse(await readFile(filename, "utf8"));
            if (!Number.isInteger(saved.pid) || saved.pid <= 0) {
                throw new Error(
                    `Invalid lock file: ${filename}. Inspect it before removing it.`,
                );
            }

            try {
                process.kill(saved.pid, 0);
                throw new Error(
                    `State is in use by process ${saved.pid}. Close that session first.`,
                );
            } catch (probeError) {
                if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") {
                    throw probeError;
                }
                await unlink(filename);
            }
        }
    }

    throw new Error(
        "Could not acquire state lock. Another process may be opening it.",
    );
}
