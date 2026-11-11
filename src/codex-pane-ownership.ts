import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import { sharedRolloutIndex } from "./rollout-index.js";

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

async function bounded<T>(work: Promise<T>): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 250);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Exact observed thread id, not the newest file for a cwd. All reads are byte-bounded. */
export async function checkpointCodexPane(
  sessionsDir: string,
  sessionId: string,
  cwd: string,
): Promise<CodexPaneCheckpoint | null> {
  return bounded(readCheckpoint(sessionsDir, sessionId, cwd));
}

async function readCheckpoint(
  sessionsDir: string,
  sessionId: string,
  cwd: string,
): Promise<CodexPaneCheckpoint | null> {
  if (!UUID.test(sessionId)) return null;
  try {
    const index = sharedRolloutIndex(sessionsDir);
    const files = index
      .list(true)
      .filter((file) => file.path.endsWith(`-${sessionId}.jsonl`));
    if (index.unreadable || files.length !== 1) return null;
    const path = files[0].path;
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
    if (!first) return null;
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
            const next = await bounded(inspect());
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
