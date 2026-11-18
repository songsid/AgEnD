import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { snapshotReplyFile } from "./web-reply-files.js";
export interface ContactFileLease { paths: string[]; dispose(): Promise<void> }
/** Snapshot the opened file, not a pathname that an adapter will follow after an async network wait. */
export async function stageContactFiles(paths: readonly string[], home: string, ownInbox: string): Promise<ContactFileLease> {
  if (paths.length > 20 || paths.some(path => typeof path !== "string" || !path)) throw Error("Invalid room attachments");
  const directory = await mkdtemp(join(tmpdir(), "agend-room-files-"));
  const staged: string[] = [];
  const dispose = async () => { await rm(directory, { recursive: true, force: true }); };
  try {
    for (const path of paths) {
      const result = await snapshotReplyFile(path, directory, randomBytes(16).toString("hex"), {
        stateDir: home, allowedRoots: [ownInbox], maxFileBytes: 20 * 1024 * 1024, maxDirBytes: 400 * 1024 * 1024,
      });
      if (!result.ok) throw Error("Restricted room attachments must be regular files in this room's own inbox or scratch; links and owner files are refused");
      staged.push(result.path);
    }
    return { paths: staged, dispose };
  } catch (error) { await dispose(); throw error; }
}
