import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { AssistantSavedState, AssistantStateStore } from "./service.js";

/** Small non-secret config/counter store, independent of fleet.yaml and of the selected account's credentials. */
export function assistantStateStore(home: string): AssistantStateStore {
  if (!isAbsolute(home)) throw new Error("Room assistant state home must be absolute");
  const path = join(home, "assistant-state.json");
  return {
    async load() {
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024) throw new Error("Invalid room assistant state file");
        const text = await readFile(path, "utf8");
        if (Buffer.byteLength(text) > 32 * 1024) throw new Error("Room assistant state exceeds its limit");
        const value: unknown = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid room assistant state");
        return value as AssistantSavedState;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async save(value) {
      const body = JSON.stringify(value) + "\n";
      if (Buffer.byteLength(body) > 32 * 1024) throw new Error("Room assistant state exceeds its limit");
      await mkdir(home, { recursive: true, mode: 0o700 });
      const info = await lstat(home);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid room assistant state home");
      const temp = join(home, `.assistant-${randomUUID()}.tmp`);
      let file;
      try {
        file = await open(temp, "wx", 0o600);
        await file.writeFile(body); await file.sync(); await file.close(); file = undefined;
        await rename(temp, path);
        // Directory durability is best effort after rename, as in atomic-write.ts.
        try { const directory = await open(home, "r"); try { await directory.sync(); } finally { await directory.close(); } } catch { /* platform may not support directory sync */ }
      } finally {
        await file?.close();
        await unlink(temp).catch(() => {});
      }
    },
  };
}
