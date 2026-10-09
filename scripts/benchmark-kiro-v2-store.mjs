/** #1417 fixture-only benchmark; baseline is the exact selector at 7b0a71a7. Run after npm run build. */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as tick } from "node:timers/promises";
import { kiroDirectoryKeys } from "../dist/backend/kiro-identity.js";
import { KiroV2StoreLane } from "../dist/backend/kiro-v2-store.js";
const EMPTY_STORE = { kind: "ok", sessions: [], createdAt: () => null };
function before(workingDirectory, sessionsDir) {
  let names;
  try { names = readdirSync(sessionsDir); } catch (err) {
    return err.code === "ENOENT" ? EMPTY_STORE
      : { kind: "unreadable", detail: `cannot list ${sessionsDir}: ${err.message}` };
  }
  const keys = new Set(kiroDirectoryKeys(workingDirectory));
  const sessions = [];
  const created = new Map();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const meta = JSON.parse(readFileSync(join(sessionsDir, name), "utf-8"));
      if (typeof meta.cwd !== "string" || !keys.has(meta.cwd) || meta.session_created_reason === "subagent") continue;
      const id = typeof meta.session_id === "string" ? meta.session_id : name.slice(0, -".json".length);
      sessions.push({ id, updatedAt: Date.parse(String(meta.updated_at ?? "")) || 0 });
      const at = Date.parse(String(meta.created_at ?? ""));
      created.set(id, Number.isFinite(at) ? at : null);
    } catch { /* partly written */ }
  }
  return { kind: "ok", sessions, createdAt: (id) => created.get(id) ?? null };
}

const scratch = mkdtempSync(join(process.cwd(), ".artifacts/kiro-v2-benchmark-"));
const dir = join(scratch, "sessions", "cli"), cwd = join(scratch, "work");
const lane = new KiroV2StoreLane();
mkdirSync(dir, { recursive: true }); mkdirSync(cwd);
try {
  for (let i = 0; i < 4; i++) writeFileSync(join(dir, `other-${i}.json`), JSON.stringify({ cwd: join(scratch, "other"), session_id: `other-${i}`, history: "x".repeat(16 * 1024 * 1024) }));
  writeFileSync(join(dir, "mine.json"), JSON.stringify({ cwd, session_id: "mine", updated_at: "2026-10-08T12:00:00Z", created_at: "2026-10-08T10:00:00Z" }));
  const measure = async (action) => {
    await tick(); let beats = 0, previous = performance.now(), maxGapMs = 0;
    const timer = setInterval(() => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - previous); previous = now; beats++; }, 1);
    const start = performance.now(); const result = await action(); const ms = performance.now() - start;
    maxGapMs = Math.max(maxGapMs, performance.now() - previous); clearInterval(timer);
    return { ms, maxGapMs, beats, result };
  };
  const old = [];
  for (let i = 0; i < 3; i++) { const r = await measure(() => before(cwd, dir)); old.push({ ms: r.ms, maxGapMs: r.maxGapMs, beats: r.beats }); }
  const cold = await measure(() => lane.read({ keys: kiroDirectoryKeys(cwd), sessionsDir: dir }));
  const warm = [];
  for (let i = 0; i < 3; i++) warm.push(await measure(() => lane.read({ keys: kiroDirectoryKeys(cwd), sessionsDir: dir })));
  if (cold.result.kind !== "ok" || cold.result.sessions[0]?.id !== "mine") throw new Error("selector mismatch");
  console.log(JSON.stringify({ fixture: { files: 5, unrelatedHistoryBytes: 64 * 1024 * 1024 },
    before: old, afterCold: cold, afterWarm: warm,
    note: "Wall time, not production attribution. One warm worker; full-body parse in worker, metadata-only cache. maxGap includes worker startup/GC and machine scheduling." }, null, 2));
} finally { lane.close(); rmSync(scratch, { recursive: true, force: true }); }
