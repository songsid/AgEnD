/** #3810: positive consumption only, from the exact Grok UUID selected at launch. No cwd discovery or raw-text proof. */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

let inspections = 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Identity = { dev: number; ino: number };
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
export interface GrokDeliveryProof {
  sessionId: string;
  current(): boolean;
  /** null permanently retires the lease; an absent first updates file is an empty delta, never proof. */
  readChunk(offset: number, limit: number): Promise<{ chunk: Buffer; size: number } | null>;
}

/** Recorded on 1.0.77 after Enter, before the model answer; drafts/assistant chunks/turn completion are not input. */
export function grokConsumedMarker(text: string, sessionId: string, marker: string): "user" | null {
  if (!UUID.test(sessionId) || !/^\[agend-delivery-id:[^\]\r\n]+\]$/.test(marker)) return null;
  for (const line of text.split(/\r?\n/)) {
    try {
      const r = JSON.parse(line), u = r?.params?.update;
      if (r.method === "session/update" && r.params?.sessionId === sessionId
        && u?.sessionUpdate === "user_message_chunk" && u.content?.type === "text"
        && typeof u.content.text === "string" && u.content.text.startsWith(marker)) return "user";
    } catch { /* partial, malformed, or unknown records prove nothing */ }
  }
  return null;
}

/** Fixed-path async bounded inspection. No session-directory enumeration and no CLI process is started. */
export async function checkpointGrokDelivery(input: {
  sessionId: string | null; cwd: string; current(): boolean; home?: string;
}): Promise<{ backend: "grok"; path: string; offset: number; sessionId: string; ownedGrok: GrokDeliveryProof } | null> {
  const sessionId = input.sessionId;
  if (!sessionId || !UUID.test(sessionId) || !input.current() || inspections >= 2) return null;
  inspections++;
  let retired = false;
  const current = () => !retired && input.current();
  const retire = () => { retired = true; return null; };
  const grokHome = input.home ? join(input.home, ".grok") : process.env.GROK_HOME || join(homedir(), ".grok");
  const dir = join(grokHome, "sessions", encodeURIComponent(input.cwd), sessionId);
  const path = join(dir, "updates.jsonl");
  const inspect = async () => {
    const canonical = await realpath(dir), directory = await lstat(dir);
    if (!current() || !directory.isDirectory() || directory.isSymbolicLink()) return null;
    // Grok rewrites the summary. Read only its small, non-secret identity fields through a no-follow descriptor.
    const summary = await open(join(dir, "summary.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = await summary.stat();
      if (!s.isFile() || s.size > 16 * 1024) return null;
      const data = Buffer.alloc(s.size);
      const { bytesRead } = await summary.read(data, 0, data.length, 0);
      const value = JSON.parse(data.subarray(0, bytesRead).toString("utf8"));
      if (!current() || value?.info?.id !== sessionId || value?.info?.cwd !== input.cwd) return null;
    } finally { await summary.close(); }
    let identity: Identity | null = null;
    const readChunk: GrokDeliveryProof["readChunk"] = async (offset, limit) => {
      if (!current() || !Number.isSafeInteger(offset) || offset < 0 || limit < 1 || limit > 256 * 1024) return retire();
      let fh;
      try {
        const beforeDir = await lstat(dir);
        if (!current() || !same(directory, beforeDir) || !beforeDir.isDirectory() || await realpath(dir) !== canonical) return retire();
        try { fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
        catch (err: any) {
          if (err.code === "ENOENT" && !identity && offset === 0 && current()) return { chunk: Buffer.alloc(0), size: 0 };
          return retire();
        }
        const before = await fh.stat();
        if (!current() || !before.isFile() || (identity && !same(identity, before)) || before.size < offset) return retire();
        identity ??= { dev: before.dev, ino: before.ino };
        const chunk = Buffer.alloc(Math.min(limit, before.size - offset));
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, offset);
        const after = await lstat(path), afterDir = await lstat(dir);
        if (!current() || !after.isFile() || !same(identity, after) || after.size < offset + bytesRead
          || !same(directory, afterDir) || await realpath(dir) !== canonical) return retire();
        return { chunk: chunk.subarray(0, bytesRead), size: before.size };
      } catch { return retire(); }
      finally { await fh?.close().catch(() => {}); }
    };
    // Lease the existing inode and complete EOF before paste. A first-turn session has no updates file yet.
    let offset = 0;
    try {
      const s = await lstat(path);
      if (!s.isFile() || s.isSymbolicLink()) return retire();
      offset = s.size;
      const last = await readChunk(Math.max(0, offset - 1), 1);
      if (!last || last.size !== offset || (offset > 0 && last.chunk[0] !== 10)) return retire();
    } catch (err: any) { if (err.code !== "ENOENT") return retire(); }
    if (!current()) return null;
    return { backend: "grok" as const, path, offset, sessionId, ownedGrok: { sessionId, current, readChunk } };
  };
  // The timeout retires an in-flight inspection; late completion can never publish a usable lease.
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([inspect().catch(() => retire()).finally(() => { inspections--; }), new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(retire()), 250); timer.unref?.();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
