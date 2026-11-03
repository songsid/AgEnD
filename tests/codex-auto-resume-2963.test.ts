/**
 * #2963 (M-2266, the user's choice 「全自動接回」): a codex instance resumes its earlier conversation when codex's own
 * database no longer lists it but its rollout is still there, instead of only printing #1053's hint; if that resume
 * does not take, the next launch starts fresh once and says so, and never auto-picks it again. restart_instance gains
 * a validated one-shot `resume_session_id` for the next launch.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_RESUME_ATTEMPT_FILE, CODEX_RESUME_FAILED_FILE, CODEX_RESUME_LARGE_BYTES, CODEX_RESUME_NEXT_FILE, CodexBackend } from "../src/backend/codex.js";
import { checkResumeId, newestResumableRollout } from "../src/backend/codex-session-lookup.js";
import { setLocale } from "../src/locale.js";

const SCHEMA = readFileSync(fileURLToPath(new URL("./fixtures/codex-0157-state5-schema.sql", import.meta.url)), "utf8");
const OLD = "01a073e9-d457-7312-aef4-1b5afee014a7";
const TODAY = "01a19eef-4e8d-7012-b3d6-bbc441e5584f";
const OTHER = "019feff4-3ce1-7c23-a479-538b04b1dada";

let root: string, shared: string, ws: string, instanceDir: string;
const originalCodexHome = process.env.CODEX_HOME;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-2963-"));
  shared = join(root, "shared-codex-home");
  mkdirSync(join(shared, "sessions"), { recursive: true });
  process.env.CODEX_HOME = shared;
  ws = join(root, "ws"); mkdirSync(ws);
  instanceDir = join(root, "instances", "worker"); mkdirSync(instanceDir, { recursive: true });
});
afterEach(() => {
  setLocale("en");
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalCodexHome;
  rmSync(root, { recursive: true, force: true });
});

function rollout(id: string, cwd: string, opts: { source?: unknown; turn?: boolean; pad?: number } = {}): string {
  const dir = join(shared, "sessions", "2026", "09", "06"); mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-09-06T07-31-39-${id}.jsonl`);
  const lines = [
    { type: "session_meta", payload: { id, cwd, originator: "codex-tui", source: opts.source ?? "cli", cli_version: "0.153.4" } },
    ...(opts.turn === false ? [] : [{ type: "event_msg", payload: { type: "task_started" } }, { type: "response_item", payload: { type: "message", role: "assistant", content: [] } }]),
  ];
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join("\n") + "\n" + (opts.pad ? "x".repeat(opts.pad) : ""));
  return path;
}
function stateDb(rows: Array<{ id: string; cwd: string; recency?: number }> = []): void {
  const db = new Database(join(shared, "state_5.sqlite"));
  db.exec(SCHEMA);
  for (const r of rows) db.prepare(`INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
    sandbox_policy, approval_mode, has_user_event, first_user_message, archived, recency_at_ms, updated_at_ms)
    VALUES (?, '/r.jsonl', 1, 1, 'cli', 'openai', ?, 't', 'danger-full-access', 'never', 1, 'q', 0, ?, ?)`).run(r.id, r.cwd, r.recency ?? 1, r.recency ?? 1);
  db.close();
}
function launch() {
  const backend = new CodexBackend(instanceDir);
  const config = { workingDirectory: ws, instanceDir, instanceName: "worker", mcpServers: {}, peerWorkingDirectories: () => [] };
  backend.writeConfig(config);
  const cmd = backend.buildCommand(config);
  return { cmd, warning: backend.consumeLaunchWarning() };
}
const resumes = (cmd: string, id: string) => cmd.includes(` resume '${id}' `);
const fresh = (cmd: string) => !cmd.includes(" resume");

describe("#2963 auto-resume of a conversation codex's database no longer lists", () => {
  it("a DB row for this directory → unchanged: resume it, no notice, no attempt recorded", () => {
    stateDb([{ id: TODAY, cwd: ws }]);
    rollout(OLD, ws);
    const { cmd, warning } = launch();
    expect(resumes(cmd, TODAY)).toBe(true);
    expect(warning).toBeNull();
    expect(existsSync(join(instanceDir, CODEX_RESUME_ATTEMPT_FILE))).toBe(false);
  });

  it("no row, a qualifying rollout → `codex resume <id>`, the notice says so, the attempt is recorded", () => {
    stateDb();
    rollout(OLD, ws);
    const { cmd, warning } = launch();
    expect(resumes(cmd, OLD)).toBe(true);
    expect(warning).toBe(`Resumed the earlier Codex conversation for ${ws} (${OLD}): Codex's own list no longer showed it, but its record was still there.`);
    expect(JSON.parse(readFileSync(join(instanceDir, CODEX_RESUME_ATTEMPT_FILE), "utf8")).id).toBe(OLD);
  });

  it("no row, no rollout of this directory (or none with a turn, or not the CLI's) → fresh and quiet", () => {
    stateDb();
    rollout(OTHER, join(root, "elsewhere"));
    rollout(OLD, ws, { turn: false });
    rollout("01a0f048-a48e-7050-97c1-c79c1a2265d7", ws, { source: "vscode" });
    const { cmd, warning } = launch();
    expect(fresh(cmd)).toBe(true);
    expect(warning).toBeNull();
  });

  it("never another directory's rollout, even the newest", () => {
    stateDb();
    rollout(OTHER, join(root, "elsewhere"));
    expect(newestResumableRollout(join(shared, "sessions"), ws)).toBeNull();
  });

  it("a large rollout adds the compaction note", () => {
    stateDb();
    rollout(OLD, ws, { pad: CODEX_RESUME_LARGE_BYTES + 1024 });
    const { warning } = launch();
    expect(warning).toContain("It is long (20 MB), so Codex may compact it before it answers.");
  });

  it("the resume did not take (codex left no row) → the next launch starts fresh once, says so, and never auto-picks it again", () => {
    stateDb();
    rollout(OLD, ws);
    expect(resumes(launch().cmd, OLD)).toBe(true);                     // attempted; codex then exited ("No saved session…")
    const second = launch();
    expect(fresh(second.cmd)).toBe(true);
    expect(second.warning).toBe(`Codex could not resume the earlier conversation for ${ws} (${OLD}), so this launch started a NEW one. The earlier conversation is kept.`);
    expect(JSON.parse(readFileSync(join(instanceDir, CODEX_RESUME_FAILED_FILE), "utf8")).ids).toEqual([OLD]);
    const third = launch();                                            // no loop: fresh again, quietly
    expect([fresh(third.cmd), third.warning]).toEqual([true, null]);
  });

  it("the resume took (codex recorded the thread) → the next launch plans as usual", () => {
    stateDb();
    rollout(OLD, ws);
    expect(resumes(launch().cmd, OLD)).toBe(true);
    const db = new Database(join(shared, "state_5.sqlite"));            // what codex does as it opens the thread
    db.prepare(`INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode,
      has_user_event, first_user_message, archived, recency_at_ms, updated_at_ms) VALUES (?, '/r', 1, 1, 'cli', 'openai', ?, 't', 'x', 'never', 1, 'q', 0, 5, 5)`).run(OLD, ws);
    db.close();
    const next = launch();
    expect(resumes(next.cmd, OLD)).toBe(true);
    expect(next.warning).toBeNull();
    expect(existsSync(join(instanceDir, CODEX_RESUME_FAILED_FILE))).toBe(false);
  });

  it("zh-TW notices", () => {
    setLocale("zh-TW");
    stateDb();
    rollout(OLD, ws);
    expect(launch().warning).toBe(`找到並接回了 ${ws} 之前的 Codex 對話（${OLD}）：Codex 自己的清單已經沒有它，但紀錄還在。`);
    expect(launch().warning).toBe(`Codex 無法接回 ${ws} 之前的對話（${OLD}），所以這次啟動開了**新對話**。之前的對話仍保留。`);
  });
});

describe("#2963 the one-shot resume id (restart_instance resume_session_id)", () => {
  it("checkResumeId: valid; a bad id, an unknown one, another directory's, a non-CLI one are refused with the reason", () => {
    rollout(OLD, ws);
    rollout(OTHER, join(root, "elsewhere"));
    const s = join(shared, "sessions");
    expect(checkResumeId(s, ws, OLD)).toMatchObject({ ok: true, rollout: { id: OLD } });
    expect(checkResumeId(s, ws, "nope")).toEqual({ ok: false, reason: "bad-id" });
    expect(checkResumeId(s, ws, "01a00000-0000-7000-8000-000000000000")).toEqual({ ok: false, reason: "not-found" });
    expect(checkResumeId(s, ws, OTHER)).toEqual({ ok: false, reason: "other-cwd" });
    rollout("01a0f048-a48e-7050-97c1-c79c1a2265d7", ws, { source: "exec" });
    expect(checkResumeId(s, ws, "01a0f048-a48e-7050-97c1-c79c1a2265d7")).toEqual({ ok: false, reason: "not-cli" });
  });

  it("the next launch resumes the asked conversation over the database's newest, once; later launches are back to normal", () => {
    stateDb([{ id: TODAY, cwd: ws }]);
    rollout(OLD, ws);
    writeFileSync(join(instanceDir, CODEX_RESUME_NEXT_FILE), JSON.stringify({ id: OLD }));
    const first = launch();
    expect(resumes(first.cmd, OLD)).toBe(true);
    expect(first.warning).toBe(`Resumed the Codex conversation ${OLD} for ${ws}, as asked.`);
    expect(existsSync(join(instanceDir, CODEX_RESUME_NEXT_FILE)), "consumed").toBe(false);
    // codex recorded it (it took), so the next launch plans as usual: the newest row.
    const db = new Database(join(shared, "state_5.sqlite"));
    db.prepare(`INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode,
      has_user_event, first_user_message, archived, recency_at_ms, updated_at_ms) VALUES (?, '/r', 1, 1, 'cli', 'openai', ?, 't', 'x', 'never', 1, 'q', 0, 0, 0)`).run(OLD, ws);
    db.close();
    expect(resumes(launch().cmd, TODAY)).toBe(true);
  });

  it("an id that no longer qualifies at launch → usual planning, and the notice says why", () => {
    stateDb([{ id: TODAY, cwd: ws }]);
    writeFileSync(join(instanceDir, CODEX_RESUME_NEXT_FILE), JSON.stringify({ id: OLD }));   // its rollout is gone
    const { cmd, warning } = launch();
    expect(resumes(cmd, TODAY)).toBe(true);
    expect(warning).toBe(`The Codex conversation asked for (${OLD}) cannot be resumed for ${ws} (not-found), so this launch resumes as usual.`);
  });
});

describe("#2963 restart_instance { resume_session_id }", () => {
  async function call(args: Record<string, unknown>, opts: { backend?: string } = {}) {
    const { outboundHandlers } = await import("../src/outbound-handlers.js") as any;
    const handler = outboundHandlers.get("restart_instance");
    const restarted: string[] = [];
    const ctx: any = {
      dataDir: root,
      fleetConfig: { instances: { worker: { working_directory: ws, backend: opts.backend ?? "codex" } }, defaults: {} },
      restartSingleInstance: vi.fn(async (name: string) => { restarted.push(name); }),
      logger: { warn() {}, info() {}, error() {}, debug() {} },
    };
    let result: unknown = undefined, error: unknown = undefined;
    await handler(ctx, args, (r: unknown, e?: unknown) => { result = r; error = e; });
    return { result, error, restarted };
  }

  it("a valid id: the one-shot is written for the next launch, then the instance restarts", async () => {
    rollout(OLD, ws);
    const r = await call({ name: "worker", resume_session_id: OLD });
    expect(r.error).toBeFalsy();
    expect(r.restarted).toEqual(["worker"]);
    expect(JSON.parse(readFileSync(join(instanceDir, CODEX_RESUME_NEXT_FILE), "utf8")).id).toBe(OLD);
  });

  it("a bad, unknown or other-directory id, or a non-codex instance → refused with the reason, nothing restarted, nothing written", async () => {
    rollout(OTHER, join(root, "elsewhere"));
    for (const [args, re] of [
      [{ name: "worker", resume_session_id: "01a00000-0000-7000-8000-000000000000" }, /no rollout with that id/],
      [{ name: "worker", resume_session_id: OTHER }, /another working directory/],
      [{ name: "nobody", resume_session_id: OLD }, /not a fleet instance/],
    ] as const) {
      const r = await call(args as Record<string, unknown>);
      expect(String(r.error), JSON.stringify(args)).toMatch(re);
      expect(r.restarted).toEqual([]);
    }
    const nc = await call({ name: "worker", resume_session_id: OLD }, { backend: "claude-code" });
    expect(String(nc.error)).toMatch(/codex instances only/);
    expect(nc.restarted).toEqual([]);
    expect(existsSync(join(instanceDir, CODEX_RESUME_NEXT_FILE))).toBe(false);
    const malformed = await call({ name: "worker", resume_session_id: "x; rm -rf /" });
    expect(malformed.error).toBeTruthy();
    expect(malformed.restarted).toEqual([]);
  });
});
