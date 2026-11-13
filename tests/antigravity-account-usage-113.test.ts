/**
 * AGEND-113 follow-up (Settings → Accounts, Antigravity on this host):
 *  1. the account: the `id_token_email` (the whole address) of agy's token file, read locally, shown only for a sign-in the host already shows as signed in; the token itself never leaves the reader;
 *  2. the usage after a dashboard sign-in: read once more NOW through the panel's own forced read, so `FORCE_FLOOR_MS`, a Retry-After window and the one-fetch-at-a-time rule all still hold;
 *  3. the quota pools (Gemini, Claude & others, Gemini 4 Argon): the row shows EVERY pool and EVERY window the account reports, none picked over another.
 * Fixtures only (example.com); no network, no real credential.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAntigravityToken, parseClaudeAuthStatus } from "../src/claude-auth-status.js";
import { readAntigravityIdentity } from "../src/antigravity-identity.js";
import { authIdentitySupported, checkAuthIdentity } from "../src/login-flows.js";
import { accountUsage, buildAccountsView } from "../src/accounts-view.js";
import { clearUsageSignInRefreshForTests, getUsageSnapshot, refreshUsageAfterSignIn, setUsageFetcherForTests } from "../src/usage/usage-api.js";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), "agend-agy-113-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const EMAIL = "ada.lovelace@example.com";
const SECRETS = ["ya29.ACCESS-SECRET-NEVER-SHOWN", "1//REFRESH-SECRET-NEVER-SHOWN", "eyJ.ID-TOKEN-SECRET-NEVER-SHOWN"];
const tokenText = (extra: Record<string, unknown> = {}) => JSON.stringify({ token: { access_token: SECRETS[0], refresh_token: SECRETS[1], expiry: "2026-11-09T00:00:00Z" }, id_token: SECRETS[2], auth_method: "oauth", id_token_email: EMAIL, ...extra });
const home = (text: string | null, mode = 0o600): string => {
  const dir = scratch(); mkdirSync(join(dir, "antigravity-cli"), { recursive: true });
  if (text !== null) { const file = join(dir, "antigravity-cli", "antigravity-oauth-token"); writeFileSync(file, text, { mode }); chmodSync(file, mode); }
  return dir;
};

describe("the account of an Antigravity sign-in", () => {
  it("is the whole id_token_email and nothing else of the file: no token, no expiry, no plan", () => {
    expect(parseAntigravityToken(tokenText())).toEqual({ maskedEmail: EMAIL });
    const out = JSON.stringify(parseAntigravityToken(tokenText()));
    for (const secret of [...SECRETS, "oauth", "2026-11-09"]) expect(out).not.toContain(secret);
    // The same validation as Claude's: the whole address.
    expect(parseAntigravityToken(tokenText({ id_token_email: "ab@example.com" }))).toEqual({ maskedEmail: "ab@example.com" });
    expect(parseAntigravityToken(tokenText({ id_token_email: "ada@example.com" }))?.maskedEmail).toBe(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, email: "ada@example.com" })).maskedEmail);
  });
  it("gives nothing for an address that is missing, empty, not ASCII, not one address or too long, and for text that is not a JSON object or is too big", () => {
    for (const bad of [undefined, null, 5, "", "   ", "no-at-sign", "a@b@example.com", "@example.com", "ada lovelace@example.com", "ada@exämple.com", "ädä@example.com", `${"a".repeat(260)}@example.com`, "ada@", "ada@localhost"]) {
      expect(parseAntigravityToken(JSON.stringify({ token: {}, id_token_email: bad })), JSON.stringify(bad)).toBeUndefined();
    }
    for (const text of ["", "not json", "[]", "null", "5", '"x"', JSON.stringify({ email: EMAIL }), "x".repeat(70_000), undefined, 5]) expect(parseAntigravityToken(text as never)).toBeUndefined();
  });
  it("is read from agy's file under GEMINI_HOME (else the home's .gemini), locally, and gives nothing for a missing, linked or oversized file", () => {
    const dir = home(tokenText());
    expect(readAntigravityIdentity({ GEMINI_HOME: dir }, "/nonexistent")).toEqual({ maskedEmail: EMAIL });
    const underHome = scratch(); mkdirSync(join(underHome, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(join(underHome, ".gemini", "antigravity-cli", "antigravity-oauth-token"), tokenText({ id_token_email: "zed@example.com" }));
    expect(readAntigravityIdentity({}, underHome)).toEqual({ maskedEmail: "zed@example.com" });
    expect(readAntigravityIdentity({ GEMINI_HOME: dir }, underHome)).toEqual({ maskedEmail: EMAIL });   // GEMINI_HOME wins, as everywhere else
    expect(readAntigravityIdentity({ GEMINI_HOME: home(null) }, "/nonexistent")).toBeUndefined();                      // signed out: no file
    const linked = home(null); const real = join(scratch(), "real-token"); writeFileSync(real, tokenText());
    symlinkSync(real, join(linked, "antigravity-cli", "antigravity-oauth-token"));
    expect(readAntigravityIdentity({ GEMINI_HOME: linked }, "/nonexistent")).toBeUndefined();                          // never follows a link
    expect(readAntigravityIdentity({ GEMINI_HOME: home("x".repeat(70_000)) }, "/nonexistent")).toBeUndefined();
    expect(readAntigravityIdentity({ GEMINI_HOME: home("{ nope") }, "/nonexistent")).toBeUndefined();
  });
  it("is the host's identity for Antigravity (no process is started, nothing is asked of the network), and Claude's is unchanged", async () => {
    expect(authIdentitySupported("antigravity")).toBe(true); expect(authIdentitySupported("claude-code")).toBe(true);
    for (const other of ["codex", "kiro-cli", "grok", "muse"]) expect(authIdentitySupported(other), other).toBe(false);
    const fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
    try {
      expect(await checkAuthIdentity("antigravity", { GEMINI_HOME: home(tokenText()) })).toEqual({ maskedEmail: EMAIL });
      expect(await checkAuthIdentity("antigravity", { GEMINI_HOME: home(null) })).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("FleetManager: the account is read only for an Antigravity sign-in that is signed in, and forgotten when a sign-in finishes", () => {
  const makeFleet = (geminiHome: string) => {
    const dir = scratch(); const fm = new FleetManager(dir) as any;
    fm.fleetConfig = { defaults: {}, instances: {} };
    const previous = process.env.GEMINI_HOME; process.env.GEMINI_HOME = geminiHome;
    restore = () => { if (previous === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = previous; };
    return fm;
  };
  let restore: () => void = () => {};
  afterEach(() => { restore(); vi.restoreAllMocks(); });
  const settle = async (fm: any) => { await Promise.all([...fm.signInIdentityReads.values()]); await new Promise(r => setTimeout(r, 5)); };

  it("shows the whole address on the signed-in row, never on a signed-out one, and nothing of the token reaches the view", async () => {
    const fm = makeFleet(home(tokenText()));
    const rows = (state: string) => vi.spyOn(fm, "backendAvailabilityRows").mockReturnValue([{ backend: "antigravity", state, version: "1.5.3" }] as never);
    rows("usable"); fm.refreshSignInIdentities(); await settle(fm);
    expect(fm.backendSignInTargets()).toEqual([{ backend: "antigravity", state: "usable", signIn: true, identity: { maskedEmail: EMAIL } }]);
    const view = buildAccountsView({ targets: fm.backendSignInTargets(), diskProfiles: new Map(), agents: [], classic: [], fleetDefaults: new Map() });
    expect(view.clis.find(c => c.backend === "antigravity")!.rows[0]).toMatchObject({ identity: { maskedEmail: EMAIL } });
    expect(JSON.stringify(view)).not.toMatch(new RegExp(SECRETS.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")));
    // Signed out (the row says so): not read, not shown — even though the file is there.
    fm.forgetSignInIdentities(); rows("not_signed_in"); fm.refreshSignInIdentities(); await settle(fm);
    expect(fm.backendSignInTargets()[0]).not.toHaveProperty("identity");
  });
  it("is read again after a sign-in finishes (a different account may be there now), and a read that began before is dropped", async () => {
    const dir = home(tokenText());
    const fm = makeFleet(dir);
    vi.spyOn(fm, "backendAvailabilityRows").mockReturnValue([{ backend: "antigravity", state: "usable", version: "1.5.3" }] as never);
    fm.refreshSignInIdentities(); await settle(fm);
    expect(fm.backendSignInTargets()[0].identity).toEqual({ maskedEmail: EMAIL });
    writeFileSync(join(dir, "antigravity-cli", "antigravity-oauth-token"), tokenText({ id_token_email: "grace@example.com" }));
    fm.refreshSignInIdentities(); await settle(fm);
    expect(fm.backendSignInTargets()[0].identity).toEqual({ maskedEmail: EMAIL });      // read in the last five minutes: not read again by a page poll
    const done = fm.browserBackendSignIns.deps.changed;
    done({ backend: "antigravity", phase: "done" }, {}, false);                                      // the dashboard's sign-in finished: forgotten
    expect(fm.backendSignInTargets()[0]).not.toHaveProperty("identity");
    fm.refreshSignInIdentities(); await settle(fm);
    expect(fm.backendSignInTargets()[0].identity).toEqual({ maskedEmail: "grace@example.com" });
    fm.browserBackendSignIns.close?.();
  });
});

const payload = (n: number, extra: Record<string, unknown> = {}) => ({ fetchedAt: new Date().toISOString(), providers: [{ id: "claude", name: "Claude", status: "ok", metrics: [{ label: `Weekly ${n}`, type: "percent", used: n, windowMs: 7 * 86_400_000, resetsAt: null }], ...extra }] }) as never;
describe("the usage after a dashboard sign-in", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-08T12:00:00Z")); });
  afterEach(() => { clearUsageSignInRefreshForTests(); setUsageFetcherForTests(null); vi.useRealTimers(); });

  it("does nothing when nothing was ever read (nothing is stale: the next read fetches anyway)", async () => {
    const fetcher = vi.fn(async () => payload(1)); setUsageFetcherForTests(fetcher);
    expect(await refreshUsageAfterSignIn()).toBe(false); expect(fetcher).not.toHaveBeenCalled();
  });
  it("reads once more now, through the forced read, and tells the page; the new numbers are what is served", async () => {
    let n = 0; const fetcher = vi.fn(async () => payload(++n)); setUsageFetcherForTests(fetcher);
    await getUsageSnapshot(false);                                              // the panel's earlier read (before the sign-in)
    expect((await getUsageSnapshot(false)).providers[0]!.metrics[0]!.used).toBe(1); expect(fetcher).toHaveBeenCalledTimes(1);   // the 5-minute cache
    const told = vi.fn();
    expect(await refreshUsageAfterSignIn(told)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(told).toHaveBeenCalledTimes(1);
    expect((await getUsageSnapshot(false)).providers[0]!.metrics[0]!.used).toBe(2);
  });
  it("waits out a read that began before the sign-in (it may hold the old numbers) and then reads again", async () => {
    let n = 0, release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const fetcher = vi.fn(async () => { const mine = ++n; if (mine === 2) await gate; return payload(mine); }); setUsageFetcherForTests(fetcher);
    await getUsageSnapshot(false); vi.setSystemTime(Date.now() + 6 * 60_000);    // cached, then expired
    const before = getUsageSnapshot(false, undefined, {});                       // a read begins (the second fetch, held open)
    await Promise.resolve();
    const refresh = refreshUsageAfterSignIn();
    await Promise.resolve(); expect(fetcher).toHaveBeenCalledTimes(2);           // nothing new is started while it is in flight
    release(); await before; expect(await refresh).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect((await getUsageSnapshot(false)).providers[0]!.metrics[0]!.used).toBe(3);
  });
  it("does not bypass the 30-second floor between forced reads: inside it nothing is fetched at once, and ONE retry is made when it ends", async () => {
    let n = 0; const fetcher = vi.fn(async () => payload(++n)); setUsageFetcherForTests(fetcher);
    await getUsageSnapshot(false); await getUsageSnapshot(true);                 // a forced read (the panel's refresh button) just happened
    expect(fetcher).toHaveBeenCalledTimes(2);
    const told = vi.fn();
    expect(await refreshUsageAfterSignIn(told)).toBe(false); expect(fetcher).toHaveBeenCalledTimes(2); expect(told).not.toHaveBeenCalled();
    expect(await refreshUsageAfterSignIn(told)).toBe(false);                      // a second sign-in right after: still one timer, not two
    await vi.advanceTimersByTimeAsync(29_000); expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetcher).toHaveBeenCalledTimes(3); expect(told).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000); expect(fetcher).toHaveBeenCalledTimes(3);   // and no more
  });
  it("does not bypass a Retry-After window: the cache stands, nothing is fetched and no retry is scheduled", async () => {
    let n = 0;
    const limited = () => ({ fetchedAt: new Date().toISOString(), providers: [{ id: "claude", name: "Claude", status: "error", error: "rate limited (429)", hint: "retry-after:300", metrics: [] }] }) as never;
    const fetcher = vi.fn(async () => (++n === 1 ? limited() : payload(n))); setUsageFetcherForTests(fetcher);
    await getUsageSnapshot(false);                                                // the provider answered 429 with Retry-After: 300
    expect(fetcher).toHaveBeenCalledTimes(1);
    const told = vi.fn();
    expect(await refreshUsageAfterSignIn(told)).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(told).not.toHaveBeenCalled();
  });
  it("a failed read leaves the cache as it was and never throws", async () => {
    let n = 0; const fetcher = vi.fn(async () => { if (++n === 1) return payload(1); throw new Error("network down"); }); setUsageFetcherForTests(fetcher);
    await getUsageSnapshot(false);
    await expect(refreshUsageAfterSignIn()).resolves.toBe(false);
    expect((await getUsageSnapshot(false)).providers[0]!.metrics[0]!.used).toBe(1);
  });
  it("FleetManager does it for a finished dashboard sign-in (the host's, and a named account's), never for one that did not finish, and the page is told to read again", async () => {
    let n = 0; const fetcher = vi.fn(async () => payload(++n)); setUsageFetcherForTests(fetcher);
    const dir = scratch(); const fm = new FleetManager(dir) as any; fm.fleetConfig = { defaults: {}, instances: {} };
    const sse = vi.spyOn(fm, "usageAfterSignIn");
    await getUsageSnapshot(false);
    fm.browserBackendSignIns.deps.changed({ backend: "antigravity", phase: "starting" }, {}, false);
    fm.browserBackendSignIns.deps.changed({ backend: "antigravity", phase: "failed", reason: "provider_rejected" }, {}, false);
    expect(sse).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
    fm.browserBackendSignIns.deps.changed({ backend: "antigravity", phase: "done" }, {}, false);
    await vi.advanceTimersByTimeAsync(10);
    expect(sse).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(40_000);
    fm.profileSignIns.deps.changed({ backend: "claude-code", profile: "work", phase: "done" }, {}, false);
    await vi.advanceTimersByTimeAsync(10);
    expect(sse).toHaveBeenCalledTimes(2); expect(fetcher).toHaveBeenCalledTimes(3);
    fm.browserBackendSignIns.close?.(); fm.profileSignIns.close?.();
  });
});

/** The moment the fixtures' numbers were read (their reset times are a day later): a fixed clock, so a window is "reset" only where a test says so. */
const READ_AT = Date.parse("2026-11-10T12:00:00Z");
const metric = (label: string, pool: string | null, used: number, hours: number | null, extra: Record<string, unknown> = {}) => ({
  label, type: "percent", used, ...(hours === null ? {} : { windowMs: hours * 3_600_000 }), resetsAt: "2026-11-11T01:56:41Z",
  ...(pool ? { pool: { label: pool, ...(pool === "Claude & others" ? { labelI18n: { key: "usage.metric.agy_claude_others" } } : { labelI18n: { key: "usage.metric.named", args: [pool] } }) } } : {}), ...extra,
});
// The real shape (agy 1.5.3, Google AI Ultra): two pools with a 5h and a weekly window, and a per-model quota with no window.
const AGY = { metrics: [
  metric("Gemini (session)", "Gemini", 0.26, 5), metric("Gemini (weekly)", "Gemini", 12.98, 168),
  metric("Claude & others (session)", "Claude & others", 0, 5), metric("Claude & others (weekly)", "Claude & others", 38.58, 168),
  metric("Gemini 4 Argon", "Gemini 4 Argon", 0.3, null),
] };
describe("Antigravity's quota pools on its account row: every pool, every window", () => {
  it("the real shape: Gemini's 5h AND week, Claude & others' 5h AND week, and Argon's one number — the row used to show Gemini's 5h and Claude & others' week only", () => {
    const groups = accountUsage("antigravity", AGY)!.groups;
    expect(groups.map((g) => g.pool?.label)).toEqual(["Gemini", "Claude & others", "Gemini 4 Argon"]);
    expect(groups.map((g) => g.windows.map((w) => [w.kind, w.percent]))).toEqual([[["session", 0], ["weekly", 13]], [["session", 0], ["weekly", 39]], [["unwindowed", 0]]]);
    expect(groups[0]!.windows[0]).toMatchObject({ windowMs: 5 * 3_600_000, resetsAt: "2026-11-11T01:56:41Z" });
    expect(groups[2]!.windows[0]).not.toHaveProperty("windowMs");
  });
  it("follows the numbers and not their size: a pool that is the less used is still there, and so is its week", () => {
    const flip = { metrics: AGY.metrics.map((m) => (m.label === "Gemini (weekly)" ? { ...m, used: 71 } : m)) };
    expect(accountUsage("antigravity", flip)!.groups.map((g) => g.windows.map((w) => w.percent))).toEqual([[0, 71], [0, 39], [0]]);
  });
  it("a pool is a group in the order the payload (and so the full card) lists it, whatever its numbers", () => {
    const tie = { metrics: [metric("A (weekly)", "A", 20, 168), metric("B (weekly)", "B", 20, 168)] };
    expect(accountUsage("antigravity", tie)!.groups.map((g) => g.pool?.label)).toEqual(["A", "B"]);
    expect(accountUsage("antigravity", { metrics: [...tie.metrics].reverse() })!.groups.map((g) => g.pool?.label)).toEqual(["B", "A"]);
  });
  it("a model quota is never a window of a pool, and a pool whose 5h window has reset keeps its week", () => {
    const m = { metrics: [metric("p-5h", "P", 10, 5), metric("p-w", "P", 5, 168), metric("q-5h", "Q", 99, 5, { resetPassed: true }), metric("q-w", "Q", 4, 168), metric("q-model", "Q", 99, 168, { scope: "model" })] };
    expect(accountUsage("antigravity", m, READ_AT)!.groups.map((g) => g.windows.map((w) => [w.percent, w.resetPassed === true]))).toEqual([[[10, false], [5, false]], [[99, true], [4, false]]]);
  });
  it("a provider with one set of limits carries no pool (Claude, Codex)", () => {
    const claude = { metrics: [metric("Session", null, 11, 5), metric("Weekly", null, 27, 168)] };
    expect(accountUsage("claude-code", claude, READ_AT)!.groups).toEqual([{ windows: [{ kind: "session", percent: 11, windowMs: 5 * 3_600_000, resetsAt: "2026-11-11T01:56:41Z" }, { kind: "weekly", percent: 27, windowMs: 168 * 3_600_000, resetsAt: "2026-11-11T01:56:41Z" }] }]);
    expect(accountUsage("claude-code", { metrics: [] })).toBeUndefined(); expect(accountUsage("antigravity", undefined)).toBeUndefined();
  });
  it("passes on only a bounded pool: a short label and the panel's own `usage.metric.*` reference with up to three short string arguments; anything else is dropped", () => {
    const pooled = (pool: unknown) => accountUsage("antigravity", { metrics: [{ ...metric("a", null, 50, 168), pool }, metric("b (weekly)", "B", 10, 168)] })!.groups[0]!.pool;
    expect(pooled({ label: "X", labelI18n: { key: "usage.metric.named", args: ["X"] } })).toEqual({ label: "X", labelI18n: { key: "usage.metric.named", args: ["X"] } });
    expect(pooled({ label: "X", labelI18n: { key: "usage.hint.login_agy" } })).toEqual({ label: "X" });                          // not a metric word
    expect(pooled({ label: "X", labelI18n: { key: "usage.metric.named", args: [5] } })).toEqual({ label: "X" });
    expect(pooled({ label: "X", labelI18n: { key: "usage.metric.named", args: ["a", "b", "c", "d"] } })).toEqual({ label: "X" });
    expect(pooled({ label: "X", labelI18n: { key: "usage.metric.NAMED" } })).toEqual({ label: "X" });
    expect(pooled({ label: "x".repeat(65) })).toBeUndefined(); expect(pooled({ label: "" })).toBeUndefined(); expect(pooled("Gemini")).toBeUndefined(); expect(pooled(null)).toBeUndefined();
    expect(JSON.stringify(pooled({ label: "X", labelI18n: { key: "usage.metric.named", args: ["X"], extra: "<script>" }, other: "y" }))).not.toMatch(/script|other|extra/);
  });
  it("the row carries it (the host's Antigravity default row), beside the account", () => {
    const view = buildAccountsView({ targets: [{ backend: "antigravity", state: "usable", signIn: true, identity: { maskedEmail: EMAIL } }], diskProfiles: new Map(), agents: [], classic: [], fleetDefaults: new Map(),
      usage: new Map([["antigravity\0", accountUsage("antigravity", AGY)!]]) });
    const row = view.clis.find((c) => c.backend === "antigravity")!.rows[0]!;
    expect(row).toMatchObject({ identity: { maskedEmail: EMAIL } });
    expect(row.usageGroups!.map((g) => g.pool?.label)).toEqual(["Gemini", "Claude & others", "Gemini 4 Argon"]);
  });
});
