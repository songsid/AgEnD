/**
 * #3647: telling a card's dispatcher when its assignee stops (src/dispatcher-liveness.ts, scheduler/task-liveness.ts).
 * Each trigger and each suppression of the judgement; the sweep against a real ledger (one notice per episode, the
 * "working again" line, withdrawal, no repeat across a fleet restart, no storm when 40+ agents restart).
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  DispatcherLiveness, judgeAssignee, livenessSettings, stillStopped, LIVENESS_STARTUP_GRACE_MS,
  type AssigneeFacts, type DispatcherLivenessDeps, type LivenessCard,
} from "../src/dispatcher-liveness.js";
import { LivenessLedger } from "../src/scheduler/task-liveness.js";
import { validateFleetConfig as validateFleet } from "../src/config-validator.js";

const MIN = 60_000;
const S = livenessSettings(null);
const T0 = 1_800_000_000_000;
const card = { claimedAt: T0, updatedAt: T0 };
const idle = (since = T0): AssigneeFacts => ({ process: "running", execution: { state: "idle", since } });

describe("judgeAssignee: each trigger", () => {
  it("defaults: on, quiet 60, prompt 10, crash grace 5", () => {
    expect(S).toEqual({ enabled: true, quietMs: 60 * MIN, promptMs: 10 * MIN, crashGraceMs: 5 * MIN });
  });
  it("supervision gave up (crash loop / supervision ended): at once", () => {
    expect(judgeAssignee({ process: "crashed", gone: { kind: "crash_loop", reason: "respawn paused", at: T0 } }, card, S, T0)?.kind).toBe("gone");
  });
  it("crashed: only once it has not come back for the grace (auto-respawn usually fixes it)", () => {
    const f: AssigneeFacts = { process: "crashed", crashedAt: T0 };
    expect(judgeAssignee(f, card, S, T0 + 5 * MIN - 1)).toBeNull();
    expect(judgeAssignee(f, card, S, T0 + 5 * MIN)?.kind).toBe("crashed");
  });
  it("paused for sign-in, usage hold, error back-off: at once", () => {
    expect(judgeAssignee({ process: "running", paused: { reason: "auth", at: T0 } }, card, S, T0)?.kind).toBe("auth");
    expect(judgeAssignee({ process: "running", usageHold: { model: "opus", since: T0 } }, card, S, T0)).toMatchObject({ kind: "usage", detail: "opus" });
    expect(judgeAssignee({ process: "running", paused: { reason: "error", at: T0 } }, card, S, T0)?.kind).toBe("error");
  });
  it("hung (the hang detector's stuck state): at once", () => {
    expect(judgeAssignee({ process: "running", execution: { state: "stuck", since: T0 } }, card, S, T0)?.kind).toBe("hung");
  });
  it("a prompt nobody answers: after 10 min", () => {
    const f: AssigneeFacts = { process: "running", execution: { state: "idle", since: T0 }, prompt: { since: T0 } };
    expect(judgeAssignee(f, card, S, T0 + 10 * MIN - 1)).toBeNull();
    expect(judgeAssignee(f, card, S, T0 + 10 * MIN)?.kind).toBe("prompt");
  });
  it("quiet: idle with the card claimed and no progress for 60 min", () => {
    expect(judgeAssignee(idle(), card, S, T0 + 60 * MIN - 1)).toBeNull();
    expect(judgeAssignee(idle(), card, S, T0 + 60 * MIN)).toMatchObject({ kind: "quiet", since: T0 });
    // paused for being idle counts as idle
    expect(judgeAssignee({ process: "running", paused: { reason: "idle", at: T0 } }, card, S, T0 + 60 * MIN)?.kind).toBe("quiet");
  });
  it("the worst news wins", () => {
    const f: AssigneeFacts = { process: "running", paused: { reason: "auth", at: T0 }, execution: { state: "stuck", since: T0 } };
    expect(judgeAssignee(f, card, S, T0)?.kind).toBe("auth");
  });
});

describe("judgeAssignee: each suppression", () => {
  const late = T0 + 600 * MIN;
  it("working is never quiet", () => {
    expect(judgeAssignee({ process: "running", execution: { state: "working", since: T0 } }, card, S, late)).toBeNull();
  });
  it("progress resets the quiet clock: a card update, a message, a working edge", () => {
    expect(judgeAssignee(idle(), { claimedAt: T0, updatedAt: late - MIN }, S, late)).toBeNull();
    expect(judgeAssignee({ ...idle(), lastMessageAt: late - MIN }, card, S, late)).toBeNull();
    expect(judgeAssignee({ ...idle(), lastWorkingAt: late - MIN }, card, S, late)).toBeNull();
  });
  it("waiting on a reply it asked for is not quiet", () => {
    expect(judgeAssignee({ ...idle(), waitingOn: ["reviewer"] }, card, S, late)).toBeNull();
  });
  it("stopped by a person, paused by an operator: no notice", () => {
    expect(judgeAssignee({ process: "stopped" }, card, S, late)).toBeNull();
    // stopped while idle, or with a prompt still on screen: still theirs to know, not a quiet or prompt notice (Fable L12)
    expect(judgeAssignee({ process: "stopped", execution: { state: "idle", since: T0 } }, card, S, late)).toBeNull();
    expect(judgeAssignee({ process: "stopped", execution: { state: "idle", since: T0 }, prompt: { since: T0 } }, card, S, late)).toBeNull();
    expect(judgeAssignee({ process: "running", paused: { reason: "operator", at: T0 } }, card, S, late)).toBeNull();
  });
  it("an unknown execution state never alarms", () => {
    expect(judgeAssignee({ process: "running" }, card, S, late)).toBeNull();
  });
  it("thresholds come from defaults.task_board.liveness; junk falls back to the default", () => {
    const s = livenessSettings({ defaults: { task_board: { liveness: { quiet_minutes: 30, prompt_minutes: 0, crash_grace_minutes: "x", enabled: false } } } });
    expect(s).toEqual({ enabled: false, quietMs: 30 * MIN, promptMs: 10 * MIN, crashGraceMs: 5 * MIN });
  });
});

describe("stillStopped: recovery needs positive evidence", () => {
  it("quiet stays quiet across a fleet restart (the idle clock starting again is not progress)", () => {
    const ep = { kind: "quiet" as const, since: T0 };
    expect(stillStopped(ep, idle(T0 + 90 * MIN), card)).toBe(true);
    expect(stillStopped(ep, { ...idle(T0 + 90 * MIN), lastWorkingAt: T0 + 91 * MIN }, card)).toBe(false);
    expect(stillStopped(ep, { process: "running", execution: { state: "working", since: T0 + 91 * MIN } }, card)).toBe(false);
    expect(stillStopped(ep, idle(), { claimedAt: T0, updatedAt: T0 + 1 })).toBe(false);
  });
  it("the other kinds end when their state does", () => {
    expect(stillStopped({ kind: "crashed", since: T0 }, { process: "running" }, card)).toBe(false);
    expect(stillStopped({ kind: "auth", since: T0 }, { process: "running", paused: { reason: "auth", at: T0 } }, card)).toBe(true);
    expect(stillStopped({ kind: "prompt", since: T0 }, { process: "running" }, card)).toBe(false);
  });
});

/** A fleet in miniature: cards, facts and the outbox as maps; the clock moved by hand. */
function rig(opts: { cards?: LivenessCard[]; startedAt?: number; ledger?: LivenessLedger } = {}) {
  const db = new Database(":memory:");
  const ledger = opts.ledger ?? new LivenessLedger(db);
  let now = T0;
  const facts = new Map<string, AssigneeFacts>();
  const cards: LivenessCard[] = opts.cards ?? [];
  const outbox = new Map<string, { to: string; text: string; state: string }>();
  const busy = new Set<string>();
  const away = new Set<string>();
  let planned = false, enabled = true;
  const deps: DispatcherLivenessDeps = {
    settings: () => ({ ...S, enabled }),
    plannedRestart: () => planned,
    startedAt: () => opts.startedAt ?? T0 - 24 * 60 * MIN,
    claimedCards: () => cards,
    facts: (n) => facts.get(n) ?? null,
    backgroundBusy: async (n) => busy.has(n),
    isInstance: (n) => n !== "gone-leader",
    dispatcherAway: (n) => away.has(n),
    deliver: (to, text, key) => { if (!outbox.has(key)) outbox.set(key, { to, text, state: "queued" }); return true; },
    withdraw: (prefix, stale) => { let n = 0; for (const [k, v] of outbox) if (k.startsWith(prefix) && stale(k) && v.state === "queued") { v.state = "cancelled"; n++; } return n; },
    noticeState: (k) => outbox.get(k)?.state ?? null,
    personChanged: () => { personPokes++; },
    ledger, now: () => now, log: () => {},
  };
  let personPokes = 0;
  const live = new DispatcherLiveness(deps);
  return {
    ledger, facts, cards, outbox, busy, away, live,
    at: (ms: number) => { now = ms; },
    tick: () => live.tick(),
    sent: () => [...outbox.values()].filter((v) => v.state !== "cancelled"),
    deliverAll: () => { for (const v of outbox.values()) if (v.state === "queued") v.state = "delivered"; },
    set planned(v: boolean) { planned = v; }, set enabled(v: boolean) { enabled = v; },
    get personPokes() { return personPokes; },
  };
}
const claimed = (code: string, assignee: string, dispatcher: LivenessCard["dispatcher"] = { kind: "instance", name: "leader" }): LivenessCard =>
  ({ uuid: `uuid-${code}`, code, title: `Work ${code}`, assignee, dispatcher, claimedAt: T0, updatedAt: T0 });

describe("the sweep (real ledger)", () => {
  it("today's shape: an idle agent with a claimed card → one notice at 60 min, nothing more; working again → one line", async () => {
    const r = rig({ cards: [claimed("M-1", "sentinel")] });
    r.facts.set("sentinel", idle());
    r.at(T0 + 59 * MIN); await r.tick();
    expect(r.sent()).toHaveLength(0);
    r.at(T0 + 60 * MIN); await r.tick();
    expect(r.sent()).toHaveLength(1);
    expect(r.sent()[0]).toMatchObject({ to: "leader" });
    expect(r.sent()[0]!.text).toMatch(/^\[Task board\] M-1 "Work M-1" — its assignee sentinel has been quiet for 1 h 00 min/);
    for (const m of [61, 90, 300]) { r.at(T0 + m * MIN); await r.tick(); }
    expect(r.sent()).toHaveLength(1);                               // one per episode
    r.deliverAll();
    r.facts.set("sentinel", { ...idle(), lastWorkingAt: T0 + 301 * MIN });
    r.at(T0 + 302 * MIN); await r.tick();
    expect(r.sent()).toHaveLength(2);
    expect(r.sent()[1]!.text).toBe('[Task board] M-1 "Work M-1": its assignee sentinel is working again.');
    r.at(T0 + 303 * MIN); await r.tick();
    expect(r.sent()).toHaveLength(2);
    expect(r.ledger.listOpen()).toHaveLength(0);
  });

  it("recovered before the notice was read: the notice is withdrawn, no 'working again' line", async () => {
    const r = rig({ cards: [claimed("M-2", "ridge")] });
    r.facts.set("ridge", idle());
    r.at(T0 + 60 * MIN); await r.tick();
    r.facts.set("ridge", { process: "running", execution: { state: "working", since: T0 + 61 * MIN } });
    r.at(T0 + 61 * MIN); await r.tick();
    expect(r.sent()).toHaveLength(0);
    expect([...r.outbox.values()][0]!.state).toBe("cancelled");
  });

  it("the stop notice was cancelled or failed (never read): no 'working again' line (Fable L7)", async () => {
    for (const lost of ["cancelled", "failed"]) {
      const r = rig({ cards: [claimed("M-15", "m")] });
      r.facts.set("m", idle());
      r.at(T0 + 60 * MIN); await r.tick();
      for (const v of r.outbox.values()) v.state = lost;              // the outbox gave up on it
      r.facts.set("m", { ...idle(), lastWorkingAt: T0 + 61 * MIN });
      r.at(T0 + 62 * MIN); await r.tick();
      expect([...r.outbox.values()].some((v) => /working again/.test(v.text)), lost).toBe(false);
      expect(r.ledger.listOpen()).toHaveLength(0);
    }
  });

  it("a notice the outbox does not take is tried again on the next sweep — never lost for the episode (Fable review)", async () => {
    const r = rig({ cards: [claimed("M-16", "n")] });
    r.facts.set("n", idle());
    const deps = (r.live as any).deps as DispatcherLivenessDeps;
    const real = deps.deliver;
    let fail = 1;
    deps.deliver = (to: string, text: string, key: string) => { if (fail-- > 0) throw new Error("SQLITE_BUSY"); return real(to, text, key); };
    r.at(T0 + 60 * MIN); await r.tick();
    expect(r.sent()).toHaveLength(0);
    expect(r.ledger.listOpen()).toHaveLength(0);                     // no episode yet
    r.at(T0 + 61 * MIN); await r.tick();
    expect(r.sent()).toHaveLength(1);
    expect(r.ledger.get("uuid-M-16")?.noticeKey).toMatch(/^task-liveness:leader:/);
    r.at(T0 + 62 * MIN); await r.tick();
    expect(r.sent()).toHaveLength(1);
  });

  it("background work the pane does not show (a live subagent) keeps quiet from being told", async () => {
    const r = rig({ cards: [claimed("M-3", "web-claude")] });
    r.facts.set("web-claude", idle());
    r.busy.add("web-claude");
    r.at(T0 + 120 * MIN); await r.tick();
    expect(r.sent()).toHaveLength(0);
    expect(r.ledger.listOpen()).toHaveLength(0);
  });

  it("planned restarts and the startup grace judge nothing", async () => {
    const r = rig({ cards: [claimed("M-4", "a")] });
    r.facts.set("a", { process: "crashed", gone: { kind: "crash_loop", reason: "x", at: T0 } });
    r.planned = true; r.at(T0 + MIN); await r.tick();
    expect(r.sent()).toHaveLength(0);
    const g = rig({ cards: [claimed("M-4", "a")], startedAt: T0 });
    g.facts.set("a", { process: "crashed", gone: { kind: "crash_loop", reason: "x", at: T0 } });
    g.at(T0 + LIVENESS_STARTUP_GRACE_MS - 1); await g.tick();
    expect(g.sent()).toHaveLength(0);
    g.at(T0 + LIVENESS_STARTUP_GRACE_MS); await g.tick();
    expect(g.sent()).toHaveLength(1);
  });

  it("a fleet restart with 45 agents: no storm — open episodes are not told again nor read as recovered", async () => {
    const names = Array.from({ length: 45 }, (_, i) => `agent-${i}`);
    const cards = names.map((n, i) => claimed(`M-${100 + i}`, n));
    const before = rig({ cards });
    for (const n of names) before.facts.set(n, idle());
    before.at(T0 + 60 * MIN); await before.tick();
    expect(before.sent()).toHaveLength(1);                           // all one dispatcher: ONE gathered message
    expect(before.sent()[0]!.text).toMatch(/^\[Task board\] The assignees of 45 of the cards you handed out stopped:/);
    before.deliverAll();
    // the fleet restarts at T0+70: a new process, the same ledger; every agent idle again since its start
    const restartAt = T0 + 70 * MIN;
    const after = rig({ cards, startedAt: restartAt, ledger: before.ledger });
    for (const n of names) after.facts.set(n, idle(restartAt + MIN));
    for (let m = 0; m <= 200; m += 1) { after.at(restartAt + m * MIN); await after.tick(); }
    expect(after.sent()).toHaveLength(0);
    expect(after.ledger.listOpen()).toHaveLength(45);
  });

  it("a fleet restart without earlier episodes: still at most one message per dispatcher, after the threshold", async () => {
    const names = Array.from({ length: 45 }, (_, i) => `agent-${i}`);
    const dispatchers = ["leader", "coordinator", "sol"];
    const restartAt = T0;
    const r = rig({ cards: names.map((n, i) => claimed(`M-${200 + i}`, n, { kind: "instance", name: dispatchers[i % 3]! })), startedAt: restartAt });
    for (const n of names) r.facts.set(n, idle(restartAt + MIN));
    for (let m = 0; m < 61; m++) { r.at(restartAt + m * MIN); await r.tick(); }
    expect(r.sent()).toHaveLength(0);
    r.at(restartAt + 61 * MIN); await r.tick();
    expect(r.sent().map((x) => x.to).sort()).toEqual(dispatchers.sort());
  });

  it("worse news replaces an episode; the card moving on ends it quietly", async () => {
    const r = rig({ cards: [claimed("M-5", "b")] });
    r.facts.set("b", idle());
    r.at(T0 + 60 * MIN); await r.tick();
    r.facts.set("b", { process: "crashed", gone: { kind: "supervision_ended", reason: "retries spent", at: T0 + 61 * MIN } });
    r.at(T0 + 61 * MIN); await r.tick();
    expect(r.sent().map((x) => x.text.includes("will not restart on its own"))).toContain(true);
    expect(r.ledger.get("uuid-M-5")?.kind).toBe("gone");
    r.cards.splice(0);                                               // done / reassigned
    r.at(T0 + 62 * MIN); await r.tick();
    expect(r.ledger.listOpen()).toHaveLength(0);
    expect(r.sent().some((x) => /working again/.test(x.text))).toBe(false);
  });

  it("one notice for two cards: one recovering does not withdraw the other's news", async () => {
    const r = rig({ cards: [claimed("M-6", "c"), claimed("M-7", "d")] });
    r.facts.set("c", idle()); r.facts.set("d", idle());
    r.at(T0 + 60 * MIN); await r.tick();
    expect(r.sent()).toHaveLength(1);
    r.facts.set("c", { ...idle(), lastWorkingAt: T0 + 61 * MIN });
    r.at(T0 + 62 * MIN); await r.tick();
    const states = [...r.outbox.values()].map((v) => v.state);
    expect(states[0]).toBe("queued");                                // still there for M-7
    expect(r.sent().some((x) => /M-6 "Work M-6": its assignee c is working again/.test(x.text))).toBe(true);
  });

  it("a person (or a missing) dispatcher: no chat notice, Needs you is poked", async () => {
    const r = rig({ cards: [claimed("M-8", "e", { kind: "person", name: "owner" }), claimed("M-9", "f", { kind: "instance", name: "gone-leader" })] });
    r.facts.set("e", idle()); r.facts.set("f", idle());
    r.at(T0 + 60 * MIN); await r.tick();
    expect(r.sent()).toHaveLength(0);
    expect(r.ledger.listOpen().map((e) => e.dispatcherKind)).toEqual(["person", "person"]);
    expect(r.personPokes).toBeGreaterThan(0);
  });

  it("a dispatcher that is not running (stopped, crashed, paused): the notice still waits for it, and Needs you is told too", async () => {
    const r = rig({ cards: [claimed("M-13", "j")] });
    r.facts.set("j", idle());
    r.away.add("leader");
    r.at(T0 + 60 * MIN); await r.tick();
    expect(r.sent()).toHaveLength(1);                                // queued for when it is back
    expect(r.ledger.get("uuid-M-13")).toMatchObject({ dispatcherKind: "instance", needsYou: true });
    expect(r.personPokes).toBeGreaterThan(0);
    // a running dispatcher: no Needs you flag
    const q = rig({ cards: [claimed("M-14", "k")] });
    q.facts.set("k", idle());
    q.at(T0 + 60 * MIN); await q.tick();
    expect(q.ledger.get("uuid-M-14")?.needsYou).toBe(false);
  });

  it("no dispatcher, or the assignee's own card: nobody else to tell", async () => {
    const r = rig({ cards: [claimed("M-10", "g", null), claimed("M-11", "h", { kind: "instance", name: "h" })] });
    r.facts.set("g", idle()); r.facts.set("h", idle());
    r.at(T0 + 120 * MIN); await r.tick();
    expect(r.sent()).toHaveLength(0);
  });

  it("switched off: nothing is told", async () => {
    const r = rig({ cards: [claimed("M-12", "i")] });
    r.facts.set("i", { process: "crashed", gone: { kind: "crash_loop", reason: "x", at: T0 } });
    r.enabled = false; r.at(T0 + MIN); await r.tick();
    expect(r.sent()).toHaveLength(0);
  });
});

describe("the ledger", () => {
  it("a table made by an earlier build (no needs_you column) is brought up to date and keeps its episodes", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE task_liveness (card_uuid TEXT PRIMARY KEY, assignee TEXT NOT NULL, dispatcher TEXT NOT NULL, dispatcher_kind TEXT NOT NULL,
      kind TEXT NOT NULL, since INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '', notice TEXT, notified_at INTEGER NOT NULL)`);
    db.prepare("INSERT INTO task_liveness VALUES ('u1','a','lead','instance','quiet',1,'','k',2)").run();
    const ledger = new LivenessLedger(db);
    expect(ledger.get("u1")).toMatchObject({ kind: "quiet", needsYou: false });
    ledger.open({ cardUuid: "u2", assignee: "b", dispatcher: "lead", dispatcherKind: "instance", kind: "gone", since: 3, detail: "", noticeKey: null, notifiedAt: 4, needsYou: true });
    expect(ledger.get("u2")?.needsYou).toBe(true);
  });
});

describe("config", () => {
  const fleet = (liveness: unknown) => ({ defaults: { task_board: { liveness } }, instances: {} });
  it("accepts the thresholds; refuses out-of-range minutes, a non-boolean switch and unknown keys", () => {
    expect(validateFleet(fleet({ enabled: true, quiet_minutes: 60, prompt_minutes: 10, crash_grace_minutes: 5 })).errors.filter((e) => e.path.includes("liveness"))).toEqual([]);
    const bad = validateFleet(fleet({ enabled: "yes", quiet_minutes: 0, prompt_minutes: 2000, crash: 1 })).errors.filter((e) => e.path.includes("liveness")).map((e) => e.path);
    expect(bad.sort()).toEqual(["defaults.task_board.liveness.crash", "defaults.task_board.liveness.enabled", "defaults.task_board.liveness.prompt_minutes", "defaults.task_board.liveness.quiet_minutes"]);
  });
});

describe("the board's stale filter, Needs you, the zh-TW words", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { Scheduler } = await import("../src/scheduler/index.js");
  const { FleetManager } = await import("../src/fleet-manager.js");
  const { deriveNeedsYou } = await import("../src/needs-you.js");
  const { setLocale } = await import("../src/locale.js");

  it("task list with stale: true lists the claimed cards whose assignee stopped (the same episodes); refuses nothing else", async () => {
    const d = mkdtempSync(join(tmpdir(), "liveness-stale-"));
    try {
      writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
      const fm = new FleetManager(d);
      const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
      (fm as unknown as Record<string, unknown>).scheduler = scheduler;
      const db = scheduler.db;
      const ann = { kind: "person" as const, name: "Ann" };
      const { cards } = db.board.createCards(ann, { cards: [{ title: "Port the parser", assignee: "dev-a" }] }) as unknown as { cards: Array<{ uuid: string; code: string }> };
      const c = cards[0]!;
      db.board.updateCard({ kind: "instance", name: "dev-a" }, c.uuid, {});
      expect(await fm.handleTaskCrudHttp("lead", { action: "list", stale: true })).toBe("No claimed card has a stopped assignee.");
      scheduler.db.liveness.open({ cardUuid: c.uuid, assignee: "dev-a", dispatcher: "lead", dispatcherKind: "instance", kind: "quiet", since: Date.now() - 65 * MIN, detail: "", noticeKey: null, notifiedAt: Date.now() });
      // only a claimed card counts: claim it first
      db.updateTask(c.uuid, { status: "claimed" }, { kind: "instance", name: "dev-a" });
      expect(await fm.handleTaskCrudHttp("lead", { action: "list", stale: true })).toMatch(new RegExp(`^${c.code} — @dev-a: quiet with the card claimed \\(1 h 0[45] min\\)$`));
      scheduler.db.close();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("a stalled card is a Needs-you item under its assignee, with no buttons to press in chat", () => {
    const items = deriveNeedsYou({ prompts: [], instances: [], deliveries: [], ownerOf: () => undefined,
      tasks: [{ uuid: "u1", code: "M-3", title: "Port", status: "stalled", version: 2, assignee: "dev-a", since: T0, note: "quiet with the card claimed" }] });
    expect(items).toEqual([expect.objectContaining({ id: `task:u1:stalled:${T0}`, type: "task", instance: "dev-a", reason: "task_stalled" })]);
  });

  it("every liveness line exists in zh-TW", async () => {
    setLocale("zh-TW");
    try {
      const r = rig({ cards: [claimed("M-20", "dev-z")] });
      r.facts.set("dev-z", idle());
      r.at(T0 + 60 * MIN);
      await r.tick();
      {
        expect(r.sent()[0]!.text).toBe("[Task board] M-20 \"Work M-20\" — 接手的 dev-z 接了這張卡，已經 1 小時 00 分沒有動靜（閒置中：沒有更新卡片、沒有發訊息、也沒有使用工具）。你可以問它（send_to_instance）、喚醒它，或把卡改派給別人。查看：task get M-20");
      }
    } finally { setLocale("en"); }
  });
});

describe("the fleet's wiring", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { FleetManager } = await import("../src/fleet-manager.js");

  it("supervision giving up is remembered until the process runs again; boot-time working is not activity", async () => {
    const d = mkdtempSync(join(tmpdir(), "liveness-wire-"));
    try {
      writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
      const fm = new FleetManager(d) as unknown as Record<string, any>;
      fm.onSupervisionGone("dev-a", "crash_loop", "respawn paused after repeated crashes");
      expect(fm.livenessGone.get("dev-a")).toMatchObject({ kind: "crash_loop" });
      fm.cacheInstanceProcessStatus("dev-a", "running");
      expect(fm.livenessGone.has("dev-a")).toBe(false);
      fm.startedAt = Date.now();                                     // just started: working is the boot
      fm.cacheInstanceExecutionState("dev-a", { state: "working" });
      expect(fm.lastWorkingAt.has("dev-a")).toBe(false);
      fm.startedAt = Date.now() - LIVENESS_STARTUP_GRACE_MS;         // later: working is activity
      fm.cacheInstanceExecutionState("dev-a", { state: "idle" });
      fm.cacheInstanceExecutionState("dev-a", { state: "working" });
      expect(fm.lastWorkingAt.get("dev-a")).toBeGreaterThan(0);
      expect(fm.livenessFacts("not-an-instance")).toBeNull();
      // a quiet episode whose dispatcher was away is a Needs-you stall; one told to a running dispatcher is not
      const { Scheduler } = await import("../src/scheduler/index.js");
      const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
      fm.scheduler = scheduler;
      const ann = { kind: "person" as const, name: "Ann" };
      const made = scheduler.db.board.createCards(ann, { cards: [{ title: "Away case", assignee: "dev-a" }, { title: "Running case", assignee: "dev-b" }] }) as unknown as { cards: Array<{ uuid: string }> };
      made.cards.forEach((c, i) => scheduler.db.updateTask(c.uuid, { status: "claimed" }, { kind: "instance", name: i ? "dev-b" : "dev-a" }));
      const ep = (uuid: string, needsYou: boolean) => scheduler.db.liveness.open({ cardUuid: uuid, assignee: "x", dispatcher: "lead", dispatcherKind: "instance", kind: "quiet", since: 1, detail: "", noticeKey: "k", notifiedAt: 2, needsYou });
      ep(made.cards[0]!.uuid, true); ep(made.cards[1]!.uuid, false);
      expect(fm.needsYouStalls().map((t: { title: string }) => t.title)).toEqual(["Away case"]);
      scheduler.db.close();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("agents are told once", async () => {
  const { AGENT_WHATS_NEW } = await import("../src/agent-whats-new.js");
  it("a what's-new entry names the notice and task list stale: true, from the next beta", () => {
    const e = AGENT_WHATS_NEW.find((x) => x.id === "2.3.5-dispatcher-liveness");
    expect(e).toMatchObject({ since: "2.3.5-beta.6", tools: ["task"] });
    expect(e!.text).toContain("`stale: true`");
    expect(e!.text).toContain("AgEnD only tells");
  });
});
