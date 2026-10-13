/**
 * #1753: a Claude Code credential-profile switch takes the conversation along — the session's transcript and its folder
 * copied (never moved) into the new profile's `projects/<cwd key>/`, dated the newest there so the relaunch's
 * `--continue` picks it; the old profile's original untouched, so switching back still works. Anything that cannot be
 * done leaves the target as it was and falls back to the fresh start with a handover, saying why.
 *
 * Real files in scratch dirs; the restart and the handler with their own collaborators faked at the edges.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { carryClaudeConversation } from "../src/backend/claude-carry.js";
import { claudeProjectKey } from "../src/backend/claude-code.js";
import { credentialSwitchCarriesConversation } from "../src/backend/credential-profile.js";
import { outboundHandlers, type OutboundContext } from "../src/outbound-handlers.js";

const SID = "38875b68-1cbc-4cb3-942c-9fe07036a6db";
const OTHER = "fa5ebaad-2e25-4b3d-ab10-0072a8da21aa";
const dirs: string[] = [];
function tempDir(): string { const d = mkdtempSync(join(tmpdir(), "agend-1753-")); dirs.push(d); return d; }
afterEach(() => {
  for (const d of dirs.splice(0)) { try { chmodSync(d, 0o755); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); }
  vi.restoreAllMocks();
});

/** Two config dirs and a working directory; the old one holds the session (transcript, folder, file history). */
function world(opts: { transcript?: string } = {}) {
  const root = tempDir();
  const work = join(root, "work"); mkdirSync(work);
  const from = join(root, "default"), to = join(root, "profiles", "team");
  const key = claudeProjectKey(work);
  const fromProj = join(from, "projects", key), toProj = join(to, "projects", key);
  mkdirSync(join(fromProj, SID, "tool-results"), { recursive: true });
  writeFileSync(join(fromProj, `${SID}.jsonl`), opts.transcript ?? lines(3));
  writeFileSync(join(fromProj, SID, "tool-results", "r1.txt"), "tool output");
  mkdirSync(join(from, "file-history", SID), { recursive: true });
  writeFileSync(join(from, "file-history", SID, "snap@v1"), "before");
  return { root, work, from, to, fromProj, toProj, key };
}
const lines = (n: number, from = 0) => Array.from({ length: n }, (_, i) => JSON.stringify({ type: "user", sessionId: SID, uuid: `u${from + i}`, message: "x".repeat(100) }) + "\n").join("");
const carry = (w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) =>
  carryClaudeConversation({ sessionId: SID, workingDirectory: w.work, fromConfigDir: w.from, toConfigDir: w.to, freeBytes: async () => 1e12, ...extra });
const hidden = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(".")) : []);

describe("the copy: the same bytes, the newest transcript there, the original untouched", () => {
  it("copies the transcript, its folder and its file history; dates it past every other transcript; the original keeps its bytes and its date", async () => {
    const w = world();
    mkdirSync(w.toProj, { recursive: true });
    writeFileSync(join(w.toProj, `${OTHER}.jsonl`), lines(1));
    const ahead = Date.now() / 1000 + 3600;   // another transcript dated an hour ahead of this clock
    utimesSync(join(w.toProj, `${OTHER}.jsonl`), ahead, ahead);
    const original = join(w.fromProj, `${SID}.jsonl`);
    const before = [readFileSync(original, "utf8"), statSync(original).mtimeMs];

    const r = await carry(w);

    const copy = join(w.toProj, `${SID}.jsonl`);
    expect([r.carried, readFileSync(copy, "utf8") === before[0], statSync(copy).mtimeMs > statSync(join(w.toProj, `${OTHER}.jsonl`)).mtimeMs,
      readFileSync(join(w.toProj, SID, "tool-results", "r1.txt"), "utf8"), readFileSync(join(w.to, "file-history", SID, "snap@v1"), "utf8"),
      [readFileSync(original, "utf8"), statSync(original).mtimeMs], existsSync(join(w.toProj, `${OTHER}.jsonl`)), hidden(w.toProj)])
      .toEqual([true, true, true, "tool output", "before", before, true, []]);
  });

  it("switching back (A → B → A): an older copy of the same conversation is replaced by the grown one; other sessions stay", async () => {
    const w = world({ transcript: lines(5) });
    mkdirSync(join(w.toProj, SID), { recursive: true });
    writeFileSync(join(w.toProj, `${SID}.jsonl`), lines(3));               // what this profile had before it was left
    writeFileSync(join(w.toProj, SID, "own.txt"), "kept");
    writeFileSync(join(w.toProj, `${OTHER}.jsonl`), lines(1, 50));

    const r = await carry(w);

    expect([r.carried && r.replacedOlderCopy, readFileSync(join(w.toProj, `${SID}.jsonl`), "utf8") === lines(5),
      readFileSync(join(w.toProj, SID, "own.txt"), "utf8"), readFileSync(join(w.toProj, SID, "tool-results", "r1.txt"), "utf8"),
      readFileSync(join(w.toProj, `${OTHER}.jsonl`), "utf8") === lines(1, 50)]).toEqual([true, true, "kept", "tool output", true]);
  });
});

describe("what cannot be carried leaves the target as it was, and says why", () => {
  it("no session id, a malformed one, no transcript in the old profile, the same config dir", async () => {
    const w = world();
    const reasons = [
      await carry(w, { sessionId: null }), await carry(w, { sessionId: "../../etc/passwd" }),
      await carry(w, { sessionId: OTHER }), await carry(w, { toConfigDir: w.from }),
    ].map((r) => (r.carried ? "carried" : r.reason));
    expect([reasons, existsSync(w.toProj) ? readdirSync(w.toProj) : []]).toEqual([
      ["no session id to carry", "no session id to carry", "the session's transcript is not in the old profile", "same config dir"], []]);
  });

  it("a different version already in the new profile (longer, or not a prefix): untouched", async () => {
    const out = [];
    for (const theirs of [lines(9), lines(2, 7)]) {
      const w = world({ transcript: lines(3) });
      mkdirSync(w.toProj, { recursive: true });
      writeFileSync(join(w.toProj, `${SID}.jsonl`), theirs);
      const r = await carry(w);
      out.push([r.carried ? "carried" : r.reason, readFileSync(join(w.toProj, `${SID}.jsonl`), "utf8") === theirs]);
    }
    expect(out).toEqual([["the new profile already holds a different version of this conversation", true],
      ["the new profile already holds a different version of this conversation", true]]);
  });

  it("a version that starts the same but ends differently (past the first 64 KiB): untouched", async () => {
    const ours = lines(1000);                                    // ~120 KB
    const theirs = ours.slice(0, 79_900) + ours.slice(79_900, 80_000).replace(/x/g, "y");   // same start, other end
    const w = world({ transcript: ours });
    mkdirSync(w.toProj, { recursive: true });
    writeFileSync(join(w.toProj, `${SID}.jsonl`), theirs);
    const r = await carry(w);
    expect([theirs.slice(0, 65_536) === ours.slice(0, 65_536), theirs !== ours.slice(0, theirs.length), r.carried,
      readFileSync(join(w.toProj, `${SID}.jsonl`), "utf8") === theirs]).toEqual([true, true, false, true]);
  });

  it("not enough free space: nothing written", async () => {
    const w = world();
    const r = await carry(w, { freeBytes: async () => 1024 });
    expect([r.carried, !r.carried && r.reason.startsWith("not enough free space"), existsSync(join(w.toProj, `${SID}.jsonl`)), hidden(w.toProj)])
      .toEqual([false, true, false, []]);
  });

  it("a copy that fails half way: no transcript appears, no temporary file is left", async () => {
    const w = world();
    chmodSync(join(w.fromProj, SID, "tool-results"), 0o000);   // the folder cannot be read
    const r = await carry(w);
    chmodSync(join(w.fromProj, SID, "tool-results"), 0o755);
    expect([r.carried, !r.carried && r.reason.startsWith("copy failed"), existsSync(join(w.toProj, `${SID}.jsonl`)), hidden(w.toProj)])
      .toEqual([false, true, false, []]);
  });
});

describe("which backends carry", () => {
  it("claude-code does; kiro and codex keep their own handling", () => {
    expect(["claude-code", "kiro-cli", "codex", "opencode"].map(credentialSwitchCarriesConversation)).toEqual([true, false, false, false]);
  });
});

// ── The restart: between the old CLI's stop and the new one's start ─────────

describe("the restart carries between the stop and the start, or starts fresh", () => {
  async function restart(opts: { carryable: boolean; extraLine?: boolean }) {
    vi.resetModules();
    const { FleetManager } = await import("../src/fleet-manager.js");
    const w = world();
    const dataDir = tempDir();
    const fm: any = new FleetManager(dataDir);
    fm.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const instanceDir = join(dataDir, "instances", "worker");
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "session-id"), opts.carryable ? SID : OTHER);
    fm.getInstanceDir = () => instanceDir;
    fm.lifecycle.daemons.set("worker", { getConfigSnapshot: () => ({ working_directory: w.work }) });
    const order: string[] = [];
    // The CLI writes its last line as it stops: the copy must come after it.
    fm.stopInstance = vi.fn(async () => { order.push("stop"); if (opts.extraLine) writeFileSync(join(w.fromProj, `${SID}.jsonl`), lines(4)); });
    fm.startAfterRestart = vi.fn(async () => { order.push(existsSync(join(instanceDir, "crash-state.json")) ? "start-fresh" : "start-resume"); });
    // The default login (CLAUDE_CONFIG_DIR) is the old profile, the named one the new.
    const credentialProfileHome = (await import("../src/backend/credential-profile.js")).credentialProfileHome;
    const team = credentialProfileHome(dataDir, "claude-code", "team");
    mkdirSync(team, { recursive: true });
    const prevEnv = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = w.from;
    const carryOpts = { carry: { backend: "claude-code", from: null, to: "team", result: null as any } };
    // The configuration the restart launches: the switch is saved before its restart (update_instance_config).
    try { await fm.doRestartWithSlot("worker", carryOpts, {}, { working_directory: w.work, backend_options: { "claude-code": { credential_profile: "team" } } }, false); }
    finally {
      if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevEnv;
      fm.lifecycle.daemons.delete("worker"); fm.stormWindow.shutdown(); fm.spawnGate.shutdown();
    }
    const copy = join(team, "projects", w.key, `${SID}.jsonl`);
    return { order, result: carryOpts.carry.result, copied: existsSync(copy) ? readFileSync(copy, "utf8") : null };
  }

  it("carried: copied after the stop (with the CLI's last line), no fresh-start marker — the new CLI resumes", async () => {
    const r = await restart({ carryable: true, extraLine: true });
    expect([r.order, r.result?.carried, r.copied === lines(4)]).toEqual([["stop", "start-resume"], true, true]);
  });

  it("not carried (the session is not there): the fresh-start marker, and the reason handed back", async () => {
    const r = await restart({ carryable: false });
    expect([r.order, r.result?.carried, r.result?.reason]).toEqual([["stop", "start-fresh"], false, "the session's transcript is not in the old profile"]);
  });
});

describe("a switch whose restart joins one already in flight (Fable P3, #1758)", () => {
  /** A real restartSingleInstance whose restart is held at the stop or at the start until the test lets it go on. */
  async function rig() {
    vi.resetModules();
    const { FleetManager } = await import("../src/fleet-manager.js");
    const w = world();
    const dataDir = tempDir();
    const fm: any = new FleetManager(dataDir);
    fm.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const instanceDir = join(dataDir, "instances", "worker");
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "session-id"), SID);
    fm.getInstanceDir = () => instanceDir;
    // What the restart in flight launches (it reads the configuration when it begins): by default the switch's "team".
    const launches = (profile: string | null) => { fm.fleetConfig = { defaults: {}, instances: { worker: { working_directory: w.work, ...(profile ? { backend_options: { "claude-code": { credential_profile: profile } } } : {}) } } }; };
    launches("team");
    fm.lifecycle.daemons.set("worker", { getConfigSnapshot: () => ({ working_directory: w.work }) });
    const gate = (label: string) => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { label, p, open }; };
    const stop = gate("stop"), start = gate("start");
    const order: string[] = [];
    fm.stopInstance = vi.fn(async () => { order.push("stop"); await stop.p; });
    fm.startAfterRestart = vi.fn(async () => { order.push(existsSync(join(instanceDir, "crash-state.json")) ? "start-fresh" : "start-resume"); await start.p; });
    fm.doRestartSingleInstance = (name: string, opts: any, transition: any) => fm.doRestartWithSlot(name, opts, transition, fm.fleetConfig.instances[name], false);
    const team = (await import("../src/backend/credential-profile.js")).credentialProfileHome(dataDir, "claude-code", "team");
    mkdirSync(team, { recursive: true });
    const prevEnv = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = w.from;
    const done = () => {
      if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevEnv;
      fm.lifecycle.daemons.delete("worker"); fm.stormWindow.shutdown(); fm.spawnGate.shutdown();
    };
    const copied = () => existsSync(join(team, "projects", w.key, `${SID}.jsonl`));
    const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
    /** A ClassicBot room instead (not in fleet.yaml): its login is the room's, as the classic start reads it. */
    const classic = (profile: string | null) => {
      fm.fleetConfig = { defaults: {}, instances: {} };
      fm.classicChannels = {
        getChannelIdByInstance: () => "room", getAdapterIdByInstance: () => "owner", getBackendByInstance: () => "claude-code",
        getCredentialProfileByInstance: () => (profile ? { state: "profile", name: profile } : { state: "shared" }),
        getPreTaskCommand: () => undefined, getModel: () => undefined, getAutoPauseAfter: () => undefined,
      };
      vi.useFakeTimers({ toFake: ["setTimeout"] }); // the classic branch waits 1 s for tmux between stop and start
    };
    return { fm, stop, start, order, done, copied, flush, launches, classic, gaps: () => fm.restartGaps.size };
  }
  const switchOpts = (to = "team") => ({ carry: { backend: "claude-code", from: null, to, result: null as any } });

  it("joined before the restart's stop is done: carried in that restart's gap — the new CLI resumes it", async () => {
    const r = await rig();
    try {
      const first = r.fm.restartSingleInstance("worker");               // e.g. an MCP revival, no switch
      await r.flush();
      const sw = switchOpts();
      const joined = r.fm.restartSingleInstance("worker", sw);
      r.stop.open(); r.start.open();
      await Promise.all([first, joined]);
      expect([r.order, sw.carry.result?.carried, r.copied(), r.gaps()]).toEqual([["stop", "start-resume"], true, true, 0]);
    } finally { r.done(); }
  });

  it("joined after the restart's stop → start gap: not carried, and said so (the CLI is already starting without it)", async () => {
    const r = await rig();
    try {
      const first = r.fm.restartSingleInstance("worker");
      r.stop.open(); await r.flush();                                     // past the gap: the start is under way
      const sw = switchOpts();
      const joined = r.fm.restartSingleInstance("worker", sw);
      r.start.open();
      await Promise.all([first, joined]);
      expect([sw.carry.result, r.copied()]).toEqual([{ carried: false, reason: "joined a restart in flight past its stop" }, false]);
    } finally { r.done(); }
  });

  it("joined a restart that launches the OLD login (it read the configuration before the switch was saved): not carried, said so — no false \"carried\"; the old conversation resumes", async () => {
    const r = await rig();
    try {
      r.launches(null);
      const first = r.fm.restartSingleInstance("worker");
      await r.flush();
      const sw = switchOpts();
      const joined = r.fm.restartSingleInstance("worker", sw);
      r.stop.open(); r.start.open();
      await Promise.all([first, joined]);
      expect([sw.carry.result, r.copied(), r.order]).toEqual([{ carried: false, reason: 'the restart launches the default login, not profile "team"' }, false, ["stop", "start-resume"]]);
    } finally { r.done(); }
  });

  it("a restart that launches a third login: not carried, said so, and a fresh start (no older copy is resumed)", async () => {
    const r = await rig();
    try {
      r.launches("other");
      const first = r.fm.restartSingleInstance("worker");
      await r.flush();
      const sw = switchOpts();
      const joined = r.fm.restartSingleInstance("worker", sw);
      r.stop.open(); r.start.open();
      await Promise.all([first, joined]);
      expect([sw.carry.result, r.copied(), r.order]).toEqual([{ carried: false, reason: 'the restart launches profile "other", not profile "team"' }, false, ["stop", "start-fresh"]]);
    } finally { r.done(); }
  });

  it("a ClassicBot room's restart: carried when the room launches the switch's login, refused when it launches another", async () => {
    const out: unknown[] = [];
    for (const room of ["team", null]) {
      const r = await rig();
      try {
        r.classic(room);
        const sw = switchOpts();
        const run = r.fm.restartSingleInstance("worker", sw);
        r.stop.open(); r.start.open();
        await r.flush(); await vi.advanceTimersByTimeAsync(1_000); await r.flush();
        await run;
        out.push([sw.carry.result?.carried, sw.carry.result?.carried ? null : sw.carry.result?.reason, r.copied()]);
      } finally { vi.useRealTimers(); r.done(); }
    }
    expect(out).toEqual([[true, null, true], [false, 'the restart launches the default login, not profile "team"', false]]);
  });

  it("joined while the restart carries another switch: not carried, and said so; the first switch's carry runs", async () => {
    const r = await rig();
    try {
      const firstSw = switchOpts("team");
      const first = r.fm.restartSingleInstance("worker", firstSw);
      await r.flush();
      const second = switchOpts("other");
      const joined = r.fm.restartSingleInstance("worker", second);
      r.stop.open(); r.start.open();
      await Promise.all([first, joined]);
      expect([firstSw.carry.result?.carried, second.carry.result]).toEqual([true, { carried: false, reason: "a restart in flight carries another switch" }]);
    } finally { r.done(); }
  });
});

// ── The handler: what the switch asks for, and what it says ─────────────────

function harness(instance: Record<string, unknown>, restartResult: (opts: any) => void) {
  const dataDir = tempDir();
  const login = (p: string) => {
    const d = join(dataDir, "credential-profiles", "claude-code", p); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t" } }));
  };
  login("team");
  const delivered: Array<Record<string, unknown>> = [];
  const daemons = new Map([["worker", { collectHandoverContext: () => "Recent user messages:\n- finish the migration" }]]);
  const restartSingleInstance = vi.fn(async (_n: string, opts: any) => { daemons.delete("worker"); restartResult(opts); });
  const ctx = {
    dataDir, fleetConfig: { defaults: {}, instances: { worker: instance } }, classicChannels: { getAll: () => [] },
    saveFleetConfig: vi.fn(), restartSingleInstance, lifecycle: { daemons, isPaused: () => false },
    instanceIpcClients: new Map([["worker", { send: (m: Record<string, unknown>) => { delivered.push(m); } }]]),
    getInstanceStatus: () => "running", logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as OutboundContext;
  return { ctx, restartSingleInstance, delivered };
}
async function update(ctx: OutboundContext, config: unknown): Promise<Record<string, any> | null> {
  let result: Record<string, any> | null = null;
  let settled!: () => void;
  const done = new Promise<void>((r) => { settled = r; });
  await outboundHandlers.get("update_instance_config")!(ctx, { name: "worker", config } as never, (r) => { result = r as Record<string, any>; settled(); }, {} as never);
  await Promise.race([done, new Promise((r) => setTimeout(r, 6_000))]);
  return result;
}

describe("update_instance_config: a claude-code profile switch asks the restart to carry", () => {
  it("carried: no handover; the reply says it came along and that the next reply re-reads it", async () => {
    const h = harness({ working_directory: "/tmp/w", backend: "claude-code" }, (opts) => { opts.carry.result = { carried: true, sessionId: SID, bytes: 10, ms: 1, replacedOlderCopy: false }; });
    const r = await update(h.ctx, { backend_options: { "claude-code": { credential_profile: "team" } } });
    expect([h.restartSingleInstance.mock.calls[0]?.[1]?.carry && { ...h.restartSingleInstance.mock.calls[0][1].carry, result: undefined }, h.delivered.length,
      r?.conversation_carried_over, /re-reads it from a cold cache/.test(String(r?.conversation_note)), "handover_chars" in (r ?? {})])
      .toEqual([{ backend: "claude-code", from: null, to: "team", result: undefined }, 0, true, true, false]);
  });

  it("not carried: the handover as before, and the reason", async () => {
    const h = harness({ working_directory: "/tmp/w", backend: "claude-code" }, (opts) => { opts.carry.result = { carried: false, reason: "not enough free space" }; });
    const r = await update(h.ctx, { backend_options: { "claude-code": { credential_profile: "team" } } });
    expect([h.delivered.length, String(h.delivered[0]?.content).includes("finish the migration"), r?.conversation_carried_over, r?.carry_failed, r?.handover_chars > 0])
      .toEqual([1, true, false, "not enough free space", true]);
  }, 10_000);

  it("no profile change: nothing carried, resumes as usual; a backend switch: a fresh start, nothing carried", async () => {
    const same = harness({ working_directory: "/tmp/w", backend: "claude-code", backend_options: { "claude-code": { credential_profile: "team" } } }, () => {});
    await update(same.ctx, { backend_options: { "claude-code": { credential_profile: "team", future_option: "on" } } });
    const backend = harness({ working_directory: "/tmp/w", backend: "codex" }, () => {});
    await update(backend.ctx, { backend: "claude-code", backend_options: { "claude-code": { credential_profile: "team" } } });
    expect([same.restartSingleInstance.mock.calls[0]?.[1], backend.restartSingleInstance.mock.calls[0]?.[1]]).toEqual([undefined, { freshStart: true }]);
  }, 15_000);
});
