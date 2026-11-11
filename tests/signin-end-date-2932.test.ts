/**
 * M-2932 (the owner, alpha.14: Needs you said the default Claude sign-in 「已到期（2026-11-04 04:58）」 while it kept working,
 * and `/login` answered it was still connected): a Claude login's stored `refreshTokenExpiresAt` is not a final deadline.
 * Claude Code merges a refresh as `min(old, new)` (2.1.322 `PC()`), so the stored date stays the FIRST sign-in's end while the
 * server keeps accepting the rotated refresh token; Claude Code itself ignores the date once a refresh landed past it
 * (`iXn()`: expiresAt > end + 3 days → no end). A date alone proves nothing, so nothing is said from it:
 * - no "ending" / "ended" Needs-you line from a stored date — kept alive or not, in use or not;
 * - 「需要重新連接」 (reconnect, signed out) only when the login is shown to be over: the CLI blanked it after a refused
 *   refresh (invalid_grant: expiresAt 0, empty tokens), or keep-alive's own refresh was refused (needs_sign_in);
 * - the Accounts row shows no end date.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignInKeepAlive, attentionOf, writeEntries, type KeepAliveDeps, type KeepAliveRunners } from "../src/signin-keepalive.js";
import { claudeStoreEnded, claudeStoreHasLogin } from "../src/backend/credential-profile.js";

const DAY = 86_400_000, HOUR = 3_600_000, NOW = Date.UTC(2026, 10, 11, 6, 0, 0);
const dirs: string[] = [];
const scratch = (p = "agend-2932-") => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const SECRET_AT = "c".repeat(40), SECRET_RT = "d".repeat(40);
/** A working login: tokens there, the access token refreshed recently (expiresAt ahead), with whatever stored end date. */
function creds(home: string, o: { end?: number; expiresAt?: number; blank?: boolean }) {
  mkdirSync(home, { recursive: true });
  const login = o.blank ? { accessToken: "", refreshToken: "", expiresAt: 0 }
    : { accessToken: SECRET_AT, refreshToken: SECRET_RT, expiresAt: o.expiresAt ?? NOW + 8 * HOUR };
  writeFileSync(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { ...login,
    ...(o.end !== undefined ? { refreshTokenExpiresAt: o.end } : {}), scopes: ["user:inference"], subscriptionType: "team" } }));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "u-1" } }));
}
const noRun = new Proxy({}, { get: () => () => { throw new Error("no CLI run here"); } }) as unknown as KeepAliveRunners;

describe("the stored end date is not proof a login is over (the owner's alpha.14 case)", () => {
  it("claudeStoreEnded: a date in the past with a working login → not over; only the CLI's blank after invalid_grant is", () => {
    const d = (o: Parameters<typeof creds>[1]) => { const h = scratch(); creds(h, o); return h; };
    expect(claudeStoreEnded(d({ end: NOW - 7 * DAY }), NOW)).toBe(false);                               // refreshed past it: the owner's
    expect(claudeStoreEnded(d({ end: NOW - 7 * DAY, expiresAt: NOW - HOUR }), NOW)).toBe(false);        // not refreshed lately: still unknown
    expect(claudeStoreEnded(d({ end: NOW }), NOW)).toBe(false);
    expect(claudeStoreEnded(d({ blank: true, end: NOW + 5 * DAY }), NOW)).toBe(true);                   // what claude leaves after invalid_grant
    const tokensGone = scratch(); creds(tokensGone, {}); writeFileSync(join(tokensGone, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: NOW + HOUR, refreshTokenExpiresAt: NOW + 5 * DAY } }));
    expect(claudeStoreEnded(tokensGone, NOW)).toBe(true);                                               // both tokens empty, a date still set
    const zero = scratch(); creds(zero, { end: NOW + 5 * DAY }); writeFileSync(join(zero, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: SECRET_AT, refreshToken: SECRET_RT, expiresAt: 0 } }));
    expect(claudeStoreEnded(zero, NOW)).toBe(true);
  });
  it("claudeStoreHasLogin: a past stored date with tokens is still signed in; a blanked login is not", () => {
    const past = scratch(); creds(past, { end: Date.now() - 7 * DAY, expiresAt: Date.now() + 8 * HOUR });
    const blank = scratch(); creds(blank, { blank: true });
    expect([claudeStoreHasLogin(past), claudeStoreHasLogin(blank)]).toEqual([true, false]);
  });
  it("attentionOf (kept sign-ins): no line from a stored date, near or past; a refused refresh still asks", () => {
    const e = (endsAt: number, outcome: "refreshed" | "needs_sign_in" = "refreshed") =>
      ({ backend: "claude-code" as const, profile: "work", enabled: true, record: { outcome, lastAt: NOW - HOUR, endsAt, attentionSince: NOW - HOUR } });
    expect(attentionOf([e(NOW + 3 * DAY), e(NOW - DAY)], NOW)).toEqual([]);
    expect(attentionOf([e(NOW - DAY, "needs_sign_in")], NOW).map(a => a.kind)).toEqual(["needs_sign_in"]);
  });
  it("SignInKeepAlive: no end-date line for sign-ins in use (near, past), and no end date on the Accounts row", () => {
    const data = scratch(), homes: Record<string, string> = { soon: join(data, "soon"), gone: join(data, "gone"), kept: join(data, "kept") };
    creds(homes.soon!, { end: NOW + 12 * HOUR });
    creds(homes.gone!, { end: NOW - 7 * DAY });
    creds(homes.kept!, { end: NOW + 2 * DAY });
    writeEntries(data, [{ backend: "claude-code", profile: "kept", enabled: true, record: { outcome: "refreshed", lastAt: NOW - HOUR, endsAt: NOW + 2 * DAY } }]);
    const deps: KeepAliveDeps = { dataDir: data, now: () => NOW, log: () => {}, homeOf: (_b, p) => homes[p ?? ""] ?? null, acquire: () => ({ release() {} }), changed: () => {}, runners: noRun };
    const ka = new SignInKeepAlive(deps);
    const inUse = [{ backend: "claude-code", profile: "soon" }, { backend: "claude-code", profile: "gone" }, { backend: "claude-code", profile: "kept" }];
    expect((ka.attention as (...a: unknown[]) => unknown[])(inUse)).toEqual([]);
    expect("endsAt" in (ka.view("claude-code", "kept") ?? {})).toBe(false);
    expect("endsAt" in (ka.view("claude-code", "gone") ?? {})).toBe(false);
  });
});

// ── Through FleetManager: Needs you, the sign-in rows and the Accounts view ──
const home = mkdtempSync(join(tmpdir(), "agend-2932-home-"));
const claudeDefault = mkdtempSync(join(tmpdir(), "agend-2932-claude-"));
process.env.AGEND_HOME = home;
const savedClaudeDir = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = claudeDefault;                 // the default sign-in's home: a scratch one, never the real ~/.claude
const { FleetManager } = await import("../src/fleet-manager.js");

describe("FleetManager: a past stored date says nothing; a blanked login says reconnect", () => {
  let dir: string, fm: any;
  const T = Date.now();
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "agend-2932-fm-"));
    mkdirSync(join(dir, "w"));
    writeFileSync(join(dir, "fleet.yaml"), [
      "health_port: 0", "instances:",
      `  cc:\n    working_directory: ${join(dir, "w")}\n    backend: claude-code\n    backend_options:\n      claude-code:\n        credential_profile: soon`,
      `  cc2:\n    working_directory: ${join(dir, "w")}\n    backend: claude-code`,
      `  cc3:\n    working_directory: ${join(dir, "w")}\n    backend: claude-code\n    backend_options:\n      claude-code:\n        credential_profile: gone`,
    ].join("\n") + "\n");
    fm = new FleetManager(dir);
    const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
    fm.loadConfig(join(dir, "fleet.yaml"));
    creds(join(dir, "credential-profiles", "claude-code", "soon"), { end: T + 8 * HOUR, expiresAt: T + 8 * HOUR });   // stored end in 8 h
    creds(join(dir, "credential-profiles", "claude-code", "gone"), { blank: true });                                // refused refresh: over
    creds(claudeDefault, { end: T - 7 * DAY, expiresAt: T + 8 * HOUR });                                            // the owner's: past date, working
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); rmSync(claudeDefault, { recursive: true, force: true });
    if (savedClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedClaudeDir;
  });
  it("Needs you: no line for the default (past date) or `soon` (date in 8 h) — nothing from a stored date", () => {
    fm.keepAliveService();
    expect(fm.keepAliveAttention()).toEqual([]);
  });
  it("sign-in rows and the Accounts view: the default (past date, working) is connected; only the blanked profile says reconnect", async () => {
    const rows = fm.backendAvailabilityRows;
    fm.backendAvailabilityRows = () => [{ backend: "claude-code", state: "usable", auth: "valid", path: "/x/claude" }];
    try {
      const targets = fm.backendSignInTargets();
      expect(targets.filter((t: any) => !t.profile).map((t: any) => [t.state, t.reconnect ?? null])).toEqual([["usable", null]]);
      fm.refreshSignInIdentities = () => {};
      const view = await fm.accountsView(0);
      const claude = view.clis.find((c: any) => c.backend === "claude-code");
      const host = claude.rows.filter((r: any) => r.scope.kind === "host").map((r: any) => [r.profile, r.state, r.reconnect ?? null, r.keepAlive?.endsAt ?? null]);
      expect(host).toEqual(expect.arrayContaining([[null, "usable", null, null], ["soon", "usable", null, null], ["gone", "not_signed_in", true, null]]));
    } finally { fm.backendAvailabilityRows = rows; }
  });
});
