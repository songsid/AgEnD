/**
 * #3292: Keep sign-in alive (src/signin-keepalive.ts) — what the readers take out of a sign-in's file (dates and booleans,
 * never a token), when each CLI is due, how failures count into Needs you, and one run per sign-in end to end against a
 * scratch home with the CLI runs replaced (the real CLIs are exercised by scripts/manual/signin-keepalive/).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_REFRESH_WINDOW_MS, CODEX_REFRESH_AFTER_MS, END_WARNING_MS, SETTINGS_FILE, SignInKeepAlive, attentionOf, claudeDue, codexDue, nextRecord,
  readClaudeMeta, readCodexMeta, readEntries, type KeepAliveDeps, type KeepAliveRunners,
} from "../src/signin-keepalive.js";

const DAY = 86_400_000, NOW = Date.UTC(2026, 10, 7, 6, 0, 0);
const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-ka-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

const SECRET_AT = "c".repeat(40), SECRET_RT = "d".repeat(40);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "none" })}.${b64(claims)}.${"s".repeat(16)}`;
function claudeCreds(home: string, o: Record<string, unknown>) {
  writeFileSync(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: SECRET_AT, refreshToken: SECRET_RT, scopes: ["user:inference"], subscriptionType: "team", ...o } }));
}
function codexAuth(home: string, o: { lastRefresh?: number; accessExp?: number; plan?: string; refresh?: string | null } = {}) {
  const tokens: Record<string, unknown> = { access_token: jwt({ exp: Math.floor((o.accessExp ?? NOW + 5 * DAY) / 1000), sig: SECRET_AT }), id_token: jwt({ "https://api.openai.com/auth": { chatgpt_plan_type: o.plan ?? "plus" } }) };
  if (o.refresh !== null) tokens.refresh_token = o.refresh ?? SECRET_RT;
  writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens, ...(o.lastRefresh !== undefined ? { last_refresh: new Date(o.lastRefresh).toISOString() } : {}) }));
}

describe("the readers take dates, booleans and a plan name — never a token", () => {
  it("Claude Code's .credentials.json", () => {
    const h = scratch();
    claudeCreds(h, { expiresAt: NOW + 3600e3, refreshTokenExpiresAt: NOW + 11 * DAY });
    const m = readClaudeMeta(h);
    expect(m).toEqual({ state: "ok", hasRefresh: true, expiresAt: NOW + 3600e3, endsAt: NOW + 11 * DAY, plan: "team" });
    expect(JSON.stringify(m)).not.toMatch(/ccccc|ddddd/);
    expect(readClaudeMeta(scratch())).toEqual({ state: "missing" });
    writeFileSync(join(h, ".credentials.json"), "{not json");
    expect(readClaudeMeta(h)).toEqual({ state: "unreadable" });
    claudeCreds(h, { expiresAt: 0, refreshToken: "" });        // what the CLI leaves after the server refused the refresh token
    expect(readClaudeMeta(h)).toMatchObject({ state: "ok", hasRefresh: false, expiresAt: 0 });
  });
  it("Codex's auth.json: last_refresh, the access token's expiry and the plan claim", () => {
    const h = scratch();
    codexAuth(h, { lastRefresh: NOW - DAY, accessExp: NOW + 9 * DAY, plan: "free" });
    const m = readCodexMeta(join(h, "auth.json"));
    expect(m).toEqual({ state: "ok", hasRefresh: true, lastRefresh: NOW - DAY, accessExp: Math.floor((NOW + 9 * DAY) / 1000) * 1000, planType: "free" });
    expect(JSON.stringify(m)).not.toMatch(/ccccc|ddddd/);
    writeFileSync(join(h, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "e".repeat(20) }));
    expect(readCodexMeta(join(h, "auth.json"))).toEqual({ state: "api_key" });
    expect(readCodexMeta(join(scratch(), "auth.json"))).toEqual({ state: "missing" });
  });
});

describe("when each CLI is due", () => {
  it("Claude Code: expired or within its own five-minute window", () => {
    expect(claudeDue({ expiresAt: NOW + CLAUDE_REFRESH_WINDOW_MS + 1 }, NOW)).toBe(false);
    expect(claudeDue({ expiresAt: NOW + CLAUDE_REFRESH_WINDOW_MS }, NOW)).toBe(true);
    expect(claudeDue({ expiresAt: NOW - 1 }, NOW)).toBe(true);
    expect(claudeDue({}, NOW)).toBe(true);
  });
  it("Codex: six days after the last refresh, an expiring access token, or a refresh dated in the future", () => {
    expect(codexDue({ lastRefresh: NOW - CODEX_REFRESH_AFTER_MS + 1, accessExp: NOW + DAY }, NOW)).toBe(false);
    expect(codexDue({ lastRefresh: NOW - CODEX_REFRESH_AFTER_MS, accessExp: NOW + DAY }, NOW)).toBe(true);
    expect(codexDue({ lastRefresh: NOW - DAY, accessExp: NOW + 60_000 }, NOW)).toBe(true);
    expect(codexDue({ lastRefresh: NOW + 2 * 3600e3 }, NOW)).toBe(true);
    expect(codexDue({}, NOW)).toBe(true);
  });
});

describe("failures into Needs you", () => {
  it("a transient failure waits for its second run, or 48 hours; a success clears it", () => {
    const one = nextRecord(undefined, "transient", NOW);
    expect(one).toMatchObject({ failCount: 1, failSince: NOW }); expect(one.attentionSince).toBeUndefined();
    const two = nextRecord(one, "transient", NOW + DAY);
    expect(two).toMatchObject({ failCount: 2, failSince: NOW, attentionSince: NOW + DAY });
    expect(nextRecord(two, "transient", NOW + 2 * DAY).attentionSince).toBe(NOW + DAY);       // the item keeps its date
    const late = nextRecord({ outcome: "transient", failCount: 1, failSince: NOW - 49 * 3600e3 }, "transient", NOW);
    expect(late).toMatchObject({ failCount: 2, attentionSince: NOW });
    const single48 = nextRecord({ outcome: "transient", failCount: 0, failSince: NOW - 48 * 3600e3 }, "transient", NOW);
    expect(single48.attentionSince).toBe(NOW);
    const ok = nextRecord(two, "refreshed", NOW + 3 * DAY);
    expect(ok.failCount).toBeUndefined(); expect(ok.attentionSince).toBeUndefined(); expect(ok.outcome).toBe("refreshed");
  });
  it("needs_sign_in and not_renewed want attention at once, dated by their first run", () => {
    const a = nextRecord(undefined, "needs_sign_in", NOW);
    expect(a.attentionSince).toBe(NOW);
    expect(nextRecord(a, "needs_sign_in", NOW + DAY).attentionSince).toBe(NOW);
    expect(nextRecord(a, "not_renewed", NOW + DAY).attentionSince).toBe(NOW + DAY);
  });
  it("the end date: from ten days before, whatever else is fine; ended once past; only for a switched-on sign-in", () => {
    const e = (endsAt: number, outcome = "refreshed" as const, enabled = true) => ({ backend: "claude-code" as const, profile: "work", enabled, record: { outcome, endsAt } });
    expect(attentionOf([e(NOW + END_WARNING_MS + 1)], NOW)).toEqual([]);
    expect(attentionOf([e(NOW + END_WARNING_MS)], NOW)).toEqual([{ backend: "claude-code", profile: "work", kind: "ending", since: NOW, endsAt: NOW + END_WARNING_MS }]);
    expect(attentionOf([e(NOW + 3 * DAY)], NOW)[0]).toMatchObject({ kind: "ending", since: NOW + 3 * DAY - END_WARNING_MS });
    expect(attentionOf([e(NOW - 1)], NOW)[0]).toMatchObject({ kind: "ended" });
    expect(attentionOf([e(NOW + DAY, "refreshed", false)], NOW)).toEqual([]);
    expect(attentionOf([{ ...e(NOW + DAY, "needs_sign_in" as never), record: { outcome: "needs_sign_in", endsAt: NOW + DAY, attentionSince: NOW } }], NOW).map(a => a.kind)).toEqual(["needs_sign_in"]);
  });
});

// ── One run, end to end, with the CLI runs replaced ─────────────────────────────────────────────────────────────

interface Fx { ka: SignInKeepAlive; data: string; home: string; runners: { [K in keyof KeepAliveRunners]: ReturnType<typeof vi.fn> }; logs: Array<[string, string, Record<string, unknown>]>; inUse: { v: boolean }; claim: { v: boolean }; released: number[] }
function fixture(backend: "claude-code" | "codex", opts: { profile?: string | null; fallback?: boolean; keychain?: boolean } = {}): Fx {
  const data = scratch(), profile = opts.profile === undefined ? "work" : opts.profile;
  const home = profile ? join(data, "credential-profiles", backend, profile) : join(data, "default-home");
  mkdirSync(home, { recursive: true });
  const runners = { claudeStatus: vi.fn(async () => ({ code: 0, loggedIn: true })), claudeFallback: vi.fn(async () => ({ code: 0 })), codexRefresh: vi.fn(async () => ({ answered: true, accountNull: false })) };
  const logs: Fx["logs"] = [], inUse = { v: false }, claim = { v: true }, released: number[] = [];
  const deps: KeepAliveDeps = {
    dataDir: data, now: () => NOW, log: (l, m, f) => { logs.push([l, m, f]); }, homeOf: () => home,
    acquire: () => inUse.v ? "in_use" : claim.v ? { release: () => { released.push(1); } } : "busy",
    changed: () => {}, runners: runners as unknown as KeepAliveRunners, claudeKeychain: opts.keychain,
  };
  const ka = new SignInKeepAlive(deps);
  expect(ka.set(backend, profile, true, opts.fallback)).toEqual({ ok: true });
  return { ka, data, home, runners, logs, inUse, claim, released };
}
const recordOf = (f: Fx) => f.ka.list()[0]!.record;

describe("Claude Code runs", () => {
  it("expired: `auth status` renews it (expiresAt moved) → refreshed, the end date kept, the window released", async () => {
    const f = fixture("claude-code");
    claudeCreds(f.home, { expiresAt: NOW - 3600e3, refreshTokenExpiresAt: NOW + 11 * DAY });
    f.runners.claudeStatus.mockImplementation(async (dir: string | null) => { expect(dir).toBe(f.home); claudeCreds(f.home, { expiresAt: NOW + 8 * 3600e3, refreshTokenExpiresAt: NOW + 11 * DAY }); return { code: 0, loggedIn: true }; });
    await f.ka.tick({ force: true });
    expect(recordOf(f)).toMatchObject({ outcome: "refreshed", expiresAt: NOW + 8 * 3600e3, endsAt: NOW + 11 * DAY, lastAt: NOW });
    expect(f.runners.claudeFallback).not.toHaveBeenCalled();
    expect(f.released).toEqual([1]);
    // Saved, and the log carries dates and names only.
    expect(readEntries(f.data)[0]!.record).toMatchObject({ outcome: "refreshed" });
    const text = JSON.stringify(f.logs) + readFileSync(join(f.data, SETTINGS_FILE), "utf8");
    expect(text).not.toMatch(/ccccc|ddddd/);
    expect(f.logs.at(-1)![2]).toEqual({ backend: "claude-code", profile: "work", outcome: "refreshed", expiresAt: new Date(NOW + 8 * 3600e3).toISOString(), endsAt: new Date(NOW + 11 * DAY).toISOString() });
  });
  it("not due: nothing runs", async () => {
    const f = fixture("claude-code");
    claudeCreds(f.home, { expiresAt: NOW + 3600e3 });
    await f.ka.tick({ force: true });
    expect(recordOf(f)?.outcome).toBe("not_needed");
    expect(f.runners.claudeStatus).not.toHaveBeenCalled();
  });
  it("not renewed and no fallback allowed → not_renewed (Needs you at once); allowed → the tiny request, then fallback_refreshed", async () => {
    const f = fixture("claude-code");
    claudeCreds(f.home, { expiresAt: NOW - 3600e3 });
    await f.ka.tick({ force: true });
    expect(recordOf(f)).toMatchObject({ outcome: "not_renewed", attentionSince: NOW });
    expect(f.ka.attention().map(a => a.kind)).toEqual(["not_renewed"]);
    expect(f.runners.claudeFallback).not.toHaveBeenCalled();
    const g = fixture("claude-code", { fallback: true });
    claudeCreds(g.home, { expiresAt: NOW - 3600e3 });
    g.runners.claudeFallback.mockImplementation(async () => { claudeCreds(g.home, { expiresAt: NOW + 8 * 3600e3 }); return { code: 0 }; });
    await g.ka.tick({ force: true });
    expect(recordOf(g)).toMatchObject({ outcome: "fallback_refreshed" });
    expect(g.ka.attention()).toEqual([]);
  });
  it("the server refused the refresh token (the CLI blanked the login, yet says signed in) → needs_sign_in; the fallback never runs", async () => {
    const f = fixture("claude-code", { fallback: true });
    claudeCreds(f.home, { expiresAt: NOW - 3600e3 });
    f.runners.claudeStatus.mockImplementation(async () => { claudeCreds(f.home, { expiresAt: 0, accessToken: "", refreshToken: "" }); return { code: 0, loggedIn: true }; });
    await f.ka.tick({ force: true });
    expect(recordOf(f)?.outcome).toBe("needs_sign_in");
    expect(f.runners.claudeFallback).not.toHaveBeenCalled();
  });
  it("a login whose expiry the CLI zeroed is dead even with a refresh token left (needs_sign_in, nothing run)", async () => {
    const f = fixture("claude-code", { fallback: true });
    claudeCreds(f.home, { expiresAt: 0 });
    await f.ka.tick({ force: true });
    expect(recordOf(f)?.outcome).toBe("needs_sign_in");
    expect(f.runners.claudeStatus).not.toHaveBeenCalled();
  });
  it("no file: signed out — unless the login is in the macOS Keychain, where `auth status` answers (checked) with its end date", async () => {
    const f = fixture("claude-code");
    await f.ka.tick({ force: true });
    expect(recordOf(f)?.outcome).toBe("needs_sign_in");
    expect(f.runners.claudeStatus).not.toHaveBeenCalled();
    const g = fixture("claude-code", { keychain: true });
    g.runners.claudeStatus.mockResolvedValue({ code: 0, loggedIn: true, loginExpiresAt: NOW + 20 * DAY });
    await g.ka.tick({ force: true });
    expect(recordOf(g)).toMatchObject({ outcome: "checked", endsAt: NOW + 20 * DAY });
  });
  it("a timed-out run is transient (no Needs you on the first)", async () => {
    const f = fixture("claude-code");
    claudeCreds(f.home, { expiresAt: NOW - 3600e3 });
    f.runners.claudeStatus.mockResolvedValue({ code: null, loggedIn: null });
    await f.ka.tick({ force: true });
    expect(recordOf(f)).toMatchObject({ outcome: "transient", failCount: 1 });
    expect(f.ka.attention()).toEqual([]);
  });
  it("the default sign-in runs with CLAUDE_CONFIG_DIR left alone (configDir null)", async () => {
    const f = fixture("claude-code", { profile: null });
    claudeCreds(f.home, { expiresAt: NOW - 1 });
    await f.ka.tick({ force: true });
    expect(f.runners.claudeStatus.mock.calls[0]![0]).toBeNull();
  });
});

describe("Codex runs", () => {
  it("due: the app-server run sees this sign-in's auth.json through a link in the scratch home; last_refresh moved → refreshed, plan recorded; the link removed after", async () => {
    const f = fixture("codex");
    codexAuth(f.home, { lastRefresh: NOW - 7 * DAY, plan: "prolite" });
    let seen = "";
    f.runners.codexRefresh.mockImplementation(async (runHome: string) => {
      const link = join(runHome, "auth.json");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      seen = readlinkSync(link);
      expect(readFileSync(join(runHome, "config.toml"), "utf8")).toContain('cli_auth_credentials_store = "file"');
      codexAuth(f.home, { lastRefresh: NOW, plan: "free", accessExp: NOW + 10 * DAY });
      return { answered: false, accountNull: false };
    });
    await f.ka.tick({ force: true });
    expect(seen).toBe(join(f.home, "auth.json"));
    expect(existsSync(join(f.data, "signin-keepalive", "codex-home", "auth.json"))).toBe(false);
    expect(recordOf(f)).toMatchObject({ outcome: "refreshed", lastRefresh: NOW, planType: "free" });
  });
  it("account null with last_refresh unchanged → needs_sign_in; neither → transient; not due → nothing runs", async () => {
    const f = fixture("codex");
    codexAuth(f.home, { lastRefresh: NOW - 7 * DAY });
    f.runners.codexRefresh.mockResolvedValue({ answered: true, accountNull: true });
    await f.ka.tick({ force: true });
    expect(recordOf(f)?.outcome).toBe("needs_sign_in");
    const g = fixture("codex");
    codexAuth(g.home, { lastRefresh: NOW - 7 * DAY });
    g.runners.codexRefresh.mockResolvedValue({ answered: false, accountNull: false });
    await g.ka.tick({ force: true });
    expect(recordOf(g)?.outcome).toBe("transient");
    const h = fixture("codex");
    codexAuth(h.home, { lastRefresh: NOW - DAY });
    await h.ka.tick({ force: true });
    expect(recordOf(h)?.outcome).toBe("not_needed");
    expect(h.runners.codexRefresh).not.toHaveBeenCalled();
  });
  it("an auth.json that is itself a link is never refreshed through (unsupported); an API key has nothing to renew", async () => {
    const f = fixture("codex"), elsewhere = scratch();
    codexAuth(elsewhere, { lastRefresh: NOW - 9 * DAY });
    symlinkSync(join(elsewhere, "auth.json"), join(f.home, "auth.json"));
    await f.ka.tick({ force: true });
    expect(recordOf(f)?.outcome).toBe("unsupported");
    expect(f.runners.codexRefresh).not.toHaveBeenCalled();
    const g = fixture("codex");
    writeFileSync(join(g.home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "e".repeat(20) }));
    await g.ka.tick({ force: true });
    expect(recordOf(g)?.outcome).toBe("unsupported");
  });
});

describe("the service", () => {
  it("in use: nothing runs (in_use); the window held by a sign-in: nothing runs and nothing is recorded", async () => {
    const f = fixture("codex");
    codexAuth(f.home, { lastRefresh: NOW - 9 * DAY });
    f.inUse.v = true;
    await f.ka.tick({ force: true });
    expect(recordOf(f)?.outcome).toBe("in_use");
    expect(f.runners.codexRefresh).not.toHaveBeenCalled();
    const g = fixture("codex");
    codexAuth(g.home, { lastRefresh: NOW - 9 * DAY });
    g.claim.v = false;
    await g.ka.tick({ force: true });
    expect(recordOf(g)).toBeUndefined();
    expect(g.runners.codexRefresh).not.toHaveBeenCalled();
  });
  it("about once a day: a sign-in looked at within 23 hours is skipped by the hourly wake", async () => {
    const f = fixture("claude-code");
    claudeCreds(f.home, { expiresAt: NOW - 1 });
    await f.ka.tick({ force: true });
    expect(f.runners.claudeStatus).toHaveBeenCalledTimes(1);
    await f.ka.tick();
    expect(f.runners.claudeStatus).toHaveBeenCalledTimes(1);
  });
  it("a removed profile is forgotten (never asked to sign in); switched off mid-run, nothing is kept", async () => {
    const f = fixture("claude-code");
    rmSync(f.home, { recursive: true });
    await f.ka.tick({ force: true });
    expect(f.ka.list()).toEqual([]);
    const g = fixture("claude-code");
    claudeCreds(g.home, { expiresAt: NOW - 1 });
    g.runners.claudeStatus.mockImplementation(async () => { g.ka.set("claude-code", "work", false); return { code: 0, loggedIn: true }; });
    await g.ka.tick({ force: true });
    expect(g.ka.list()[0]).toEqual({ backend: "claude-code", profile: "work", enabled: false });
  });
  it("set(): only Claude Code and Codex, a valid profile name or null, a boolean; the fallback is Claude Code's only", () => {
    const f = fixture("claude-code");
    expect(f.ka.set("kiro-cli", "work", true)).toEqual({ ok: false, error: "backend" });
    expect(f.ka.set("codex", "../x", true)).toEqual({ ok: false, error: "profile" });
    expect(f.ka.set("codex", "work", "yes")).toEqual({ ok: false, error: "profile" });
    expect(f.ka.set("codex", "work", true, true)).toEqual({ ok: false, error: "fallback" });
    expect(f.ka.set("codex", null, true)).toEqual({ ok: true });
    expect(readEntries(f.data).map(e => [e.backend, e.profile, e.enabled])).toEqual([["claude-code", "work", true], ["codex", null, true]]);
  });
  it("readEntries drops what it cannot trust", () => {
    const d = scratch();
    writeFileSync(join(d, SETTINGS_FILE), JSON.stringify({ entries: [
      { backend: "claude-code", profile: "ok", enabled: true, fallback: true, record: { outcome: "bogus", lastAt: "x", endsAt: 5 } },
      { backend: "codex", profile: "ok", enabled: true, fallback: true },
      { backend: "grok", profile: null, enabled: true }, { backend: "codex", profile: "../x", enabled: true }, { backend: "codex", profile: null },
      { backend: "claude-code", profile: "ok", enabled: false },
    ] }));
    expect(readEntries(d)).toEqual([
      { backend: "claude-code", profile: "ok", enabled: true, fallback: true, record: { endsAt: 5 } },
      { backend: "codex", profile: "ok", enabled: true },
    ]);
  });
  it("view(): the setting, the last run and the dates read now from the sign-in's own file", async () => {
    const f = fixture("claude-code");
    claudeCreds(f.home, { expiresAt: NOW + 3600e3, refreshTokenExpiresAt: NOW + 11 * DAY });
    expect(f.ka.view("claude-code", "work")).toEqual({ enabled: true, fallback: false, endsAt: new Date(NOW + 11 * DAY).toISOString(), expiresAt: new Date(NOW + 3600e3).toISOString() });
    expect(f.ka.view("kiro-cli", "work")).toBeUndefined();
    expect(f.ka.view("claude-code", "other")).toMatchObject({ enabled: false });
  });
});

// ── #3313 review: consent is asked before every CLI; a run's hold ends only once its CLI has exited ─────────────────

const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

describe("#3313 review P1: a withdrawn setting or a stop starts nothing more and records nothing", () => {
  async function heldStatus(change: (f: Fx) => unknown) {
    const f = fixture("claude-code", { fallback: true });
    claudeCreds(f.home, { expiresAt: NOW - 3600e3 });
    const gate = deferred<void>();
    let signal: AbortSignal | undefined;
    f.runners.claudeStatus.mockImplementation(async (_d: unknown, _c: unknown, s: AbortSignal) => { signal = s; await gate.promise; return { code: 0, loggedIn: true }; });  // not renewed
    const run = f.ka.tick({ force: true });
    await vi.waitFor(() => expect(f.runners.claudeStatus).toHaveBeenCalledTimes(1));
    const changed = change(f);
    gate.resolve();
    await run; await changed;
    return { f, signal: signal! };
  }
  it("switched off while the status check runs: its CLI is told to stop, no fallback (no model request), nothing recorded", async () => {
    const { f, signal } = await heldStatus(f => f.ka.set("claude-code", "work", false));
    expect(signal.aborted).toBe(true);
    expect(f.runners.claudeFallback).not.toHaveBeenCalled();
    expect(f.ka.list()[0]).toEqual({ backend: "claude-code", profile: "work", enabled: false, fallback: true });
    expect(f.released).toEqual([1]);
  });
  it("the fallback withdrawn while the status check runs: no fallback", async () => {
    const { f } = await heldStatus(f => f.ka.set("claude-code", "work", true, false));
    expect(f.runners.claudeFallback).not.toHaveBeenCalled();
  });
  it("the service stopped while the status check runs: no fallback; stop() resolves once the run has ended", async () => {
    let stopped: Promise<void> | undefined;
    const { f, signal } = await heldStatus(f => { stopped = f.ka.stop(); });
    await stopped;
    expect(signal.aborted).toBe(true);
    expect(f.runners.claudeFallback).not.toHaveBeenCalled();
    expect(recordOf(f)).toBeUndefined();
  });
  it("control: nothing changed → the fallback runs (it is allowed)", async () => {
    const { f } = await heldStatus(() => undefined);
    expect(f.runners.claudeFallback).toHaveBeenCalledTimes(1);
  });
  it("a sign-in switched off while an earlier one runs is never started", async () => {
    const data = scratch(), homes = { a: join(data, "a"), b: join(data, "b") };
    for (const h of Object.values(homes)) { mkdirSync(h); claudeCreds(h, { expiresAt: NOW - 1 }); }
    const gate = deferred<void>(), calls: Array<string | null> = [];
    const runners = {
      claudeStatus: vi.fn(async (dir: string | null) => { calls.push(dir); if (dir === homes.a) await gate.promise; return { code: 0, loggedIn: true }; }),
      claudeFallback: vi.fn(async () => ({ code: 0 })), codexRefresh: vi.fn(async () => ({ answered: true, accountNull: false })),
    };
    const ka = new SignInKeepAlive({ dataDir: data, now: () => NOW, log: () => {}, homeOf: (_b, p) => (p === "a" ? homes.a : homes.b), acquire: () => ({ release() {} }), changed: () => {}, runners: runners as never });
    ka.set("claude-code", "a", true); ka.set("claude-code", "b", true);
    const run = ka.tick({ force: true });
    await vi.waitFor(() => expect(calls).toEqual([homes.a]));
    ka.set("claude-code", "b", false);
    gate.resolve(); await run;
    expect(calls).toEqual([homes.a]);
  });
});

describe("#3313 review P2: the real runners resolve only once their CLI has exited", () => {
  // A fake CLI on PATH (scratch): it answers, then lingers after stdin closes / SIGINT, and writes a marker as it exits.
  function fakeBin(body: string) {
    const path = join(scratch(), "fake-keepalive-cli");
    writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
    return path;
  }
  it("codex app-server: the answer comes first, the run resolves only after the process exits", async () => {
    const out = scratch(), marker = join(out, "exited");
    const bin = fakeBin(`
const fs = require("fs"); let buf = "";
process.stdin.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
  if (m.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n");
  if (m.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { account: null, requiresOpenaiAuth: true } }) + "\\n"); } });
process.stdin.on("end", () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker)}, "x"); process.exit(0); }, 700));`);
    const { makeRunners } = await import("../src/signin-keepalive.js");
    const r = await makeRunners({ claude: bin, codex: bin }).codexRefresh(scratch(), new AbortController().signal);
    expect(r).toEqual({ answered: true, accountNull: true });
    expect(existsSync(marker)).toBe(true);
  });
  it("claude: stopped by the signal (SIGINT), it resolves only after the process has exited", async () => {
    const out = scratch(), marker = join(out, "exited");
    const bin = fakeBin(`
const fs = require("fs");
process.on("SIGINT", () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker)}, "x"); process.exit(0); }, 600));
setInterval(() => {}, 1000);`);
    const { makeRunners } = await import("../src/signin-keepalive.js");
    const c = new AbortController();
    const p = makeRunners({ claude: bin, codex: bin }).claudeStatus(null, scratch(), c.signal);
    await new Promise(r => setTimeout(r, 300));
    c.abort();
    const r = await p;
    expect(r.code).toBeNull();
    expect(existsSync(marker)).toBe(true);
  });
  it("#3313 review r2: stopped before its late initialize answer, codex is never asked to refresh (nothing more is sent); the run still waits for its exit", async () => {
    const out = scratch(), got = join(out, "received"), marker = join(out, "exited");
    const bin = fakeBin(`
const fs = require("fs"); let buf = "";
process.stdin.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); fs.appendFileSync(${JSON.stringify(got)}, line + "\\n"); } });
// It answers initialize late — after the run was stopped — and keeps running for a while before it exits.
process.on("SIGINT", () => { setTimeout(() => process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n"), 100); setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker)}, "x"); process.exit(0); }, 600); });
setInterval(() => {}, 1000);`);
    const { makeRunners } = await import("../src/signin-keepalive.js");
    const c = new AbortController();
    const p = makeRunners({ claude: bin, codex: bin }).codexRefresh(scratch(), c.signal);
    await new Promise(r => setTimeout(r, 300));
    c.abort();
    expect(await p).toEqual({ answered: false, accountNull: false });
    expect(existsSync(marker)).toBe(true);
    const lines = readFileSync(got, "utf8").trim().split("\n").map(l => JSON.parse(l).method ?? `id${JSON.parse(l).id}`);
    expect(lines).toEqual(["initialize"]);                                  // no "initialized", no account/read
  });
  it("control: answered in time, the refresh is asked (initialize, initialized, account/read)", async () => {
    const out = scratch(), got = join(out, "received");
    const bin = fakeBin(`
const fs = require("fs"); let buf = "";
process.stdin.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); fs.appendFileSync(${JSON.stringify(got)}, line + "\\n"); const m = JSON.parse(line);
  if (m.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n");
  if (m.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { account: { type: "chatgpt" } } }) + "\\n"); } });
process.stdin.on("end", () => process.exit(0));`);
    const { makeRunners } = await import("../src/signin-keepalive.js");
    expect(await makeRunners({ claude: bin, codex: bin }).codexRefresh(scratch(), new AbortController().signal)).toEqual({ answered: true, accountNull: false });
    expect(readFileSync(got, "utf8").trim().split("\n").map(l => JSON.parse(l).method)).toEqual(["initialize", "initialized", "account/read"]);
  });
  it("a CLI that ignores SIGINT is killed (SIGKILL after 5 s), and only then does the run resolve", async () => {
    const bin = fakeBin(`process.on("SIGINT", () => {}); process.stdout.write("started\\n"); setInterval(() => {}, 1000);`);
    const { makeRunners } = await import("../src/signin-keepalive.js");
    const c = new AbortController(), t0 = Date.now();
    const p = makeRunners({ claude: bin, codex: bin }).claudeStatus(null, scratch(), c.signal);
    await new Promise(r => setTimeout(r, 300));
    c.abort();
    expect((await p).code).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(5_000);
  }, 15_000);
});
