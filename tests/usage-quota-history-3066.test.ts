/**
 * #3066 §1d: the weekly quota readings kept over time (usage/quota-history.ts), and Codex usage told by credential
 * profile (usage/profile-timeline.ts → the usage scan), plus the fleet's hooks: the 30-minute background read and the
 * launch record. No vendor call: the usage fetcher is the seam; files are in a scratch dir.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUOTA_HISTORY_MAX_BYTES, flushQuotaHistory, parseQuotaReading, quotaReadingsOf, readQuotaHistory, recordQuotaReadings, setQuotaHistoryFileForTests } from "../src/usage/quota-history.js";
import { PROFILE_TIMELINE_FILE, PROFILE_TIMELINE_MAX, profileAt, readProfileTimeline, recordProfileLaunch } from "../src/usage/profile-timeline.js";
import { getUsageSnapshot, setUsageFetcherForTests } from "../src/usage/usage-api.js";
import { CacheService, type CacheInstance } from "../src/cache-service.js";
import { FleetManager } from "../src/fleet-manager.js";

const WEEK = 7 * 24 * 3_600_000;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-3066-")); });
afterEach(async () => { vi.restoreAllMocks(); setUsageFetcherForTests(null); await setQuotaHistoryFileForTests(null); rmSync(dir, { recursive: true, force: true }); });

/** A good read of one account: session 5 h and weekly percents, and a per-model weekly. */
const row = (id: string, weekly: number, resetsAt = "2026-11-10T00:00:00.000Z", extra: Record<string, unknown> = {}) => ({
  id, name: "Claude", status: "ok", profile: id.includes(":") ? id.split(":")[1] : undefined, ...extra,
  metrics: [
    { label: "Session", type: "percent", used: 40, resetsAt: "2026-11-05T05:00:00.000Z", windowMs: 5 * 3_600_000 },
    { label: "Weekly", type: "percent", used: weekly, resetsAt, windowMs: WEEK },
    { label: "Sonnet (weekly)", type: "percent", used: 3, resetsAt, windowMs: WEEK },
  ],
}) as any;

describe("the quota history (#3066 §1d)", () => {
  it("records only weekly-or-longer percents, and a line only when the percent or the reset moved", async () => {
    const path = join(dir, "h.jsonl"); await setQuotaHistoryFileForTests(path);
    recordQuotaReadings(row("claude:hsinlin", 62), 1000);
    recordQuotaReadings(row("claude:hsinlin", 62), 2000);                       // nothing moved
    recordQuotaReadings(row("claude:hsinlin", 63), 3000);                       // Weekly moved
    recordQuotaReadings(row("claude:hsinlin", 63, "2026-11-17T00:00:00.000Z"), 4000); // a reset: both weekly lines
    await flushQuotaHistory();
    const h = await readQuotaHistory();
    expect(h.map((r) => [r.t, r.metric, r.used])).toEqual([
      [1000, "Weekly", 62], [1000, "Sonnet (weekly)", 3], [3000, "Weekly", 63], [4000, "Weekly", 63], [4000, "Sonnet (weekly)", 3],
    ]);
    expect(h.every((r) => r.provider === "claude:hsinlin" && r.profile === "hsinlin")).toBe(true);
    expect(h.some((r) => r.metric === "Session")).toBe(false);                 // the 5-hour window is not a quota to match
  });

  it("after a restart it compares with what the file holds (no duplicate line for an unchanged reading)", async () => {
    const path = join(dir, "h.jsonl"); await setQuotaHistoryFileForTests(path);
    recordQuotaReadings(row("codex", 79), 1000); await flushQuotaHistory();
    await setQuotaHistoryFileForTests(path);                                      // a new process: memory empty
    recordQuotaReadings(row("codex", 79), 2000); recordQuotaReadings(row("codex", 80), 3000); await flushQuotaHistory();
    expect((await readQuotaHistory()).filter((r) => r.metric === "Weekly").map((r) => [r.t, r.used])).toEqual([[1000, 79], [3000, 80]]);
  });

  it("an error row, a non-percent and a metric without its window record nothing; a bad line in the file is skipped", async () => {
    expect(quotaReadingsOf({ ...row("x", 5), status: "error" }, 1)).toEqual([]);
    expect(quotaReadingsOf({ id: "y", name: "y", status: "ok", metrics: [{ label: "Weekly", type: "dollars", used: 5, windowMs: WEEK }, { label: "W", type: "percent", used: 5 }] } as any, 1)).toEqual([]);
    expect(parseQuotaReading("{not json")).toBeNull();
    expect(parseQuotaReading(JSON.stringify({ t: 1, provider: "p", metric: "m", used: "5", resetsAt: null, windowMs: null }))).toBeNull();
    const path = join(dir, "h.jsonl");
    writeFileSync(path, `garbage\n${JSON.stringify({ t: 5, provider: "p", metric: "Weekly", used: 9, resetsAt: null, windowMs: WEEK })}\n`);
    await setQuotaHistoryFileForTests(path);
    expect((await readQuotaHistory()).map((r) => r.used)).toEqual([9]);
  });

  it("kept under its cap: past 2 MB the oldest lines go (and anything older than 12 weeks)", async () => {
    const path = join(dir, "h.jsonl");
    const now = Date.parse("2026-11-05T00:00:00.000Z");
    const line = (t: number, used: number) => `${JSON.stringify({ t, provider: "claude", metric: "Weekly", used, resetsAt: null, windowMs: WEEK, pad: "x".repeat(4000) })}\n`;
    let body = line(now - 13 * WEEK, 1);                                         // older than 12 weeks
    for (let i = 0; Buffer.byteLength(body) < QUOTA_HISTORY_MAX_BYTES + 50_000; i++) body += line(now - WEEK + i, i % 100);
    writeFileSync(path, body);
    await setQuotaHistoryFileForTests(path);
    recordQuotaReadings(row("claude", 77), now); await flushQuotaHistory();
    expect(statSync(path).size).toBeLessThanOrEqual(QUOTA_HISTORY_MAX_BYTES);
    const h = await readQuotaHistory();
    expect(h.some((r) => r.t === now - 13 * WEEK)).toBe(false);
    expect(h.filter((r) => r.t === now && r.metric === "Weekly").map((r) => r.used)).toEqual([77]);   // the newest kept
  }, 20_000);

  it("usage-api: a good read records its weekly readings (the hook), a failed read records nothing", async () => {
    setUsageFetcherForTests(async () => ({ providers: [row("claude:jefflin", 84), { id: "codex", name: "Codex", status: "error", error: "x", metrics: [] }], fetchedAt: new Date().toISOString() }) as any);
    const path = join(dir, "h.jsonl"); await setQuotaHistoryFileForTests(path);
    await getUsageSnapshot(true);
    await flushQuotaHistory();
    const h = await readQuotaHistory();
    expect(h.map((r) => `${r.provider} ${r.metric} ${r.used}`)).toEqual(["claude:jefflin Weekly 84", "claude:jefflin Sonnet (weekly) 3"]);
  });
});

describe("Codex usage by credential profile (#3066 §1d)", () => {
  it("the timeline: a launch under a new profile is an entry; the same profile again is not; capped", async () => {
    const path = join(dir, PROFILE_TIMELINE_FILE);
    await recordProfileLaunch(path, "default", 100);
    await recordProfileLaunch(path, "default", 200);
    await recordProfileLaunch(path, "yanxianchen", 300);
    expect(await readProfileTimeline(path)).toEqual([{ t: 100, profile: "default" }, { t: 300, profile: "yanxianchen" }]);
    for (let i = 0; i < PROFILE_TIMELINE_MAX + 10; i++) await recordProfileLaunch(path, i % 2 ? "a" : "b", 1000 + i);
    expect((await readProfileTimeline(path)).length).toBe(PROFILE_TIMELINE_MAX);
  });
  it("profileAt: the latest entry at or before the time; before any entry, unrecorded", () => {
    const spans = [{ t: 100, profile: "a" }, { t: 300, profile: "b" }];
    expect([profileAt(spans, 99), profileAt(spans, 100), profileAt(spans, 299), profileAt(spans, 300), profileAt(spans, 9e15)]).toEqual(["unrecorded", "a", "a", "b", "b"]);
  });

  it("the scan tags each Codex turn with the profile it ran under, by its time; older turns stay unrecorded", async () => {
    const FIX = join(process.cwd(), "tests", "fixtures", "cache-1468");
    const wd = join(dir, "wd"); mkdirSync(wd); mkdirSync(join(dir, "sessions", "d"), { recursive: true });
    writeFileSync(join(dir, "sessions", "d", "rollout-1.jsonl"), readFileSync(join(FIX, "codex-rollout.jsonl"), "utf8").replaceAll("/work/codex-sample", wd));
    // The fixture's turns: 09:00 (×3), 10:12, 20:12 on 2026-10-08. Launched under "alice" at 09:30, "bob" at 15:00.
    const timeline = join(dir, PROFILE_TIMELINE_FILE);
    await recordProfileLaunch(timeline, "alice", Date.parse("2026-10-08T09:30:00.000Z"));
    await recordProfileLaunch(timeline, "bob", Date.parse("2026-10-08T15:00:00.000Z"));
    const walk = (root: string) => { const out: Array<{ path: string; mtimeMs: number }> = []; const go = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) go(p); else if (e.name.startsWith("rollout-")) out.push({ path: p, mtimeMs: statSync(p).mtimeMs }); } }; go(root); return out; };
    const inst: CacheInstance = { name: "cx", backend: "codex", workingDirectory: wd, ledgerPath: join(dir, "state", "cx.json"), profile: "unrecorded", profileTimelinePath: timeline };
    const s = new CacheService({ instances: () => [inst], claudeProjectsDir: () => join(dir, "projects"), claudeKey: (x) => x, codexSessionsDir: () => join(dir, "sessions"),
      listRollouts: walk, metaPath: join(dir, "meta.json"), now: () => Date.parse("2026-10-08T21:00:00.000Z") });
    await s.pass();
    const ledger = (await s.usageData()).instances[0]!.ledger; s.stop();
    const byHour = Object.fromEntries(Object.entries(ledger.hours).map(([h, v]) => [new Date(Number(h)).toISOString().slice(11, 13), Object.keys(v.src ?? {}).sort()]));
    expect(byHour).toEqual({ "09": ["codex:unrecorded"], "10": ["codex:alice"], "20": ["codex:bob"] });
  });
});

describe("the fleet's hooks (#3066 §1d)", () => {
  function rig() {
    const home = join(dir, "home"); mkdirSync(home);
    const fm = new FleetManager(home);
    fm.fleetConfig = { defaults: {}, channels: [], instances: { cx: { working_directory: dir, backend: "codex" } } } as any;
    return fm;
  }
  it("a Codex launch records its credential profile in the instance's timeline", async () => {
    const fm = rig();
    mkdirSync(fm.getInstanceDir("cx"), { recursive: true });                    // an instance's dir exists once it has launched
    (fm as any).daemons.set("cx", { bootId: "b1" });
    vi.spyOn(fm as any, "listenForWorkingState").mockImplementation(() => {});
    vi.spyOn(fm as any, "credentialProfileOf").mockReturnValue("yanxianchen");
    fm.onDaemonReady("cx", "b1");
    const path = join(fm.getInstanceDir("cx"), PROFILE_TIMELINE_FILE);
    expect((fm as any).backendNameOf("cx")).toBe("codex");
    await vi.waitFor(async () => expect((await readProfileTimeline(path)).map((s) => s.profile)).toEqual(["yanxianchen"]));
  });
  it("the background read: only with no Discord bot reading, and only while an account has a running agent", async () => {
    const fm = rig();
    const fetches = vi.fn(async () => ({ providers: [], fetchedAt: new Date().toISOString() }) as any);
    setUsageFetcherForTests(fetches);
    const active = vi.spyOn(fm, "getActiveUsageProviderIds").mockReturnValue(new Set());
    expect(await fm.backgroundQuotaRead()).toBe(false);                          // nobody running
    active.mockReturnValue(new Set(["codex"]));
    expect(await fm.backgroundQuotaRead()).toBe(true);
    expect(fetches).toHaveBeenCalledOnce();
    fm.adapters.set("dc", { type: "discord", setActivity: () => {} } as any);   // the presence refresh reads every 15 min
    expect(await fm.backgroundQuotaRead()).toBe(false);
    expect(FleetManager.QUOTA_BACKGROUND_READ_MS).toBe(30 * 60_000);
  });
  it("Fable r1 #4: shutting down reads nothing", async () => {
    const fm = rig();
    const fetches = vi.fn(async () => ({ providers: [], fetchedAt: new Date().toISOString() }) as any);
    setUsageFetcherForTests(fetches);
    vi.spyOn(fm, "getActiveUsageProviderIds").mockReturnValue(new Set(["codex"]));
    (fm as any).shuttingDown = true;
    expect(await fm.backgroundQuotaRead()).toBe(false);
    expect(fetches).not.toHaveBeenCalled();
  });
  it("Fable r1 #4: no credential profile is \"default\" (what an account's usage provider id joins on); another boot's ready records nothing", async () => {
    const fm = rig();
    mkdirSync(fm.getInstanceDir("cx"), { recursive: true });
    (fm as any).daemons.set("cx", { bootId: "b2" });
    vi.spyOn(fm as any, "listenForWorkingState").mockImplementation(() => {});
    vi.spyOn(fm as any, "credentialProfileOf").mockReturnValue(undefined);
    const path = join(fm.getInstanceDir("cx"), PROFILE_TIMELINE_FILE);
    fm.onDaemonReady("cx", "b1");                                                // a stale boot's report: not this daemon
    await new Promise((r) => setTimeout(r, 50));
    expect(await readProfileTimeline(path)).toEqual([]);
    fm.onDaemonReady("cx", "b2");
    await vi.waitFor(async () => expect((await readProfileTimeline(path)).map((s) => s.profile)).toEqual(["default"]));
  });
  it("Fable r1 #2: a ClassicBot Codex room's launches are read too (its timeline is passed to the scan)", () => {
    const fm = rig();
    (fm as any).classicChannels = { getAll: () => [{ instanceName: "room" }], getBackendByInstance: () => "codex" };
    const room = (fm as any).cacheInstances().find((i: any) => i.name === "room");
    expect(room.profileTimelinePath).toBe(join(fm.getInstanceDir("room"), PROFILE_TIMELINE_FILE));
  });
});

describe("Fable r1 #3 and #5: the age cutoff and a drifting reset time", () => {
  it("lines older than 12 weeks go on the first write of a day, however small the file", async () => {
    const path = join(dir, "h.jsonl");
    const now = Date.parse("2026-11-05T00:00:00.000Z");
    writeFileSync(path, `${JSON.stringify({ t: now - 13 * WEEK, provider: "claude", metric: "Weekly", used: 1, resetsAt: null, windowMs: WEEK })}\n`);
    await setQuotaHistoryFileForTests(path);
    recordQuotaReadings(row("claude", 5), now); await flushQuotaHistory();
    expect((await readQuotaHistory()).some((r) => r.t === now - 13 * WEEK)).toBe(false);
  });
  it("a reset time that drifts by seconds (\"resets in N s\") is the same reset — no line on every read; a real reset is", async () => {
    const path = join(dir, "h.jsonl"); await setQuotaHistoryFileForTests(path);
    const t = Date.parse("2026-11-05T00:00:00.000Z");
    recordQuotaReadings(row("codex", 40, new Date(t + 3 * 86_400_000).toISOString()), t);
    recordQuotaReadings(row("codex", 40, new Date(t + 3 * 86_400_000 + 7_000).toISOString()), t + 60_000);
    recordQuotaReadings(row("codex", 40, new Date(t + 10 * 86_400_000).toISOString()), t + 120_000);
    await flushQuotaHistory();
    expect((await readQuotaHistory()).filter((r) => r.metric === "Weekly").map((r) => r.t)).toEqual([t, t + 120_000]);
  });
});
