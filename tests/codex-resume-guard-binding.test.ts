/**
 * #1025 review: the resume-loading hold must be bound to AgEnD's own launch
 * state, not to pane text alone. A transcript that quotes the loading screen,
 * with its leading rows scrolled away and no footer, is byte-identical to the
 * real 0.159 loading frame, so no pane regex can tell them apart. The daemon
 * therefore honours the transient only while its own state says a load can be
 * on screen: a resume launch, before the real load has been seen to end, before
 * the session was seen settled, and not after a stall.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";
import { Daemon } from "../src/daemon.js";
import { TmuxManager } from "../src/tmux-manager.js";
import Database from "better-sqlite3";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const LOADING = readFileSync(join(fixtures, "codex-0159-resume-loading.pane.txt"), "utf8");
const IDLE = readFileSync(join(fixtures, "codex-0159-idle.pane.txt"), "utf8");
/** A transcript quoting the loading screen, cropped: identical to the real frame. */
const CROPPED_QUOTE = LOADING;
/** Settled but without an idle footer the backend recognises (status_line without Context). */
const IDLE_NO_FOOTER = IDLE.replace(/\n {2}Context 99% left[^\n]*/, "");

const dirs: string[] = [];
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = { AGEND_HOME: process.env.AGEND_HOME, CODEX_HOME: process.env.CODEX_HOME }; });
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function daemonAfterSpawn() {
  const dir = mkdtempSync(join(tmpdir(), "agend-guard-binding-"));
  dirs.push(dir);
  process.env.AGEND_HOME = join(dir, "agend");
  process.env.CODEX_HOME = join(dir, "codex-home");
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  mkdirSync(join(dir, "instance"), { recursive: true });
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const backend = new CodexBackend(join(dir, "instance"));
  const daemon = new Daemon("codex-guard", {
    working_directory: dir, backend: "codex", log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, join(dir, "instance"), false, backend as any, undefined, { child: () => logger } as any) as any;
  // What beginSpawn() does for a backend that declares a transient.
  daemon.spawnGeneration++;
  daemon.inputTransientGuardGeneration = daemon.spawnGeneration;
  const held = (pane: string) => daemon.inputTransientInPane(pane) !== null;
  return { daemon, backend, held, dir };
}

describe("the resume-loading hold follows AgEnD's launch state, not pane text alone", () => {
  it("holds the real 0.159 loading frame on a resume spawn", () => {
    const { held } = daemonAfterSpawn();
    expect(held(LOADING)).toBe(true);
    expect(held(LOADING)).toBe(true); // repeated frames of the same load keep holding
  });

  it("once the real load has been seen to end, the same screen is a quote and is not held", () => {
    const { held } = daemonAfterSpawn();
    expect(held(LOADING)).toBe(true);
    expect(held(IDLE_NO_FOOTER)).toBe(false); // the load ended (no footer needed)
    expect(held(CROPPED_QUOTE)).toBe(false);
  });

  it("a settled-looking pane before the load does not retire it (0.154 painted the prompt first)", () => {
    const { held } = daemonAfterSpawn();
    expect(held(IDLE)).toBe(false);
    // The resume phase can still be painted after a ready-looking frame.
    expect(held(LOADING)).toBe(true);
  });

  it("a fresh launch never honours it: only a resume shows 'Resuming session…'", async () => {
    const { daemon, backend } = daemonAfterSpawn();
    daemon.skipResume = true;
    vi.spyOn(TmuxManager, "ensureSession").mockRejectedValue(new Error("stop after the command is built"));
    await expect(daemon.trySpawnInsideGate()).rejects.toThrow(/stop after the command/);
    expect(backend.launchMayShowInputTransient()).toBe(false);
    expect(daemon.inputTransientInPane(CROPPED_QUOTE)).toBeNull();
  });

  it("a resume launch keeps it armed", async () => {
    const { daemon, backend, dir } = daemonAfterSpawn();
    // A real 0.157 session row for this working directory, so the plan is `resume <id>`.
    const real = JSON.parse(readFileSync(join(fixtures, "codex-real-threads.json"), "utf8"));
    const db = new Database(join(process.env.CODEX_HOME!, "state_5.sqlite"));
    db.exec(readFileSync(join(fixtures, "codex-0157-state5-schema.sql"), "utf8"));
    const row = { ...real.rows.resumable_0157, cwd: dir, rollout_path: join(dir, "rollout.jsonl") };
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO threads (${cols.join(", ")}) VALUES (${cols.map(c => `@${c}`).join(", ")})`).run(row);
    db.close();
    daemon.skipResume = false;
    vi.spyOn(TmuxManager, "ensureSession").mockRejectedValue(new Error("stop after the command is built"));
    await expect(daemon.trySpawnInsideGate()).rejects.toThrow(/stop after the command/);
    expect(backend.launchMayShowInputTransient()).toBe(true);
    expect(daemon.inputTransientInPane(LOADING)).not.toBeNull();
  });

  it("a 'transient' frozen for the whole stall window fails that wait, then stops holding", async () => {
    vi.useFakeTimers();
    const { daemon, held } = daemonAfterSpawn();
    daemon.tmux = { capturePane: async () => CROPPED_QUOTE };
    const wait = daemon.waitForInputTransientToClear("pre-write");
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(wait).resolves.toBe(false);
    expect(held(CROPPED_QUOTE)).toBe(false);
  });

  it("after it retires, an unreadable pane still stalls out instead of reading as clear", async () => {
    vi.useFakeTimers();
    const { daemon, held } = daemonAfterSpawn();
    expect(held(LOADING)).toBe(true);
    expect(held(IDLE_NO_FOOTER)).toBe(false); // retired: the load was seen to end
    daemon.tmux = { capturePane: async () => { throw new Error("capture-pane: no such pane"); } };
    const wait = daemon.waitForInputTransientToClear("pre-write");
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(wait).resolves.toBe(false);
  });

  it("the delivery-readiness wait applies the same stall rule", async () => {
    vi.useFakeTimers();
    const { daemon, held } = daemonAfterSpawn();
    daemon.tmux = { capturePane: async () => CROPPED_QUOTE };
    daemon.waitForPaneIdleForDelivery = async () => true;
    const wait = daemon.waitForPaneReadyForDelivery("@1", 5 * 60_000);
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(wait).resolves.toBe(false);
    expect(held(CROPPED_QUOTE)).toBe(false);
  });
});
