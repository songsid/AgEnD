import { statSync } from "node:fs";
import { readFileTail } from "../log-tail.js";
import { codexProcessCwd, cwdCandidates, openCodexStateReadonly, rolloutSessionMeta } from "./codex-session-lookup.js";

/** Reuse the selected row, not a recursive directory walk on every normal resume. */
export function snapshotCodexSessionQuotaHistory(dbPath: string, cwd: string, id: string): ReturnType<typeof snapshotCodexQuotaHistory> {
  let db: ReturnType<typeof openCodexStateReadonly> | undefined;
  try {
    db = openCodexStateReadonly(dbPath);
    const candidates = cwdCandidates(cwd);
    const row = db.prepare(`SELECT rollout_path FROM threads WHERE id = ? AND cwd IN (${candidates.map(() => "?").join(",")}) AND source = 'cli' AND archived = 0`)
      .get(id, ...candidates) as { rollout_path?: unknown } | undefined;
    if (typeof row?.rollout_path !== "string") return null;
    const meta = rolloutSessionMeta(row.rollout_path);
    if (!meta || meta.id.toLowerCase() !== id.toLowerCase() || meta.cwd !== codexProcessCwd(cwd) || meta.source !== "cli") return null;
    return snapshotCodexQuotaHistory(row.rollout_path);
  } catch { return null; } finally { try { db?.close(); } catch { /* already closed */ } }
}

/** Only complete, timestamped CLI error records present BEFORE the resume command was built. */
export function snapshotCodexQuotaHistory(path: string): { messages: readonly string[]; current(): boolean } | null {
  try {
    const before = statSync(path, { bigint: true });
    const signature = (s: typeof before) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    if (!before.isFile()) return null;
    const at = Date.now();
    const messages: string[] = [];
    // A missing older record gives no exemption. Never read an unbounded conversation.
    for (const line of readFileTail(path, 256 * 1024).lines) {
      let e;
      try { e = JSON.parse(line); } catch { return null; }
      const p = e?.payload;
      const written = Date.parse(e?.timestamp);
      if (e?.type === "event_msg" && p?.type === "task_complete"
        && typeof p.turn_id === "string" && p.turn_id.length > 0
        && Number.isFinite(written) && written < at
        && p.error?.codex_error_info === "usage_limit_exceeded"
        && typeof p.error.message === "string" && /you['’]ve hit your usage limit/i.test(p.error.message)) {
        messages.push(p.error.message);
      }
    }
    const initial = signature(before);
    const current = () => {
      try { return signature(statSync(path, { bigint: true })) === initial; } catch { return false; }
    };
    return messages.length && current() ? { messages, current } : null;
  } catch { return null; }
}
