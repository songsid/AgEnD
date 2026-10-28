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
import { AGENT_WHATS_NEW, WHATS_NEW_NOTES_URL, withWhatsNew, agendVersion, packageReleaseVersion, compareVersions, planWhatsNew, readWhatsNewRecord, recordWhatsNew, whatsNewNotice } from "../src/agent-whats-new.js";
import type { WhatsNewAudience } from "../src/agent-whats-new.js";
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
    for (const version of ["2.2.0-beta.7", "2.2.0-beta.8", "2.2.0-beta.10"]) {
      const plan = planWhatsNew({ record: { announced: told }, fresh: false, version });
      expect(plan && "ids" in plan ? plan.ids : plan, version).toEqual(["2.2-forwards"]);
    }
    const later = planWhatsNew({ record: { announced: told }, fresh: false, version: "2.2.0" });
    expect(later && "ids" in later ? later.ids : later).toEqual(["2.2-forwards", "2.2-polls", "2.2-web-identity", "2.2-delivery-status-evidence"]);
    const plan = planWhatsNew({ record: { announced: told }, fresh: false, version: "2.2.0-beta.8" });
    const notice = plan && "notice" in plan ? plan.notice : "";
    for (const s of ["`send_to_instance` and `delegate_task` take `forwards: [id, …]`", "`verification_id`", "`delivery_status`",
      "An id written in the message text grants nothing", "\"Delivery not found\"", "on every hop",
      "a description you loaded earlier may be out of date", "AgEnD's server accepts what is written here", WHATS_NEW_NOTES_URL]) expect(notice, s).toContain(s);
    expect(notice).not.toContain("ToolSearch");                 // reloading does not refresh a Claude Code copy (#1780)
  });
  it("an instance told everything up to beta.10 hears of polls and web identity once on reaching beta.11 or later — and not before", () => {
    const told = AGENT_WHATS_NEW.filter(e => compareVersions(e.since, "2.2.0-beta.10")! <= 0).map(e => e.id);
    expect(told).toContain("2.2-forwards");
    expect(planWhatsNew({ record: { announced: told }, fresh: false, version: "2.2.0-beta.10" })).toBeNull();
    for (const version of ["2.2.0-beta.11", "2.2.0-beta.12", "2.2.0"]) {
      const plan = planWhatsNew({ record: { announced: told }, fresh: false, version });
      expect(plan && "ids" in plan ? plan.ids : plan, version).toEqual(version === "2.2.0" ? ["2.2-polls", "2.2-web-identity", "2.2-delivery-status-evidence"] : ["2.2-polls", "2.2-web-identity"]);
    }
    const plan = planWhatsNew({ record: { announced: told }, fresh: false, version: "2.2.0-beta.11" });
    const notice = plan && "notice" in plan ? plan.notice : "";
    expect(notice.split("\n")[0]).toBe(`[system:whats-new] AgEnD is now 2.2.0-beta.11. Changed for tools you have — a description you loaded earlier may be out of date; AgEnD's server accepts what is written here. Full notes: ${WHATS_NEW_NOTES_URL}`);
    for (const s of ["`reply` takes `poll: {seconds, multi?, reveal?: \"close\"|\"live\", show_voters?}`", "2–10 `buttons`", "`poll_id`", "one `[poll results]` message",
      "`close_poll({poll_id})`", "`[user:<name> via web, id:<their Discord/Telegram user id>]`", "the web-chat rule in your instructions",
      "a description you loaded earlier may be out of date", "AgEnD's server accepts what is written here", WHATS_NEW_NOTES_URL]) expect(notice, s).toContain(s);
    expect(notice).not.toContain("forwards");
    // A new instance on beta.11 starts with the current schemas: told nothing, both recorded.
    const fresh = planWhatsNew({ record: null, fresh: true, version: "2.2.0-beta.11" });
    // (Entries of later versions are not there yet: #1629's 2.3 entries.)
    expect(fresh && "silent" in fresh ? fresh.silent : fresh).toEqual(AGENT_WHATS_NEW.filter(e => compareVersions(e.since, "2.2.0-beta.11")! <= 0).map(e => e.id));
  });
  it("the poll entry names the schema's exact parameters and limits", async () => {
    const { ReplyArgs, ClosePollArgs } = await import("../src/outbound-schemas.js");
    const poll = (ReplyArgs as any).shape.poll.unwrap();
    expect(Object.keys(poll.shape)).toEqual(["seconds", "multi", "reveal", "show_voters"]);
    expect(poll.shape.reveal.unwrap().options).toEqual(["close", "live"]);
    expect([poll.shape.seconds.minValue, poll.shape.seconds.maxValue]).toEqual([10, 86400]);
    expect(Object.keys((ClosePollArgs as any).shape)).toEqual(["poll_id"]);
    const text = AGENT_WHATS_NEW.find(e => e.id === "2.2-polls")!.text;
    for (const s of ["`seconds` (10–86400)", "`close_poll({poll_id})`"]) expect(text, s).toContain(s);
  });
  it("an unreadable record, or an unknown running version: nothing (never a repeat flood)", () => {
    expect([planWhatsNew({ record: "unreadable", fresh: false, version: "2.2.0" }), planWhatsNew({ record: null, fresh: false, version: null })]).toEqual([null, null]);
  });
  it("the notice names the exact parameters, says an older loaded copy may be out of date (#1780), and links the full notes (#2800)", () => {
    const text = whatsNewNotice("2.2.0-beta.2", AGENT_WHATS_NEW);
    for (const s of ["[system:whats-new] AgEnD is now 2.2.0-beta.2.", "`buttons: [{label, value?}]` (1–10)", "`[button] <label>`", "`[button] <label> (value: <value>)` when the value differs", "`stickers` (up to 3 ids from `list_stickers`",
      "`preview_stickers`", "`[user:… via web, …]`", "`message_id`", "`consumed_at` / `consumed_via`", "`filter_status`", "`verbose: true`", "`create_instance` refuses `tool_set` and `skipPermissions`; `update_instance_config` refuses `tool_set` and ignores `skipPermissions`",
      "a description you loaded earlier may be out of date", "AgEnD's server accepts what is written here", WHATS_NEW_NOTES_URL]) expect(text, s).toContain(s);
    // #2800: it rides in front of a real message, so it no longer says not to reply or tells the agent to "use them anyway".
    expect(text).not.toContain("Do not reply to this message.");
    // The header, one line per entry, + the #2163 line on reading a skill the entries name.
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
  // `delivered`: the paste was proven submitted; `written`: it at least reached the pane (#2140: what Claude's collapsed
  // "[Pasted text #1 +N lines]" leaves). #2800: the notice is part of the message's own paste, so both are the message's.
  const outcome = { delivered: true, written: true };
  d["deliverMessage"] = vi.fn(async (text: string, _status: unknown, opts?: { verdict?: { paneWriteStarted?: boolean } }) => {
    pastes.push(text);
    if (opts?.verdict && outcome.written) opts.verdict.paneWriteStarted = true;
    return outcome.delivered;
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
    const firstWrite = src.indexOf('try { writeFileSync(join(this.instanceDir, "prev-instructions"), backendConfig.instructions); }');
    expect(prepare).toBeGreaterThan(0);
    expect(prepare).toBeLessThan(firstWrite);
  });
  it("#2800: in front of the next real message, in the same paste; recorded; the next message carries nothing extra", async () => {
    const w = daemon();
    w.d["prepareWhatsNew"](false, V);
    await w.deliver("first");
    expect(w.pastes.length, "one paste, not a turn of its own").toBe(1);
    const [notice, message] = w.pastes[0]!.split("\n\n");
    expect([notice!.startsWith("[system:whats-new]"), message]).toEqual([true, "[from:peer] first"]);
    expect([w.d["pendingWhatsNew"], announcedIn(w.dir)]).toEqual([null, ALL]);
    await w.deliver("second");
    expect(w.pastes.length).toBe(2);
    expect(w.pastes[1]!.startsWith("[from:peer] second")).toBe(true);
  });
  it("#2800 (Prism P2): AgEnD's leading marker lines stay first — the notice goes after them, before the message", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(withWhatsNew(`[agend-delivery-id:${id}]\n[from:peer] task`, "[system:whats-new] N"))
      .toBe(`[agend-delivery-id:${id}]\n[system:whats-new] N\n\n[from:peer] task`);
    expect(withWhatsNew(`[agend-delivery-id:${id}]\n[agend-human-id:hmsg-x]\n[user:a] hi`, "[system:whats-new] N"))
      .toBe(`[agend-delivery-id:${id}]\n[agend-human-id:hmsg-x]\n[system:whats-new] N\n\n[user:a] hi`);
    expect(withWhatsNew("[from:peer] task", "[system:whats-new] N")).toBe("[system:whats-new] N\n\n[from:peer] task");
    // A marker quoted later in the body is not a leading line.
    expect(withWhatsNew("[from:peer] see [agend-delivery-id:x]\n", "[system:whats-new] N").startsWith("[system:whats-new] N")).toBe(true);
  });
  it("#2800 (Prism P3): written, then a later step of the write throws — recorded once, not attached again", async () => {
    const w = daemon();
    w.d["prepareWhatsNew"](false, V);
    let first = true;
    w.d["deliverMessage"] = vi.fn(async (text: string, _status: unknown, opts?: { verdict?: { paneWriteStarted?: boolean } }) => {
      w.pastes.push(text);
      if (first) { first = false; if (opts?.verdict) opts.verdict.paneWriteStarted = true; throw new Error("SQLITE_IOERR after the paste"); }
      return true;
    });
    await w.deliver("first");
    expect([w.d["pendingWhatsNew"], announcedIn(w.dir)]).toEqual([null, ALL]);
    await w.deliver("second");
    expect(w.pastes.filter(p => p.startsWith("[system:whats-new]")).length).toBe(1);
  });
  it("#2800 (Prism P3 control): a throw before anything was written records nothing — the next message carries it", async () => {
    const w = daemon();
    w.d["prepareWhatsNew"](false, V);
    let first = true;
    w.d["deliverMessage"] = vi.fn(async (text: string) => {
      w.pastes.push(text);
      if (first) { first = false; throw new Error("paste failed"); }
      return true;
    });
    await w.deliver("first");
    expect([w.d["pendingWhatsNew"]?.ids, readWhatsNewRecord(w.dir)]).toEqual([ALL, null]);
    await w.deliver("second");
    expect(w.pastes.filter(p => p.startsWith("[system:whats-new]")).length).toBe(2);
    expect(announcedIn(w.dir)).toEqual(ALL);
  });
  it("#2800: only entries about tools the instance has — a worker is not told about create_instance, which it lacks", async () => {
    const w = daemon();
    w.d["prepareWhatsNew"](false, V);
    await w.deliver("first");
    expect(w.pastes[0]).toContain("`reply` takes `buttons:");
    expect(w.pastes[0]).not.toContain("`create_instance` refuses");
    expect(announcedIn(w.dir), "recorded all the same").toContain("2.2-create-refusals");
  });
  it("#2800: nothing relevant → nothing is attached; everything is recorded", async () => {
    const w = daemon();
    recordWhatsNew(w.dir, ALL.filter(id => id !== "2.2-create-refusals"), V);
    w.d["prepareWhatsNew"](false, V);
    expect(w.d["pendingWhatsNew"]).toBeNull();
    expect(announcedIn(w.dir)).toContain("2.2-create-refusals");
    await w.deliver("first");
    expect(w.pastes.length).toBe(1);
    expect(w.pastes[0]!.startsWith("[from:peer] first")).toBe(true);
  });
  it("#2800: a person's message with a verified receipt is pasted byte for byte; the notice waits for the next one", async () => {
    const w = daemon();
    w.d["prepareWhatsNew"](false, V);
    w.d.pushChannelMessage("from a person", { chat_id: "c1", user: "han", human_receipt_id: "00000000-0000-0000-0000-000000000000" });
    await w.d["pasteLock"];
    expect(w.pastes[0]!.startsWith("[system:whats-new]")).toBe(false);
    expect(w.d["pendingWhatsNew"]?.ids).toEqual(ALL);
    await w.deliver("next");
    expect(w.pastes[1]!.startsWith("[system:whats-new]")).toBe(true);
  });
  it("a paste that never reached the pane keeps it pending and unrecorded — the next message carries it", async () => {
    const w = daemon();
    w.d["prepareWhatsNew"](false, V);
    w.outcome.delivered = false; w.outcome.written = false;
    await w.deliver("first");
    expect([w.d["pendingWhatsNew"]?.ids, readWhatsNewRecord(w.dir)]).toEqual([ALL, null]);
    w.outcome.delivered = true; w.outcome.written = true;
    await w.deliver("second");
    expect(w.pastes.filter(p => p.startsWith("[system:whats-new]")).length).toBe(2);
    expect(announcedIn(w.dir)).toEqual(ALL);
  });
  it("#2140: written but its submission unproven — recorded once, never attached again", async () => {
    const w = daemon();
    w.d["prepareWhatsNew"](false, V);
    w.outcome.delivered = false; w.outcome.written = true;
    for (const m of ["first", "second", "third"]) await w.deliver(m);
    expect(w.pastes.filter(p => p.startsWith("[system:whats-new]")).length, "the notice went out once").toBe(1);
    expect([w.d["pendingWhatsNew"], announcedIn(w.dir)]).toEqual([null, ALL]);
  });
  it("#2140: the record-write failure still warns, and the notice is not attached again in this session", async () => {
    const w = daemon();
    const warn = vi.spyOn(w.d.logger, "warn");
    w.d["prepareWhatsNew"](false, V);
    const { chmodSync } = await import("node:fs");
    chmodSync(w.dir, 0o500);                                   // the instance dir cannot take the record
    try {
      await w.deliver("first"); await w.deliver("second");
    } finally { chmodSync(w.dir, 0o700); }
    expect(warn.mock.calls.some(c => /what's-new record not written/.test(String(c[1])))).toBe(true);
    expect(w.pastes.filter(p => p.startsWith("[system:whats-new]")).length).toBe(1);
    expect(w.d["pendingWhatsNew"]).toBeNull();
  });
  it("replaced while its paste was out (a newer plan): what went out is recorded, the newer one stays pending", async () => {
    const w = daemon();
    w.d["prepareWhatsNew"](false, V);
    const newer = { notice: "[system:whats-new] newer", ids: ["newer-entry"], version: V };
    const inner = w.d["deliverMessage"];
    w.d["deliverMessage"] = vi.fn(async (text: string, status: unknown, opts: unknown) => {
      if (text.startsWith("[system:whats-new]")) w.d["pendingWhatsNew"] = newer;
      return inner(text, status, opts);
    });
    await w.deliver("first");
    expect([w.d["pendingWhatsNew"], announcedIn(w.dir)]).toEqual([newer, ALL]);
  });
  it("#2800: launch planning is a debug line, not an info line on every launch", () => {
    const w = daemon();
    const info = vi.spyOn(w.d.logger, "info"), debug = vi.spyOn(w.d.logger, "debug");
    w.d["prepareWhatsNew"](false, V);
    expect(info.mock.calls.some(c => /what's-new notice pending/.test(String(c[1])))).toBe(false);
    expect(debug.mock.calls.some(c => /what's-new notice pending/.test(String(c[1])))).toBe(true);
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
    expect([notice.includes("`buttons:"), notice.includes("`delivery_status`")]).toEqual([false, true]);
    expect(announcedIn(w.dir)).toEqual([...ALL.slice(0, 2), ...ALL.slice(2)]);
  });
  it("nobody writes to it: nothing is pasted at all", () => {
    const w = daemon();
    w.d["prepareWhatsNew"](false, V);
    expect(w.pastes).toEqual([]);
  });
});

describe("#2800: once per release, only relevant tools", () => {
  it("every tool an entry names is a real agend tool (a typo would hide the entry from everyone)", async () => {
    const { TOOLS } = await import("../src/channel/mcp-tools.js");
    const names = new Set(TOOLS.map(t => t.name));
    const named = AGENT_WHATS_NEW.flatMap(e => (e.tools ?? []).map(t => `${e.id}:${t}`));
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter(x => !names.has(x.split(":")[1]!))).toEqual([]);
  });
  it("only the running release is told; an older unread entry is superseded (recorded, not shown)", () => {
    const entries = [{ id: "old", since: "2.3.0", text: "old line" }, { id: "beta", since: "2.3.2-beta.3", text: "beta line" }, { id: "now", since: "2.3.2", text: "now line" }];
    const plan = planWhatsNew({ record: { announced: [] }, fresh: false, version: "2.3.2", entries });
    expect(plan && "notice" in plan ? [plan.ids, plan.notice.includes("old line"), plan.notice.includes("beta line"), plan.notice.includes("now line")] : plan)
      .toEqual([["old", "beta", "now"], false, true, true]);
    const onlyOld = planWhatsNew({ record: { announced: [] }, fresh: false, version: "2.3.2", entries: entries.slice(0, 1) });
    expect(onlyOld).toEqual({ silent: ["old"], version: "2.3.2" });
  });
  it("#2785 (a): every role hears the reply-required marker once on 2.3.3, whatever its tools; 2.3.2 never does", () => {
    const told = (version: string, roles: WhatsNewAudience[]) => {
      const plan = planWhatsNew({ record: { announced: [] }, fresh: false, version, roles, tools: new Set(["reply"]) });
      return !!plan && "notice" in plan && plan.notice.includes("reply required → report_result");
    };
    expect([told("2.3.3", ["worker"]), told("2.3.3", ["classic"]), told("2.3.3", ["general"]), told("2.3.2", ["worker"])]).toEqual([true, true, true, false]);
  });
  it("an entry naming tools is shown only to an instance that has one of them; a rule-only entry to every role it is for", () => {
    const entries = [{ id: "pack", since: "2.3.2", tools: ["office_pack_list"], text: "pack line" }, { id: "rule", since: "2.3.2", text: "rule line" }];
    const without = planWhatsNew({ record: { announced: [] }, fresh: false, version: "2.3.2", entries, tools: new Set(["reply"]) });
    const withIt = planWhatsNew({ record: { announced: [] }, fresh: false, version: "2.3.2", entries, tools: new Set(["reply", "office_pack_list"]) });
    expect(without && "notice" in without ? [without.ids, without.notice.includes("pack line"), without.notice.includes("rule line")] : without).toEqual([["pack", "rule"], false, true]);
    expect(withIt && "notice" in withIt ? withIt.notice.includes("pack line") : withIt).toBe(true);
    expect(planWhatsNew({ record: { announced: [] }, fresh: false, version: "2.3.2", entries: entries.slice(0, 1), tools: new Set(["reply"]) }))
      .toEqual({ silent: ["pack"], version: "2.3.2" });
  });
  it("the daemon's tool list follows office_pack_access: off → no office tools, so the 2.3.2 pack entry is not told", async () => {
    const off = daemon(), on = daemon();
    on.d.config.office_pack_access = true;
    expect(off.d["whatsNewTools"]().has("office_pack_list")).toBe(false);
    expect(on.d["whatsNewTools"]().has("office_pack_list")).toBe(true);
    for (const w of [off, on]) { recordWhatsNew(w.dir, AGENT_WHATS_NEW.filter(e => e.id !== "2.3.2-office-pack-tools").map(e => e.id), "2.3.1"); w.d["prepareWhatsNew"](false, "2.3.2"); }
    expect(off.d["pendingWhatsNew"]).toBeNull();
    expect(announcedIn(off.dir)).toContain("2.3.2-office-pack-tools");
    expect(on.d["pendingWhatsNew"]?.notice).toContain("`office_pack_check` checks a pack without storing it");
  });
});
