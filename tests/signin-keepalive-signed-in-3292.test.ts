/**
 * #3292: Keep sign-in alive after the person signs in again (src/signin-keepalive.ts).
 * A check that found the account signed out is recorded (`needs_sign_in` / `not_renewed`). When the person then signs in, the Accounts row said "signed in"
 * while its foot still said, in red, "last check: needs signing in again" — until the next daily check. Now:
 * - view() and attention() ignore such a record once the sign-in's own file holds a fresh valid token newer than the one the record saw (Claude Code: the
 *   access token's expiry; Codex: a newer access token or a newer refresh) — and ONLY then (an expired, dead or missing login keeps saying it);
 * - nothing is rewritten: the record stays until a check replaces it;
 * - a record's old end date is not said as "ended" after a new sign-in (the file's own end date is used);
 * - tick({ only }) looks at that one sign-in at once, even though it was looked at minutes ago, and replaces the record (FleetManager does this when a sign-in ends).
 * Fixtures only (example.com).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { END_WARNING_MS, SignInKeepAlive, writeEntries, type KeepAliveDeps, type KeepAliveRecord, type KeepAliveRunners } from "../src/signin-keepalive.js";

const DAY = 86_400_000, HOUR = 3_600_000, NOW = Date.UTC(2026, 10, 7, 13, 40, 0);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "none" })}.${b64(claims)}.${"s".repeat(16)}`;
function claudeCreds(home: string, o: Record<string, unknown>) {
  writeFileSync(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "c".repeat(40), refreshToken: "d".repeat(40), scopes: ["user:inference"], subscriptionType: "team", ...o } }));
}
function codexAuth(home: string, o: { lastRefresh?: number; accessExp: number; refresh?: string | null }) {
  const tokens: Record<string, unknown> = { access_token: jwt({ exp: Math.floor(o.accessExp / 1000) }), id_token: jwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } }) };
  if (o.refresh !== null) tokens.refresh_token = o.refresh ?? "d".repeat(40);
  writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens, ...(o.lastRefresh !== undefined ? { last_refresh: new Date(o.lastRefresh).toISOString() } : {}) }));
}

/** One switched-on sign-in with `record` already saved, over a scratch home; the CLI runs are replaced and fail the test if anything starts one. */
function setup(backend: "claude-code" | "codex", record: KeepAliveRecord | undefined) {
  const data = mkdtempSync(join(tmpdir(), "agend-ka-in-")); dirs.push(data);
  const home = join(data, "credential-profiles", backend, "work");
  mkdirSync(home, { recursive: true });
  writeEntries(data, [{ backend, profile: "work", enabled: true, ...(backend === "claude-code" ? { fallback: false } : {}), ...(record ? { record } : {}) }]);
  const runners = { claudeStatus: vi.fn(async () => ({ code: 0, loggedIn: true })), claudeFallback: vi.fn(async () => ({ code: 0 })), codexRefresh: vi.fn(async () => ({ answered: true, accountNull: false })) };
  const deps: KeepAliveDeps = { dataDir: data, now: () => NOW, log: () => {}, homeOf: () => home, acquire: () => ({ release: () => {} }), changed: () => {}, runners: runners as unknown as KeepAliveRunners };
  return { ka: new SignInKeepAlive(deps), home, runners };
}
const OLD: KeepAliveRecord = { outcome: "needs_sign_in", lastAt: NOW - 70 * 60_000, attentionSince: NOW - 70 * 60_000 };
const row = (ka: SignInKeepAlive) => ka.view("claude-code", "work")!;

describe("Claude Code: a failure from before the sign-in stops being said once the file holds a newer valid login", () => {
  it("signed in again: the row has no last check and Needs you has no ask — and the saved record is left alone", () => {
    const f = setup("claude-code", OLD);
    claudeCreds(f.home, { expiresAt: NOW + 8 * HOUR, refreshTokenExpiresAt: NOW + 30 * DAY });
    const v = row(f.ka);
    expect(v).not.toHaveProperty("lastAt"); expect(v).not.toHaveProperty("lastOutcome");
    expect(v.enabled).toBe(true);                                                              // the setting itself is still shown
    expect(f.ka.attention()).toEqual([]);
    expect(f.ka.list()[0]!.record).toMatchObject({ outcome: "needs_sign_in" });                  // nothing rewritten: a check replaces it
  });
  it("`not_renewed` is treated the same way", () => {
    const f = setup("claude-code", { ...OLD, outcome: "not_renewed" });
    claudeCreds(f.home, { expiresAt: NOW + 8 * HOUR });
    expect(row(f.ka)).not.toHaveProperty("lastOutcome");
    expect(f.ka.attention()).toEqual([]);
  });
  it.each([
    ["the login is expired (still has its refresh token)", (h: string) => claudeCreds(h, { expiresAt: NOW - HOUR })],
    ["the refresh token is gone: a dead login", (h: string) => claudeCreds(h, { expiresAt: NOW + 8 * HOUR, refreshToken: "" })],
    ["the CLI blanked the expiry after the server refused it", (h: string) => claudeCreds(h, { expiresAt: 0 })],
    ["there is no file", () => {}],
  ])("not signed in since — %s: the failure is still said", (_why, write) => {
    const f = setup("claude-code", OLD);
    write(f.home);
    expect(row(f.ka)).toMatchObject({ lastOutcome: "needs_sign_in" });
    expect(f.ka.attention().map((a) => a.kind)).toEqual(["needs_sign_in"]);
  });
  it("a valid login that is not NEWER than the one the record saw is not taken as a new sign-in", () => {
    const f = setup("claude-code", { ...OLD, expiresAt: NOW + 8 * HOUR });
    claudeCreds(f.home, { expiresAt: NOW + 8 * HOUR });                                       // the same expiry
    expect(row(f.ka)).toMatchObject({ lastOutcome: "needs_sign_in" });
    claudeCreds(f.home, { expiresAt: NOW + 9 * HOUR });                                       // later: signed in since
    expect(row(f.ka)).not.toHaveProperty("lastOutcome");
  });
  it("only a failure is ignored: any other result is shown as it was", () => {
    for (const outcome of ["refreshed", "not_needed", "checked", "in_use", "transient"] as const) {
      const f = setup("claude-code", { outcome, lastAt: NOW - HOUR });
      claudeCreds(f.home, { expiresAt: NOW + 8 * HOUR });
      expect(row(f.ka), outcome).toMatchObject({ lastOutcome: outcome });
    }
  });
  it("the old sign-in's end date is not said as “ended” after a new sign-in: the file's own end date is used", () => {
    const f = setup("claude-code", { ...OLD, endsAt: NOW - DAY });                           // the old login's end, already past
    claudeCreds(f.home, { expiresAt: NOW + 8 * HOUR, refreshTokenExpiresAt: NOW + 30 * DAY });
    expect(f.ka.attention()).toEqual([]);
    claudeCreds(f.home, { expiresAt: NOW + 8 * HOUR, refreshTokenExpiresAt: NOW + END_WARNING_MS - HOUR });   // the NEW login ends soon: that is said, from its own date
    expect(f.ka.attention().map((a) => [a.kind, a.endsAt])).toEqual([["ending", NOW + END_WARNING_MS - HOUR]]);
    const g = setup("claude-code", { ...OLD, endsAt: NOW - DAY });                            // still not signed in: the ask is said, and not “ended” as well
    expect(g.ka.attention().map((a) => a.kind)).toEqual(["needs_sign_in"]);
  });
});

describe("Codex: the same, with its own file", () => {
  const CODEX_OLD: KeepAliveRecord = { ...OLD, expiresAt: NOW - HOUR };
  const codexRow = (ka: SignInKeepAlive) => ka.view("codex", "work")!;
  it("a newer access token, or a newer refresh, is a sign-in since", () => {
    const a = setup("codex", CODEX_OLD);
    codexAuth(a.home, { accessExp: NOW + 5 * DAY });
    expect(codexRow(a.ka)).not.toHaveProperty("lastOutcome");
    expect(a.ka.attention()).toEqual([]);
    const b = setup("codex", { ...CODEX_OLD, lastRefresh: NOW - 3 * DAY });
    codexAuth(b.home, { accessExp: NOW - HOUR, lastRefresh: NOW - 10 * 60_000 });             // access token past, but refreshed since the record
    expect(codexRow(b.ka)).not.toHaveProperty("lastOutcome");
  });
  it("without a refresh token, with an old token, or with nothing newer: the failure is still said", () => {
    const a = setup("codex", CODEX_OLD);
    codexAuth(a.home, { accessExp: NOW + 5 * DAY, refresh: null });
    expect(codexRow(a.ka)).toMatchObject({ lastOutcome: "needs_sign_in" });
    const b = setup("codex", CODEX_OLD);
    codexAuth(b.home, { accessExp: NOW - 2 * HOUR });
    expect(codexRow(b.ka)).toMatchObject({ lastOutcome: "needs_sign_in" });
    const c = setup("codex", CODEX_OLD);                                                      // no file at all
    expect(codexRow(c.ka)).toMatchObject({ lastOutcome: "needs_sign_in" });
    expect(c.ka.attention().map((x) => x.kind)).toEqual(["needs_sign_in"]);
  });
});

describe("tick({ only }): what FleetManager asks for when a sign-in ends", () => {
  it("looks at that one sign-in now, even though it was looked at minutes ago, and replaces the failure with what the file says", async () => {
    const f = setup("claude-code", OLD);
    claudeCreds(f.home, { expiresAt: NOW + 7 * DAY, refreshTokenExpiresAt: NOW + 30 * DAY });
    await f.ka.tick();                                                                        // the hourly wake: skipped (looked at within a day)
    expect(f.ka.list()[0]!.record).toMatchObject({ outcome: "needs_sign_in" });
    await f.ka.tick({ only: { backend: "claude-code", profile: "work" } });
    expect(f.ka.list()[0]!.record).toMatchObject({ outcome: "not_needed", lastAt: NOW, expiresAt: NOW + 7 * DAY, endsAt: NOW + 30 * DAY });
    expect(f.ka.list()[0]!.record).not.toHaveProperty("attentionSince");
    expect(f.runners.claudeStatus).not.toHaveBeenCalled();                                    // not due: the file was enough, no CLI started
    expect(row(f.ka)).toMatchObject({ lastOutcome: "not_needed" });
    expect(f.ka.attention()).toEqual([]);
  });
  it("another sign-in is not looked at; one that is switched off is not either", async () => {
    const f = setup("claude-code", OLD);
    claudeCreds(f.home, { expiresAt: NOW + 7 * DAY });
    await f.ka.tick({ only: { backend: "claude-code", profile: null } });
    expect(f.ka.list()[0]!.record).toMatchObject({ outcome: "needs_sign_in" });
    f.ka.set("claude-code", "work", false);
    await f.ka.tick({ only: { backend: "claude-code", profile: "work" } });
    expect(f.runners.claudeStatus).not.toHaveBeenCalled();
    expect(f.ka.list()[0]).toMatchObject({ enabled: false });
  });
});
