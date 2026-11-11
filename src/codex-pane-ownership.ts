import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { relative, isAbsolute, join } from "node:path";

/** Runtime-only binding. Never reconstructed from durable delivery evidence after a restart. */
export interface CodexPaneCheckpoint {
  path: string;
  offset: number;
  sessionId: string;
  identity: { dev: number; ino: number };
  validateFile(): Promise<boolean>;
}

const HEADER_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function bounded<T>(work: () => Promise<T>, cancel?: () => void): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => { cancel?.(); resolve(null); }, 250);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Dedicated async discovery: no shared synchronous walk, stats or mtime sorting on the pane-write lane.
// A capped/incomplete tree supplies no uniqueness proof. One draining discovery per directory prevents timeout overlap.
const discovering = new Set<string>();
const DISCOVERY_ENTRIES = 20_000;
const DISCOVERY_DIRS = 512;
const DISCOVERY_DEPTH = 8;
async function discover(root: string, id: string, active: () => boolean): Promise<string | null> {
  const queue = [{ path: root, depth: 0 }];
  let entries = 0;
  let match: string | null = null;
  for (let at = 0; at < queue.length; at++) {
    if (!active()) return null;
    const item = queue[at];
    const dir = await opendir(item.path, { bufferSize: 32 });
    try {
      if (!active()) return null;
      for (;;) {
        if (!active()) return null;
        const entry = await dir.read();
        if (!active()) return null;
        if (!entry) break;
        if (++entries > DISCOVERY_ENTRIES || entry.isSymbolicLink()) return null;
        if (entries % 64 === 0) {
          await new Promise<void>(resolve => setImmediate(resolve));
          if (!active()) return null;
        }
        const path = join(item.path, entry.name);
        if (entry.isDirectory()) {
          if (item.depth >= DISCOVERY_DEPTH || queue.length >= DISCOVERY_DIRS) return null;
          queue.push({ path, depth: item.depth + 1 });
        } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${id}.jsonl`)) {
          if (match) return null;
          match = path;
        }
      }
    } finally {
      await dir.close();
    }
  }
  return match;
}

/** Exact observed thread id, not the newest file for a cwd. All reads are byte-bounded. */
export async function checkpointCodexPane(
  sessionsDir: string,
  sessionId: string,
  cwd: string,
): Promise<CodexPaneCheckpoint | null> {
  if (discovering.has(sessionsDir)) return null;
  discovering.add(sessionsDir);
  let active = true;
  return bounded(async () => {
    try { return await readCheckpoint(sessionsDir, sessionId, cwd, () => active); }
    finally { discovering.delete(sessionsDir); }
  }, () => { active = false; });
}

async function readCheckpoint(
  sessionsDir: string,
  sessionId: string,
  cwd: string,
  active: () => boolean,
): Promise<CodexPaneCheckpoint | null> {
  if (!UUID.test(sessionId)) return null;
  try {
    const path = await discover(sessionsDir, sessionId, active);
    if (!path || !active()) return null;
    const root = await realpath(sessionsDir),
      canonical = await realpath(path);
    const rel = relative(root, canonical);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) return null;
    const expectedCwd = await realpath(cwd);
    const inspect = async (requireComplete = false) => {
      const st = await lstat(path);
      if (
        !st.isFile() ||
        !Number.isSafeInteger(st.size) ||
        !Number.isSafeInteger(st.ino) ||
        !Number.isSafeInteger(st.dev)
      )
        return null;
      const fh = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const opened = await fh.stat();
        if (!opened.isFile() || opened.ino !== st.ino || opened.dev !== st.dev)
          return null;
        const buf = Buffer.alloc(Math.min(opened.size, HEADER_BYTES));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const nl = buf.subarray(0, bytesRead).indexOf(10);
        if (nl < 0) return null;
        const header = buf.subarray(0, nl).toString("utf8");
        const meta = JSON.parse(header);
        // Older recorded root TUI sessions use vscode; object-valued sources are child sessions.
        if (
          meta.type !== "session_meta" ||
          meta.payload?.id !== sessionId ||
          !["cli", "vscode"].includes(meta.payload?.source) ||
          meta.payload.parent_thread_id ||
          (meta.payload.thread_source != null &&
            meta.payload.thread_source !== "user") ||
          typeof meta.payload.cwd !== "string" ||
          (await realpath(meta.payload.cwd)) !== expectedCwd
        )
          return null;
        const size = opened.size;
        // EOF must be a complete pre-write boundary: never finish somebody else's partial record after our paste.
        if (requireComplete) {
          const last = Buffer.alloc(1);
          const read = await fh.read(last, 0, 1, size - 1);
          if (read.bytesRead !== 1 || last[0] !== 10) return null;
        }
        const after = await lstat(path);
        if (
          !after.isFile() ||
          after.ino !== st.ino ||
          after.dev !== st.dev ||
          after.size < size
        )
          return null;
        return { identity: { dev: st.dev, ino: st.ino }, header, offset: size };
      } finally {
        await fh.close();
      }
    };
    const first = await inspect(true);
    if (!first || !active()) return null;
    let retired = false;
    let pending: Promise<boolean> | null = null;
    return {
      path,
      sessionId,
      offset: first.offset,
      identity: first.identity,
      async validateFile() {
        if (retired) return false;
        if (pending) return pending;
        pending = (async () => {
          try {
            // A timed-out physical read can finish and close, but the retired lease can never start a second one.
            const next = await bounded(() => inspect());
            if (
              next &&
              next.identity.dev === first.identity.dev &&
              next.identity.ino === first.identity.ino &&
              next.header === first.header &&
              next.offset >= first.offset
            )
              return true;
          } catch {
            /* a lost binding never revives */
          }
          retired = true;
          return false;
        })().finally(() => {
          pending = null;
        });
        return pending;
      },
    };
  } catch {
    return null;
  }
}
