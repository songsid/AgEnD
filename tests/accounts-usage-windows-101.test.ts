/**
 * AGEND-101, the usage block of Settings → Accounts: the short window ("5h") beside the week's.
 * - shortUsage(provider): the percent metric under two days (the shortest when several), never a per-model quota, never a window that has
 *   reset since the read; same shape as weeklyUsage, which is unchanged (the week's window, the row's `usage`).
 * - buildAccountsView: `shortUsage` reaches the host rows (default and named); a computer's rows get none; `usage` stays the week's.
 * - FleetManager.accountsView(): both windows are taken from one usage snapshot, per account (the default and `:<profile>` providers).
 * Fixtures only (example.com).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/usage/usage-api.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/usage/usage-api.js")>()), getUsageSnapshot: vi.fn() }));
import { getUsageSnapshot, usageProviderIdForBackend } from "../src/usage/usage-api.js";
import { FleetManager } from "../src/fleet-manager.js";
import { buildAccountsView, shortUsage, weeklyUsage, type AccountsInput } from "../src/accounts-view.js";

const H = 3_600_000, DAY = 86_400_000;
const m = (windowMs: number, used: number, extra: Record<string, unknown> = {}) => ({ type: "percent", used, windowMs, resetsAt: `r${windowMs}`, ...extra });

describe("shortUsage (AGEND-101)", () => {
  it("the percent metric under two days; the shortest of several; rounded and kept within 0–100", () => {
    expect(shortUsage({ metrics: [m(7 * DAY, 41.6), m(5 * H, 75.6)] })).toEqual({ percent: 76, windowMs: 5 * H, resetsAt: `r${5 * H}` });
    expect(shortUsage({ metrics: [m(24 * H, 10), m(5 * H, 20), m(12 * H, 30)] })?.windowMs).toBe(5 * H);
    expect(shortUsage({ metrics: [m(5 * H, 140)] })?.percent).toBe(100);
    expect(shortUsage({ metrics: [m(5 * H, -3)] })?.percent).toBe(0);
    expect(shortUsage({ metrics: [m(5 * H, 50, { resetsAt: undefined })] })).toEqual({ percent: 50, windowMs: 5 * H });      // no reset time: none said
  });
  it("never a per-model quota, a window that has reset since the read, a non-percent metric, or a window that is not under two days", () => {
    expect(shortUsage({ metrics: [m(5 * H, 90, { scope: "model" })] })).toBeUndefined();
    expect(shortUsage({ metrics: [m(5 * H, 90, { resetPassed: true })] })).toBeUndefined();
    expect(shortUsage({ metrics: [{ type: "count", used: 3, windowMs: 5 * H }] })).toBeUndefined();
    expect(shortUsage({ metrics: [{ type: "percent", windowMs: 5 * H }] })).toBeUndefined();                                // no `used`
    expect(shortUsage({ metrics: [m(2 * DAY, 10), m(7 * DAY, 10), m(0, 10), { type: "percent", used: 10 }] })).toBeUndefined();
    expect(shortUsage({ metrics: [m(5 * H, 90, { resetPassed: true }), m(8 * H, 33)] })?.percent).toBe(33);                 // a usable one is still found
    expect(shortUsage({ metrics: [] })).toBeUndefined();
    expect(shortUsage(undefined)).toBeUndefined();
    expect(shortUsage({} as never)).toBeUndefined();
  });
  it("stale is said, as weeklyUsage does", () => {
    expect(shortUsage({ metrics: [m(5 * H, 10)], stale: true })?.stale).toBe(true);
    expect(shortUsage({ metrics: [m(5 * H, 10)] })).not.toHaveProperty("stale");
  });
  it("weeklyUsage is unchanged: the week's window, whether or not a short one is there", () => {
    const metrics = [m(5 * H, 76), m(7 * DAY, 28)];
    expect(weeklyUsage({ metrics })).toEqual({ percent: 28, windowMs: 7 * DAY, resetsAt: `r${7 * DAY}` });
    expect(weeklyUsage({ metrics: [m(5 * H, 76)] })).toBeUndefined();                       // only a short window: no week
    expect(shortUsage({ metrics: [m(7 * DAY, 28)] })).toBeUndefined();                      // only a week: no short window
  });
});

const base: AccountsInput = {
  targets: [{ backend: "claude-code", state: "usable", signIn: true }, { backend: "claude-code", profile: "work", state: "usable", signIn: true }],
  diskProfiles: new Map(), agents: [], classic: [], fleetDefaults: new Map(),
  usage: new Map([["claude-code\0", { percent: 28, windowMs: 7 * DAY }], ["claude-code\0work", { percent: 42, windowMs: 7 * DAY }]]),
  shortUsage: new Map([["claude-code\0", { percent: 76, windowMs: 5 * H, resetsAt: "2026-11-07T16:00:00Z" }]]),
};

describe("buildAccountsView with the short window (AGEND-101)", () => {
  it("the row carries both windows; `usage` stays the week's; a row without a short window has none", () => {
    const rows = buildAccountsView(base).clis[0]!.rows;
    const def = rows.find((r) => r.profile === null)!, work = rows.find((r) => r.profile === "work")!;
    expect([def.usage?.percent, def.shortUsage]).toEqual([28, { percent: 76, windowMs: 5 * H, resetsAt: "2026-11-07T16:00:00Z" }]);
    expect([work.usage?.percent, "shortUsage" in work]).toEqual([42, false]);
  });
  it("without any short window the view is what it was (no `shortUsage` key anywhere)", () => {
    const v = buildAccountsView({ ...base, shortUsage: undefined });
    expect(JSON.stringify(v)).not.toContain("shortUsage");
    expect(v.clis[0]!.rows.find((r) => r.profile === "work")!.usage?.percent).toBe(42);
  });
  it("a paired computer's rows get no usage of either window", () => {
    const v = buildAccountsView({ ...base, machines: [{ id: "m1", name: "Desk PC", online: true, agents: [], defaultLogin: { loggedIn: true },
      profiles: [{ name: "home", loggedIn: true, created: true }] }] });
    const machineRows = v.clis[0]!.rows.filter((r) => r.scope.kind === "machine");
    expect(machineRows.map((r) => r.profile)).toEqual([null, "home"]);
    expect(machineRows.every((r) => !("usage" in r) && !("shortUsage" in r))).toBe(true);
  });
});

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.mocked(getUsageSnapshot).mockReset(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("FleetManager.accountsView takes both windows from one usage snapshot (AGEND-101)", () => {
  it("the default and a named account each get their own 5h and week; a model quota and a reset-passed window are left out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-accounts-win-")); dirs.push(dir);
    const work = join(dir, "w"); mkdirSync(work);
    mkdirSync(join(dir, "credential-profiles", "claude-code", "work"), { recursive: true });
    const path = join(dir, "fleet.yaml");
    writeFileSync(path, `defaults:\n  backend: claude-code\ninstances:\n  dev:\n    working_directory: ${work}\n`);
    const fm = new FleetManager(dir); fm.loadConfig(path);
    vi.spyOn(fm as any, "refreshSignInIdentities").mockImplementation(() => {});
    const pid = usageProviderIdForBackend("claude-code")!;
    expect(pid).toBeTruthy();
    vi.mocked(getUsageSnapshot).mockResolvedValue({ providers: [
      { id: pid, metrics: [m(5 * H, 76), m(7 * DAY, 28), m(5 * H, 99, { scope: "model" })] },
      { id: `${pid}:work`, stale: true, metrics: [m(5 * H, 90, { resetPassed: true }), m(7 * DAY, 42)] },
    ] } as never);
    const claude = (await fm.accountsView(500)).clis.find((c) => c.backend === "claude-code")!;
    const def = claude.rows.find((r) => r.profile === null)!, named = claude.rows.find((r) => r.profile === "work")!;
    expect([def.shortUsage?.percent, def.shortUsage?.windowMs, def.usage?.percent, def.usage?.windowMs]).toEqual([76, 5 * H, 28, 7 * DAY]);
    expect([named.usage?.percent, named.usage?.stale, "shortUsage" in named]).toEqual([42, true, false]);
  });
});
