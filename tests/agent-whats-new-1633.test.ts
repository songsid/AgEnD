/**
 * #1633 (design: the comment on #1633): a one-time "what's new for you" notice per instance per AgEnD version — the
 * curated entries it has not been told, pasted ahead of its next real delivery (never into a busy turn), recorded once
 * pasted. New instances are told nothing. The real planner and record on a scratch dir; the real Daemon's prepare step
 * and its real delivery call site (pushChannelMessage → the delivery lock) with the pane write stubbed.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_WHATS_NEW, agendVersion, packageReleaseVersion, compareVersions, planWhatsNew, readWhatsNewRecord, recordWhatsNew, whatsNewNotice } from "../src/agent-whats-new.js";
import { Daemon } from "../src/daemon.js";
import type { TmuxManager } from "../src/tmux-manager.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-1633-")); dirs.push(d); return d; };
/** The entries current at 2.2.0-beta.2, the version these tests run as (later entries, e.g. #1780's, are not told yet). */
const ALL = AGENT_WHATS_NEW.filter(e => compareVersions(e.since, "2.2.0-beta.2")! <= 0).map(e => e.id);
const EVERY = AGENT_WHATS_NEW.map(e => e.id);
const announcedIn = (dir: string) => { const r = readWhatsNewRecord(dir); return r && r !== "unreadable" ? r.announced : r; };

describe("versions", () => {
  it("SemVer order with prereleases; not a version → null", () => {
    expect([
      compareVersions("2.2.0-beta.1", "2.2.0-beta.2"), compareVersions("2.2.0-beta.2", "2.2.0"), compareVersions("2.2.0", "2.2.0"),
      compareVersions("2.2.1", "2.2.0"), compareVersions("2.1.12", "2.2.0-beta.1"), compareVersions("2.2.0-beta.10", "2.2.0-beta.9"),
      compareVersions("2.2.0-alpha.6", "2.2.0-beta.1"), compareVersions("v2.2.0", "2.2.0"), compareVersions("unknown", "2.2.0"),
    ]).toEqual([-1, -1, 0, 1, -1, 1, -1, 0, null]);
  });
  it("the released version: a published package's; a source checkout (a .git beside package.json) has a placeholder → none (#1638 review)", () => {
    const released = scratch(), checkout = scratch();
    for (const d of [released, checkout]) writeFileSync(join(d, "package.json"), JSON.stringify({ name: "@songsid/agend", version: "2.2.0-beta.2" }));
    writeFileSync(join(checkout, ".git"), "gitdir: /elsewhere\n");                     // a worktree's .git is a file
    expect([packageReleaseVersion(released), packageReleaseVersion(checkout), packageReleaseVersion(scratch())]).toEqual(["2.2.0-beta.2", null, null]);
    expect(agendVersion(), "this test runs from a checkout").toBeNull();
  });
});

describe("what an instance is told", () => {
  it("an instance upgraded from before the record existed (launched before, no record): every current entry, once", () => {
    const plan = planWhatsNew({ record: null, fresh: false, version: "2.2.0-beta.2" });
    expect(plan && "ids" in plan ? plan.ids : plan).toEqual(ALL);
  });
  it("a new instance (never launched) is told nothing: everything current is recorded as known", () => {
    expect(planWhatsNew({ record: null, fresh: true, version: "2.2.0-beta.2" })).toEqual({ silent: ALL, version: "2.2.0-beta.2" });
  });
  it("only what it has not been told; nothing left → no notice", () => {
    const plan = planWhatsNew({ record: { announced: EVERY.slice(1) }, fresh: false, version: "2.2.0" });
    expect(plan && "ids" in plan ? plan.ids : plan).toEqual([EVERY[0]]);
    expect(planWhatsNew({ record: { announced: EVERY }, fresh: false, version: "2.2.0" })).toBeNull();
  });
  it("a version without agent-facing entries sends nothing (an entry is never told before its version)", () => {
    expect(planWhatsNew({ record: null, fresh: false, version: "2.1.12" })).toBeNull();
    const later = [{ id: "x", since: "2.3.0", text: "later" }];
    expect(planWhatsNew({ record: { announced: [] }, fresh: false, version: "2.2.5", entries: later })).toBeNull();
    const plan = planWhatsNew({ record: { announced: [] }, fresh: false, version: "2.3.0-beta.1", entries: [{ id: "x", since: "2.3.0-beta.1", text: "now" }] });
    expect(plan && "ids" in plan ? plan.ids : plan).toEqual(["x"]);
  });
  it("#1780: an instance told everything up to beta.6 is told `forwards` once on reaching beta.7 or later — and not before", () => {
    const told = AGENT_WHATS_NEW.filter(e => compareVersions(e.since, "2.2.0-beta.6")! <= 0).map(e => e.id);
    expect(planWhatsNew({ record: { announced: told }, fresh: false, version: "2.2.0-beta.6" })).toBeNull();
    for (const version of ["2.2.0-beta.7", "2.2.0-beta.8", "2.2.0"]) {
      const plan = planWhatsNew({ record: { announced: told }, fresh: false, version });
      expect(plan && "ids" in plan ? plan.ids : plan, version).toEqual(["2.2-forwards"]);
    }
    const plan = planWhatsNew({ record: { announced: told }, fresh: false, version: "2.2.0-beta.8" });
    const notice = plan && "notice" in plan ? plan.notice : "";
    for (const s of ["`send_to_instance` and `delegate_task` take `forwards: [id, …]`", "`verification_id`", "`delivery_status`",
      "An id written in the message text grants nothing", "\"Delivery not found\"", "on every hop",
      "a resumed session keeps the copy it first loaded, and reloading it does not refresh it", "Use them anyway — AgEnD's server accepts them."]) expect(notice, s).toContain(s);
    expect(notice).not.toContain("ToolSearch");                 // reloading does not refresh a Claude Code copy (#1780)
  });
  it("an unreadable record, or an unknown running version: nothing (never a repeat flood)", () => {
    expect([planWhatsNew({ record: "unreadable", fresh: false, version: "2.2.0" }), planWhatsNew({ record: null, fresh: false, version: null })]).toEqual([null, null]);
  });
  it("the notice names the exact parameters and tells the agent to use them even when its older tool copy lacks them (reloading does not refresh it, #1780), not to reply", () => {
    const text = whatsNewNotice("2.2.0-beta.2", AGENT_WHATS_NEW);
    for (const s of ["[system:whats-new] AgEnD is now 2.2.0-beta.2.", "`buttons: [{label, value?}]` (1–10)", "`[button] <label>`", "`[button] <label> (value: <value>)` when the value differs", "`stickers` (up to 3 ids from `list_stickers`",
      "`preview_stickers`", "`[user:… via web, …]`", "`message_id`", "`consumed_at` / `consumed_via`", "`filter_status`", "`verbose: true`", "`create_instance` refuses `tool_set` and `skipPermissions`; `update_instance_config` refuses `tool_set` and ignores `skipPermissions`",
      "a resumed session keeps the copy it first loaded, and reloading it does not refresh it", "Use them anyway — AgEnD's server accepts them.", "Do not reply to this message."]) expect(text, s).toContain(s);
    expect(text.split("\n").length).toBe(AGENT_WHATS_NEW.length + 2);
  });
});

describe("the record", () => {
  it("adds ids (merged, once each) and survives being read back — a restart repeats nothing", () => {
    const d = scratch();
    recordWhatsNew(d, ["a", "b"], "2.2.0-beta.1");
    recordWhatsNew(d, ["b", "c"], "2.2.0-beta.2");
    expect(readWhatsNewRecord(d)).toEqual({ announced: ["a", "b", "c"], version: "2.2.0-beta.2" });
    expect(planWhatsNew({ record: readWhatsNewRecord(d), fresh: false, version: "2.2.0", entries: [{ id: "a", since: "2.2.0", text: "" }] })).toBeNull();
  });
  it("a record that cannot be read is never written over — its history is not dropped (#1639 review)", () => {
    const d = scratch();
    writeFileSync(join(d, "whats-new.json"), "{not json");
    expect(() => recordWhatsNew(d, ["a"], "2.2.0")).toThrow("unreadable");
    expect(readFileSync(join(d, "whats-new.json"), "utf-8")).toBe("{not json");
  });
  it("missing → null; corrupt or the wrong shape → unreadable", () => {
    const d = scratch();
    expect(readWhatsNewRecord(d)).toBeNull();
    writeFileSync(join(d, "whats-new.json"), "{not json");
    expect(readWhatsNewRecord(d)).toBe("unreadable");
    writeFileSync(join(d, "whats-new.json"), JSON.stringify({ announced: [1] }));
    expect(readWhatsNewRecord(d)).toBe("unreadable");
  });
});

// ── the real daemon ──

const quiet = pino({ level: "silent" }) as never;
/** The running version as a release stamps it (a checkout's package.json is not the released number). */
const V = "2.2.0-beta.2";
function daemon() {
  const dir = scratch();
  const d = new Daemon("whats-new-test", {
    working_directory: dir,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
  } as never, dir, true, undefined, undefined, quiet) as any;
  d["tmux"] = { pasteBuffer: async () => true, sendSpecialKey: async () => true, capturePane: async () => "", getLastSendSpecialKeyError: () => null } as unknown as TmuxManager;
  const pastes: string[] = [];
  const outcome = { notice: true };
  d["deliverMessage"] = vi.fn(async (text: string) => {
    pastes.push(text);
    return text.startsWith("[system:whats-new]") ? outcome.notice : true;
  });
  const deliver = async (text: string) => { d.pushChannelMessage(text, { chat_id: "", user: "peer", from_instance: "peer" }); await d["pasteLock"]; };
  return { d, dir, pastes, outcome, deliver };
}

describe("the daemon", () => {
  it("prepares it at launch: an upgraded instance gets it pending; a new one only gets the record", () => {
    const up = daemon();
    up.d["prepareWhatsNew"](false, V);
    expect(up.d["pendingWhatsNew"]?.ids).toEqual(ALL);
    expect(readWhatsNewRecord(up.dir), "not recorded before it is pasted").toBeNull();
    const fresh = daemon();
    fresh.d["prepareWhatsNew"](true, V);
    expect([fresh.d["pendingWhatsNew"], announcedIn(fresh.dir)]).toEqual([null, ALL]);
  });
  it("trySpawn decides 'new' before prev-instructions is first written", () => {
    const src = readFileSync(join(process.cwd(), "src", "daemon.ts"), "utf-8");
    const prepare = src.indexOf('this.prepareWhatsNew(!existsSync(join(this.instanceDir, "prev-instructions")));');
    const firstWrite = src.indexOf("// First time (no prev-instructions file): write current hash, skip warmup.");
    expect(prepare).toBeGreaterThan(0);
    expect(prepare).toBeLessThan(firstWrite);
  });
  it("pasted ahead of the next real delivery, then recorded; the next delivery carries nothing extra", async () => {
    const w = daemon();
    w.d["prepareWhatsNew"](false, V);
    await w.deliver("first");
    expect(w.pastes.length).toBe(2);
    expect([w.pastes[0]!.startsWith("[system:whats-new]"), w.pastes[1]!.includes("first")]).toEqual([true, true]);
    expect([w.d["pendingWhatsNew"], announcedIn(w.dir)]).toEqual([null, ALL]);
    await w.deliver("second");
    expect(w.pastes.length).toBe(3);
    expect(w.pastes[2]!.includes("second")).toBe(true);
  });
  it("a paste that did not go through stays pending and unrecorded — the next delivery tries again", async () => {
    const w = daemon();
    w.d["prepareWhatsNew"](false, V);
    w.outcome.notice = false;
    await w.deliver("first");
    expect([w.d["pendingWhatsNew"]?.ids, readWhatsNewRecord(w.dir)]).toEqual([ALL, null]);
    w.outcome.notice = true;
    await w.deliver("second");
    expect(w.pastes.filter(p => p.startsWith("[system:whats-new]")).length).toBe(2);
    expect(announcedIn(w.dir)).toEqual(ALL);
  });
  it("after a restart it is not told again (the record decides), even if the launch says 'upgraded'", async () => {
    const w = daemon();
    w.d["prepareWhatsNew"](false, V);
    await w.deliver("first");
    w.d["prepareWhatsNew"](false, V);                               // the next launch
    expect(w.d["pendingWhatsNew"]).toBeNull();
  });
  it("the running version decides: under one that predates every entry, nothing is pending", () => {
    const w = daemon();
    w.d["prepareWhatsNew"](false, "2.1.12");
    expect(w.d["pendingWhatsNew"]).toBeNull();
  });
  it("the record is judged again just before the paste: corrupted while the delivery waited → nothing sent, file untouched (#1639 review)", async () => {
    const w = daemon();
    recordWhatsNew(w.dir, ALL.slice(1), V);                     // told everything but buttons
    w.d["prepareWhatsNew"](false, V);
    expect(w.d["pendingWhatsNew"]?.ids).toEqual([ALL[0]]);
    writeFileSync(join(w.dir, "whats-new.json"), "{corrupt");
    await w.deliver("first");
    expect([w.pastes.some(p => p.startsWith("[system:whats-new]")), w.pastes.some(p => p.includes("first")), w.d["pendingWhatsNew"]]).toEqual([false, true, null]);
    expect(readFileSync(join(w.dir, "whats-new.json"), "utf-8")).toBe("{corrupt");
  });
  it("corrupted while the notice was being pasted: the unknown history is not overwritten, and the next launch sends nothing (#1639 review)", async () => {
    const w = daemon();
    recordWhatsNew(w.dir, ALL.slice(1), V);
    w.d["prepareWhatsNew"](false, V);
    w.d["deliverMessage"] = vi.fn(async (text: string) => {
      w.pastes.push(text);
      if (text.startsWith("[system:whats-new]")) writeFileSync(join(w.dir, "whats-new.json"), "{corrupt");
      return true;
    });
    await w.deliver("first");
    expect(readFileSync(join(w.dir, "whats-new.json"), "utf-8")).toBe("{corrupt");
    w.d["prepareWhatsNew"](false, V);
    expect(w.d["pendingWhatsNew"]).toBeNull();
  });
  it("entries recorded while the delivery waited are not sent again; the rest are, and the record keeps everything (control)", async () => {
    const w = daemon();
    w.d["prepareWhatsNew"](false, V);
    recordWhatsNew(w.dir, ALL.slice(0, 2), V);                    // two of them recorded meanwhile
    await w.deliver("first");
    const notice = w.pastes.find(p => p.startsWith("[system:whats-new]"))!;
    expect([notice.split("\n").length, notice.includes("`buttons:"), notice.includes("`delivery_status`")]).toEqual([ALL.length - 2 + 2, false, true]);
    expect(announcedIn(w.dir)).toEqual([...ALL.slice(0, 2), ...ALL.slice(2)]);
  });
  it("nobody writes to it: nothing is pasted at all", () => {
    const w = daemon();
    w.d["prepareWhatsNew"](false, V);
    expect(w.pastes).toEqual([]);
  });
});
