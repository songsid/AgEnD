/**
 * #3212 / AGEND-113: the usage block of Settings → Accounts is EVERY pool and EVERY window an account reports, not one picked per kind.
 * - accountUsage(backend, provider): the percent metrics with a number, never a per-model quota or a count, grouped by pool in the usage panel's own order. A pool is named only for a CLI whose spec
 *   says it has several; a window that has reset since the read is kept and flagged (the pool and the window are still there); stale is said.
 * - usageWindowKind: the kind of a window, by its length or the period the CLI names.
 * - buildAccountsView: the row carries `usageGroups` / `usageStale` (host rows only), and none of the two fixed windows it used to carry.
 * - FleetManager.accountsView(): each account's groups come from one usage snapshot, per account (the default and `:<profile>` providers).
 * Earlier this was the week's window and the 5h one (weeklyUsage, shortUsage): for Antigravity's two pools that showed Gemini's 5h and Claude & others' week and hid the other two. Fixtures only (example.com).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/usage/usage-api.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/usage/usage-api.js")>()), getUsageSnapshot: vi.fn() }));
import { getUsageSnapshot, usageProviderIdForBackend } from "../src/usage/usage-api.js";
import { FleetManager } from "../src/fleet-manager.js";
import { accountUsage, buildAccountsView, usageWindowKind, type AccountsInput } from "../src/accounts-view.js";

const H = 3_600_000, DAY = 86_400_000;
const m = (windowMs: number, used: number, extra: Record<string, unknown> = {}) => ({ type: "percent", used, windowMs, resetsAt: `r${windowMs}`, ...extra });
const pool = (label: string) => ({ label, labelI18n: { key: "usage.metric.named", args: [label] } });

describe("usageWindowKind", () => {
  it("by the window's length: under two days is the session, up to ten days the week, longer the month", () => {
    expect([5 * H, 47 * H, 48 * H, 7 * DAY, 10 * DAY, 10 * DAY + 1, 30 * DAY].map((ms) => usageWindowKind({ windowMs: ms }))).toEqual(["session", "session", "weekly", "weekly", "weekly", "monthly", "monthly"]);
  });
  it("without a length, by the period the CLI names (Kiro's monthly credits); a number with neither is unwindowed", () => {
    expect(usageWindowKind({ quotaPeriod: "monthly" })).toBe("monthly");
    expect(["hourly", "session", "daily"].map((quotaPeriod) => usageWindowKind({ quotaPeriod }))).toEqual(["session", "session", "session"]);
    expect(usageWindowKind({ quotaPeriod: "weekly" })).toBe("weekly");
    expect(usageWindowKind({})).toBe("unwindowed");
    expect([0, -5, NaN, null, "7"].map((windowMs) => usageWindowKind({ windowMs }))).toEqual(Array(5).fill("unwindowed"));
  });
});

describe("accountUsage: one set of limits (Claude, Codex)", () => {
  it("every window in the payload's order, in one group with no pool; the percent rounded and kept within 0–100", () => {
    expect(accountUsage("claude-code", { metrics: [m(5 * H, 75.6), m(7 * DAY, 28)] })).toEqual({ groups: [{ windows: [
      { kind: "session", percent: 76, windowMs: 5 * H, resetsAt: `r${5 * H}` }, { kind: "weekly", percent: 28, windowMs: 7 * DAY, resetsAt: `r${7 * DAY}` }] }] });
    expect(accountUsage("claude-code", { metrics: [m(5 * H, 140), m(7 * DAY, -3)] })!.groups[0]!.windows.map((w) => w.percent)).toEqual([100, 0]);
    expect(accountUsage("codex", { metrics: [m(5 * H, 10), m(7 * DAY, 20), m(30 * DAY, 30)] })!.groups[0]!.windows.map((w) => w.kind)).toEqual(["session", "weekly", "monthly"]);
  });
  it("is the same whichever order the payload lists them in: it is the payload's, not sorted again", () => {
    expect(accountUsage("claude-code", { metrics: [m(7 * DAY, 28), m(5 * H, 76)] })!.groups[0]!.windows.map((w) => w.kind)).toEqual(["weekly", "session"]);
  });
  it("never a per-model quota, a count, an amount or a metric without a number; none of those alone is a block", () => {
    const only = (extra: Record<string, unknown>) => accountUsage("claude-code", { metrics: [m(5 * H, 90, extra)] });
    expect(only({ scope: "model" })).toBeUndefined();
    expect(only({ type: "count" })).toBeUndefined();
    expect(only({ type: "dollars" })).toBeUndefined();
    expect(only({ used: undefined })).toBeUndefined();
    expect(only({ used: NaN })).toBeUndefined();
    expect(accountUsage("claude-code", { metrics: [m(5 * H, 90, { scope: "model" }), m(8 * H, 33)] })!.groups[0]!.windows).toHaveLength(1);   // a usable one is still found
    expect(accountUsage("claude-code", { metrics: [] })).toBeUndefined();
    expect(accountUsage("claude-code", undefined)).toBeUndefined();
    expect(accountUsage("claude-code", {} as never)).toBeUndefined();
  });
  it("ignores a pool tag a payload carries: the pool is named only for a CLI whose spec says it has several", () => {
    const u = accountUsage("claude-code", { metrics: [m(5 * H, 10, { pool: pool("Gemini") }), m(7 * DAY, 20, { pool: pool("Other") })] })!;
    expect(u.groups).toHaveLength(1); expect(u.groups[0]).not.toHaveProperty("pool"); expect(JSON.stringify(u)).not.toContain("Gemini");
  });
  it("stale is said, and only when it is", () => {
    expect(accountUsage("claude-code", { metrics: [m(5 * H, 10)], stale: true })?.stale).toBe(true);
    expect(accountUsage("claude-code", { metrics: [m(5 * H, 10)] })).not.toHaveProperty("stale");
  });
  it("Kiro's monthly credits (a percent with no length, only its period) are one monthly window", () => {
    expect(accountUsage("kiro-cli", { metrics: [{ type: "percent", used: 41.2, quotaPeriod: "monthly", resetsAt: "r" }] })).toEqual({ groups: [{ windows: [{ kind: "monthly", percent: 41, resetsAt: "r" }] }] });
  });
});

describe("accountUsage: a pool that has reset since the read (a window that has reset is kept, flagged)", () => {
  const now = Date.parse("2026-11-08T12:00:00Z"), iso = (ms: number) => new Date(now + ms).toISOString();
  it("marked by the snapshot (`resetPassed`), or its reset time is behind `now` because a snapshot is served unchanged inside its TTL: the window stays, flagged", () => {
    expect(accountUsage("claude-code", { metrics: [m(5 * H, 99, { resetPassed: true })] }, now)!.groups[0]!.windows[0]).toMatchObject({ kind: "session", percent: 99, resetPassed: true });
    expect(accountUsage("claude-code", { metrics: [m(5 * H, 99, { resetsAt: iso(-1000) })] }, now)!.groups[0]!.windows[0]).toMatchObject({ resetPassed: true });
    expect(accountUsage("claude-code", { metrics: [m(5 * H, 99, { resetsAt: iso(0) })] }, now)!.groups[0]!.windows[0]).toMatchObject({ resetPassed: true });          // reset exactly now: it has reset
    expect(accountUsage("claude-code", { metrics: [m(5 * H, 99, { resetsAt: iso(1000) })] }, now)!.groups[0]!.windows[0]).not.toHaveProperty("resetPassed");
  });
  it("another window of the account is not touched by it", () => {
    const w = accountUsage("claude-code", { metrics: [m(5 * H, 99, { resetsAt: iso(-1) }), m(7 * DAY, 28, { resetsAt: iso(DAY) })] }, now)!.groups[0]!.windows;
    expect(w.map((x) => [x.kind, x.resetPassed === true])).toEqual([["session", true], ["weekly", false]]);
  });
  it("an expiry is not a reset and a reset time that cannot be read says nothing: both are left alone (as ageMetric has it)", () => {
    const only = (extra: Record<string, unknown>) => accountUsage("claude-code", { metrics: [m(5 * H, 40, extra)] }, now)!.groups[0]!.windows[0]!;
    expect(only({ resetsAt: iso(-H), resetKind: "expiry" })).not.toHaveProperty("resetPassed");
    expect(only({ resetsAt: "not a time" })).not.toHaveProperty("resetPassed");
    expect(only({ resetsAt: undefined })).not.toHaveProperty("resetPassed");
    expect(only({ resetsAt: 12345 })).not.toHaveProperty("resetPassed");                                  // not a string: not a reset time
  });
  it("a snapshot read just before the reset and projected after it: the number is current before and flagged after", () => {
    const readAt = Date.parse("2026-11-08T12:00:00Z"), resetsAt = new Date(readAt + 2000).toISOString();
    const snapshot = { metrics: [m(5 * H, 99, { resetsAt })] };            // the same cached object, as the usage cache serves it
    expect(accountUsage("claude-code", snapshot, readAt + 1000)!.groups[0]!.windows[0]).not.toHaveProperty("resetPassed");
    expect(accountUsage("claude-code", snapshot, readAt + 2000)!.groups[0]!.windows[0]).toMatchObject({ resetPassed: true });
  });
  it("it uses the clock when no time is given", () => {
    const soon = new Date(Date.now() + H).toISOString(), gone = new Date(Date.now() - H).toISOString();
    expect(accountUsage("claude-code", { metrics: [m(5 * H, 50, { resetsAt: soon })] })!.groups[0]!.windows[0]).not.toHaveProperty("resetPassed");
    expect(accountUsage("claude-code", { metrics: [m(5 * H, 50, { resetsAt: gone })] })!.groups[0]!.windows[0]).toMatchObject({ resetPassed: true });
  });
});

describe("accountUsage: several pools (Antigravity)", () => {
  const agy = [
    m(5 * H, 12, { pool: pool("Gemini") }), m(7 * DAY, 31, { pool: pool("Gemini") }),
    m(5 * H, 38, { pool: pool("Claude & others") }), m(7 * DAY, 64, { pool: pool("Claude & others") }),
    { type: "percent", used: 40, resetsAt: "r", pool: pool("Gemini 4 Argon") },                          // one number, no window of its own
  ];
  it("a group per pool, in the payload's order, each with ALL of its windows — none is hidden behind another pool's", () => {
    const groups = accountUsage("antigravity", { metrics: agy })!.groups;
    expect(groups.map((g) => g.pool?.label)).toEqual(["Gemini", "Claude & others", "Gemini 4 Argon"]);
    expect(groups.map((g) => g.windows.map((w) => [w.kind, w.percent]))).toEqual([[["session", 12], ["weekly", 31]], [["session", 38], ["weekly", 64]], [["unwindowed", 40]]]);
    expect(groups[2]!.windows[0]).not.toHaveProperty("windowMs");
  });
  it("a pool carries only the bounded name: a label and the panel's own word reference, nothing else a vendor sent", () => {
    const g = accountUsage("antigravity", { metrics: [m(5 * H, 1, { pool: { ...pool("Gemini"), secret: "x", labelI18n: { key: "usage.metric.named", args: ["Gemini"], extra: 1 } } })] })!.groups[0]!;
    expect(g.pool).toEqual({ label: "Gemini", labelI18n: { key: "usage.metric.named", args: ["Gemini"] } });
    expect(accountUsage("antigravity", { metrics: [m(5 * H, 1, { pool: { label: "x".repeat(65) } })] })!.groups[0]).not.toHaveProperty("pool");     // an over-long label is no pool name
    expect(accountUsage("antigravity", { metrics: [m(5 * H, 1, { pool: { label: "A", labelI18n: { key: "not.a.usage.word" } } })] })!.groups[0]!.pool).toEqual({ label: "A" });
  });
  it("a window with no pool in such a payload sits in a group of its own with no name; a pool is never merged into it", () => {
    const groups = accountUsage("antigravity", { metrics: [m(5 * H, 1, { pool: pool("Gemini") }), m(7 * DAY, 2)] })!.groups;
    expect(groups.map((g) => g.pool?.label ?? null)).toEqual(["Gemini", null]);
  });
  it("a pool whose 5h window has reset is still a pool, with its other windows", () => {
    const groups = accountUsage("antigravity", { metrics: [m(5 * H, 12, { pool: pool("Gemini"), resetPassed: true }), m(7 * DAY, 31, { pool: pool("Gemini") })] })!.groups;
    expect(groups).toHaveLength(1); expect(groups[0]!.windows.map((w) => [w.kind, w.resetPassed === true])).toEqual([["session", true], ["weekly", false]]);
  });
});

const base: AccountsInput = {
  targets: [{ backend: "claude-code", state: "usable", signIn: true }, { backend: "claude-code", profile: "work", state: "usable", signIn: true }],
  diskProfiles: new Map(), agents: [], classic: [], fleetDefaults: new Map(),
  usage: new Map([
    ["claude-code\0", { groups: [{ windows: [{ kind: "session" as const, percent: 76, windowMs: 5 * H, resetsAt: "2026-11-07T16:00:00Z" }, { kind: "weekly" as const, percent: 28, windowMs: 7 * DAY }] }] }],
    ["claude-code\0work", { stale: true as const, groups: [{ windows: [{ kind: "weekly" as const, percent: 42, windowMs: 7 * DAY }] }] }],
  ]),
};

describe("buildAccountsView with the account's limits", () => {
  it("the row carries its groups (and says when they are the last known ones); a row without usage has neither key", () => {
    const rows = buildAccountsView(base).clis[0]!.rows;
    const def = rows.find((r) => r.profile === null)!, work = rows.find((r) => r.profile === "work")!;
    expect(def.usageGroups).toEqual(base.usage!.get("claude-code\0")!.groups); expect(def).not.toHaveProperty("usageStale");
    expect([work.usageGroups![0]!.windows.map((w) => w.percent), work.usageStale]).toEqual([[42], true]);
    const none = buildAccountsView({ ...base, usage: undefined }).clis[0]!.rows[0]!;
    expect(none).not.toHaveProperty("usageGroups"); expect(none).not.toHaveProperty("usageStale");
  });
  it("none of the two fixed windows the row used to carry is on the wire any more", () => {
    const json = JSON.stringify(buildAccountsView(base));
    expect(json).not.toContain('"shortUsage"'); expect(json).not.toContain('"usage":');
  });
  it("a paired computer's rows get no usage", () => {
    const v = buildAccountsView({ ...base, machines: [{ id: "m1", name: "Desk PC", online: true, agents: [], defaultLogin: { loggedIn: true },
      profiles: [{ name: "home", loggedIn: true, created: true }] }] });
    const machineRows = v.clis[0]!.rows.filter((r) => r.scope.kind === "machine");
    expect(machineRows.map((r) => r.profile)).toEqual([null, "home"]);
    expect(machineRows.every((r) => !("usageGroups" in r) && !("usageStale" in r))).toBe(true);
  });
});

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.mocked(getUsageSnapshot).mockReset(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("FleetManager.accountsView takes every window from one usage snapshot", () => {
  const fleet = () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-accounts-win-")); dirs.push(dir);
    const work = join(dir, "w"); mkdirSync(work);
    mkdirSync(join(dir, "credential-profiles", "claude-code", "work"), { recursive: true });
    const path = join(dir, "fleet.yaml");
    writeFileSync(path, `defaults:\n  backend: claude-code\ninstances:\n  dev:\n    working_directory: ${work}\n`);
    const fm = new FleetManager(dir); fm.loadConfig(path);
    vi.spyOn(fm as any, "refreshSignInIdentities").mockImplementation(() => {});
    return fm;
  };
  it("the default and a named account each get their own windows; a model quota is left out, a reset-passed window is kept and flagged", async () => {
    const fm = fleet();
    const pid = usageProviderIdForBackend("claude-code")!;
    expect(pid).toBeTruthy();
    vi.mocked(getUsageSnapshot).mockResolvedValue({ providers: [
      { id: pid, metrics: [m(5 * H, 76), m(7 * DAY, 28), m(5 * H, 99, { scope: "model" })] },
      { id: `${pid}:work`, stale: true, metrics: [m(5 * H, 90, { resetPassed: true }), m(7 * DAY, 42)] },
    ] } as never);
    const claude = (await fm.accountsView(500)).clis.find((c) => c.backend === "claude-code")!;
    const def = claude.rows.find((r) => r.profile === null)!, named = claude.rows.find((r) => r.profile === "work")!;
    expect(def.usageGroups![0]!.windows.map((w) => [w.kind, w.percent, w.windowMs])).toEqual([["session", 76, 5 * H], ["weekly", 28, 7 * DAY]]);
    expect(named.usageGroups![0]!.windows.map((w) => [w.kind, w.percent, w.resetPassed === true])).toEqual([["session", 90, true], ["weekly", 42, false]]);
    expect([def.usageStale, named.usageStale]).toEqual([undefined, true]);
  });
  it("a window whose reset time is behind the clock is flagged, one still ahead is not (the snapshot is served unchanged inside its TTL)", async () => {
    const fm = fleet();
    const pid = usageProviderIdForBackend("claude-code")!;
    const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
    vi.mocked(getUsageSnapshot).mockResolvedValue({ providers: [
      { id: pid, metrics: [m(5 * H, 99, { resetsAt: ahead(-5000) }), m(7 * DAY, 28, { resetsAt: ahead(2 * DAY) })] },
    ] } as never);
    const def = (await fm.accountsView(500)).clis.find((c) => c.backend === "claude-code")!.rows.find((r) => r.profile === null)!;
    expect(def.usageGroups![0]!.windows.map((w) => [w.kind, w.resetPassed === true])).toEqual([["session", true], ["weekly", false]]);
  });
});
