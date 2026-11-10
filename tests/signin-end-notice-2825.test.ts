/**
 * M-2825 (the user, 11-10: a profile's Claude sign-in reached its fixed end — `refreshTokenExpiresAt` — with no warning; its
 * keep-alive was off, and only kept sign-ins were warned about): every Claude sign-in IN USE — the default and each profile —
 * is warned about a day before its end date and again once it has ended, kept alive or not.
 * - endNoticeOf: pure; a day before → "ending" (since = end − 1 day), at/after the end → "ended" (since = the end: a line of
 *   its own, so it is said again);
 * - SignInKeepAlive.attention(inUse): the end date read from each sign-in's own file (readClaudeMeta: a date, never a
 *   token; no CLI run); a kept sign-in keeps its own lines (ten days before) and is never listed twice; a sign-in not in use,
 *   or another CLI's, says nothing;
 * - FleetManager: the agents' and ClassicBot rooms' sign-ins are what is in use; their lines reach Needs you (and from there
 *   General's chat) as reason backend_signin, in the fleet's language, with Sign in for that profile.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { END_NOTICE_MS, END_WARNING_MS, SignInKeepAlive, endNoticeOf, writeEntries, type KeepAliveDeps, type KeepAliveRunners } from "../src/signin-keepalive.js";
import { deriveNeedsYou } from "../src/needs-you.js";
import { claudeStoreEnded, claudeStoreHasLogin } from "../src/backend/credential-profile.js";
import { buildAccountsView } from "../src/accounts-view.js";

const DAY = 86_400_000, NOW = Date.UTC(2026, 10, 10, 6, 0, 0);
const dirs: string[] = [];
const scratch = (p = "agend-end-") => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const SECRET_AT = "c".repeat(40), SECRET_RT = "d".repeat(40);
function claudeCreds(home: string, endsAt: number | undefined) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: SECRET_AT, refreshToken: SECRET_RT, expiresAt: NOW + 3_600_000,
    ...(endsAt !== undefined ? { refreshTokenExpiresAt: endsAt } : {}), scopes: ["user:inference"], subscriptionType: "team" } }));
}
/** No CLI may run: the end date is the file's. */
const noRun = new Proxy({}, { get: () => () => { throw new Error("no CLI run is allowed for an end date"); } }) as unknown as KeepAliveRunners;

describe("endNoticeOf (pure)", () => {
  it("a day before: ending (since = end − a day); at or after the end: ended (since = the end); further off, or no date: nothing", () => {
    const s = (endsAt?: number) => ({ backend: "claude-code" as const, profile: "work", ...(endsAt !== undefined ? { endsAt } : {}) });
    expect(END_NOTICE_MS).toBe(DAY);
    expect(endNoticeOf([s(NOW + DAY + 1), s(), s(0)], NOW)).toEqual([]);
    expect(endNoticeOf([s(NOW + DAY)], NOW)).toEqual([{ backend: "claude-code", profile: "work", kind: "ending", since: NOW, endsAt: NOW + DAY }]);
    expect(endNoticeOf([s(NOW + 6 * 3_600_000)], NOW)).toEqual([{ backend: "claude-code", profile: "work", kind: "ending", since: NOW + 6 * 3_600_000 - DAY, endsAt: NOW + 6 * 3_600_000 }]);
    expect(endNoticeOf([s(NOW)], NOW)).toEqual([{ backend: "claude-code", profile: "work", kind: "ended", since: NOW, endsAt: NOW }]);
    expect(endNoticeOf([s(NOW - DAY)], NOW)).toEqual([{ backend: "claude-code", profile: "work", kind: "ended", since: NOW - DAY, endsAt: NOW - DAY }]);
  });
});

describe("an ended sign-in is not 「已連接」 (the leader on #3577: the hsinlin case)", () => {
  const store = (creds?: Record<string, unknown>, account = true) => {
    const d = scratch();
    if (creds) writeFileSync(join(d, ".credentials.json"), JSON.stringify({ claudeAiOauth: creds }));
    if (account) writeFileSync(join(d, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "u-1" } }));
    return d;
  };
  const live = { accessToken: SECRET_AT, refreshToken: SECRET_RT, expiresAt: NOW + 3_600_000, refreshTokenExpiresAt: NOW + 5 * DAY };
  it("claudeStoreEnded: past its end date (a refresh token still there), or blanked after invalid_grant (expiresAt 0 / no tokens) — from the file; nothing known: false", () => {
    expect(claudeStoreEnded(store(live), NOW)).toBe(false);
    expect(claudeStoreEnded(store({ ...live, refreshTokenExpiresAt: NOW - 1 }), NOW)).toBe(true);
    expect(claudeStoreEnded(store({ ...live, refreshTokenExpiresAt: NOW }), NOW)).toBe(true);
    expect(claudeStoreEnded(store({ ...live, accessToken: "", refreshToken: "", expiresAt: 0 }), NOW)).toBe(true);   // what claude leaves after invalid_grant
    expect(claudeStoreEnded(store({ ...live, expiresAt: 0 }), NOW)).toBe(true);
    expect(claudeStoreEnded(store({ accessToken: "", refreshToken: "" }), NOW)).toBe(true);
    expect(claudeStoreEnded(store({ accessToken: SECRET_AT }), NOW)).toBe(false);                                  // no end date known: not over
    expect(claudeStoreEnded(store(undefined), NOW)).toBe(false);                                                    // macOS: the token is in the Keychain
    expect(claudeStoreEnded(join(scratch(), "missing"), NOW)).toBe(false);
  });
  it("claudeStoreHasLogin: an ended login is signed out even though .claude.json still names the account; the Keychain shape (no file) stays signed in", () => {
    expect(claudeStoreHasLogin(store({ ...live, refreshTokenExpiresAt: Date.now() - 1 }))).toBe(false);
    expect(claudeStoreHasLogin(store({ ...live, accessToken: "", refreshToken: "", expiresAt: 0 }))).toBe(false);
    expect(claudeStoreHasLogin(store({ ...live, refreshTokenExpiresAt: Date.now() + DAY }))).toBe(true);
    expect(claudeStoreHasLogin(store(undefined))).toBe(true);
  });
  it("the Accounts view carries `reconnect` on the default row and a profile's row", () => {
    const v = buildAccountsView({ targets: [{ backend: "claude-code", state: "not_signed_in", signIn: true, reconnect: true }],
      diskProfiles: new Map([["claude-code", [{ profile: "hsinlin", state: "not_signed_in", signIn: true, reconnect: true }, { profile: "ok", state: "usable", signIn: true }]]]),
      agents: [], classic: [], fleetDefaults: new Map() } as never);
    expect(v.clis[0]!.rows.map(r => [r.profile, r.state, r.reconnect ?? null])).toEqual([[null, "not_signed_in", true], ["hsinlin", "not_signed_in", true], ["ok", "usable", null]]);
  });
});

describe("SignInKeepAlive.attention(inUse)", () => {
  function setup() {
    const data = scratch(), homes: Record<string, string> = {};
    for (const p of ["soon", "later", "gone", "kept", "idle", "nodate", "default"]) homes[p] = join(data, "homes", p);
    claudeCreds(homes.soon!, NOW + 12 * 3_600_000);       // ends in 12 h, keep-alive off
    claudeCreds(homes.later!, NOW + 5 * DAY);             // ends in 5 days, keep-alive off: not yet
    claudeCreds(homes.gone!, NOW - 2 * 3_600_000);        // ended 2 h ago
    claudeCreds(homes.kept!, NOW + 5 * DAY);              // kept alive: its own ten-day line
    claudeCreds(homes.idle!, NOW + 3_600_000);            // ends in an hour, but no agent uses it
    claudeCreds(homes.nodate!, undefined);                // a file without an end date
    claudeCreds(homes.default!, NOW + 20 * 3_600_000);    // the default sign-in, in use
    writeEntries(data, [{ backend: "claude-code", profile: "kept", enabled: true, record: { outcome: "refreshed", lastAt: NOW - DAY, endsAt: NOW + 5 * DAY } }]);
    const deps: KeepAliveDeps = { dataDir: data, now: () => NOW, log: () => {}, homeOf: (_b, p) => homes[p ?? "default"] ?? null, acquire: () => ({ release() {} }), changed: () => {}, runners: noRun };
    return { ka: new SignInKeepAlive(deps) };
  }
  it("every Claude sign-in in use, from its own file: ending a day before, ended after; kept ones once (their ten days); unused, dateless and other CLIs: nothing", () => {
    const { ka } = setup();
    const inUse = [{ backend: "claude-code", profile: "soon" }, { backend: "claude-code", profile: "later" }, { backend: "claude-code", profile: "gone" },
      { backend: "claude-code", profile: "kept" }, { backend: "claude-code", profile: "nodate" }, { backend: "claude-code", profile: null },
      { backend: "claude-code", profile: "soon" }, { backend: "codex", profile: "soon" }];
    const lines = ka.attention(inUse).map(a => [a.profile, a.kind, a.since, a.endsAt]);
    expect(lines).toEqual([
      ["kept", "ending", NOW + 5 * DAY - END_WARNING_MS, NOW + 5 * DAY],          // its own (#3292): ten days before
      ["soon", "ending", NOW + 12 * 3_600_000 - DAY, NOW + 12 * 3_600_000],
      ["gone", "ended", NOW - 2 * 3_600_000, NOW - 2 * 3_600_000],
      [null, "ending", NOW + 20 * 3_600_000 - DAY, NOW + 20 * 3_600_000],
    ]);
    // Without anything in use: only the kept sign-in's own line (what #3292 already said).
    expect(ka.attention().map(a => a.profile)).toEqual(["kept"]);
  });
  it("the end date is the file's: a new sign-in (a later date in the file) stops the line at once", () => {
    const { ka } = setup();
    const gone = () => ka.attention([{ backend: "claude-code", profile: "gone" }]).filter(a => a.profile === "gone").map(a => a.kind);
    expect(gone()).toEqual(["ended"]);
    claudeCreds((ka as any).deps.homeOf("claude-code", "gone"), NOW + 30 * DAY);
    expect(gone()).toEqual([]);
  });
});

// ── FleetManager: what is in use, and the lines into Needs you ──
const home = mkdtempSync(join(tmpdir(), "agend-end-home-"));
const claudeDefault = mkdtempSync(join(tmpdir(), "agend-end-claude-"));
process.env.AGEND_HOME = home;
const savedClaudeDir = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = claudeDefault;                 // the default sign-in's home: a scratch one, never the real ~/.claude
const { FleetManager } = await import("../src/fleet-manager.js");

describe("FleetManager: the sign-ins in use, warned about in Needs you", () => {
  let dir: string, fm: any;
  const T = Date.now();                                       // the real service's own clock
  // The host's own time, with the hour (M-2825: a UTC day was a day off near midnight in Taipei).
  const p2 = (n: number) => String(n).padStart(2, "0");
  const day = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "agend-end-fm-"));
    mkdirSync(join(dir, "w"));
    writeFileSync(join(dir, "fleet.yaml"), [
      "health_port: 0", "instances:",
      `  cc:\n    working_directory: ${join(dir, "w")}\n    backend: claude-code\n    backend_options:\n      claude-code:\n        credential_profile: hsinlin`,
      `  cc2:\n    working_directory: ${join(dir, "w")}\n    backend: claude-code`,
      `  gpt:\n    working_directory: ${join(dir, "w")}\n    backend: codex`,
    ].join("\n") + "\n");
    fm = new FleetManager(dir);
    const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
    fm.loadConfig(join(dir, "fleet.yaml"));
    claudeCreds(join(dir, "credential-profiles", "claude-code", "hsinlin"), T + 8 * 3_600_000);   // hsinlin: in use, ends in 8 h
    claudeCreds(join(dir, "credential-profiles", "claude-code", "spare"), T + 3_600_000);         // a profile nobody uses
    claudeCreds(claudeDefault, T - 3_600_000);                                                     // the default: in use (cc2), ended
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); rmSync(claudeDefault, { recursive: true, force: true });
    if (savedClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedClaudeDir;
  });
  it("the agents' sign-ins (each once, other CLIs too) are what is in use; their end dates become Needs-you lines with Sign in", () => {
    expect(fm.signInsInUse()).toEqual([{ backend: "claude-code", profile: "hsinlin" }, { backend: "claude-code", profile: null }, { backend: "codex", profile: null }]);
    fm.keepAliveService();                                    // the real service: its homes are the fleet's (profiles, CLAUDE_CONFIG_DIR)
    const lines = fm.keepAliveAttention();
    expect(lines.map((l: any) => [l.profile, l.kind, l.detail])).toEqual([
      ["hsinlin", "ending", `Claude Code · hsinlin: this sign-in ends by ${day(T + 8 * 3_600_000)} and refreshing cannot extend it. Sign in again before then`],
      [null, "ended", `Claude Code · default sign-in: this sign-in reached its end date (${day(T - 3_600_000)}). Sign in again`],
    ]);
    const items = deriveNeedsYou({ prompts: [], instances: [], deliveries: [], ownerOf: () => "dc", signInKeepAlive: lines });
    expect(items.map((i: any) => [i.reason, i.id.replace(/\d+$/, "N"), !!i.signIn])).toEqual([
      ["backend_signin", "keepalive:ending:claude-code:hsinlin:N", true], ["backend_signin", "keepalive:ended:claude-code::N", true]]);
  });
  it("the leader on #3577: the rows' state reads the file — an ended default whose `claude auth status` said loggedIn, and an ended profile, say reconnect", async () => {
    claudeCreds(join(dir, "credential-profiles", "claude-code", "gone"), T - 3_600_000);
    const rows = fm.backendAvailabilityRows;
    fm.backendAvailabilityRows = () => [{ backend: "claude-code", state: "usable", auth: "valid", path: "/x/claude" }];     // the CLI's answer: logged in
    try {
      const targets = fm.backendSignInTargets();
      expect(targets.filter((t: any) => !t.profile).map((t: any) => [t.backend, t.state, t.reconnect ?? null])).toEqual([["claude-code", "not_signed_in", true]]);
      expect(targets.filter((t: any) => t.profile === "hsinlin").map((t: any) => [t.state, t.reconnect ?? null])).toEqual([["usable", null]]);
      // The Accounts view (its profiles on disk): the ended profile says reconnect; a live one doesn't.
      fm.refreshSignInIdentities = () => {};                 // no `claude auth status` for the identity line (no CLI here)
      const view = await fm.accountsView(0);
      const claude = view.clis.find((c: any) => c.backend === "claude-code");
      expect(claude.rows.filter((r: any) => r.scope.kind === "host").map((r: any) => [r.profile, r.state, r.reconnect ?? null]))
        .toEqual(expect.arrayContaining([[null, "not_signed_in", true], ["gone", "not_signed_in", true], ["hsinlin", "usable", null]]));
    } finally { fm.backendAvailabilityRows = rows; }
  });
  it("#3577 review P2: a profile saved but not yet applied — the agent still runs on the old one (as launched), which stays in use and warned about until the restart", async () => {
    const yaml = (profile: string) => [
      "health_port: 0", "instances:",
      `  cc:\n    working_directory: ${join(dir, "w")}\n    backend: claude-code\n    backend_options:\n      claude-code:\n        credential_profile: ${profile}`,
      `  cc2:\n    working_directory: ${join(dir, "w")}\n    backend: claude-code`,
    ].join("\n") + "\n";
    // cc started on hsinlin (a real lease, as a start takes it), and is running.
    const launched = fm.fleetConfig.instances.cc;
    const held = await fm.admitCredentialUse("cc", launched, "claude-code", () => {});
    held.published();
    fm.daemons.set("cc", { getConfigSnapshot: () => launched });
    // Then its profile is saved as "spare" (not applied: no restart).
    writeFileSync(join(dir, "fleet.yaml"), yaml("spare")); fm.loadConfig(join(dir, "fleet.yaml"));
    claudeCreds(join(dir, "credential-profiles", "claude-code", "spare"), T + 30 * 24 * 3_600_000);
    expect(fm.signInsInUse()).toEqual([{ backend: "claude-code", profile: "spare" }, { backend: "claude-code", profile: null }, { backend: "claude-code", profile: "hsinlin" }]);
    expect(fm.keepAliveAttention().map((l: any) => [l.profile, l.kind])).toEqual([[null, "ended"], ["hsinlin", "ending"]]);
    // Restarted on spare: the old lease is gone, and so is hsinlin's line (spare's end is a month off).
    held.release(); fm.daemons.delete("cc");
    expect(fm.signInsInUse().map((u: any) => u.profile)).toEqual(["spare", null]);
    expect(fm.keepAliveAttention().map((l: any) => l.profile)).toEqual([null]);
    // A lease left by an agent no longer running (not starting, no daemon) is not in use.
    const stale = await fm.admitCredentialUse("cc", launched, "claude-code", () => {}); stale.published();
    expect(fm.signInsInUse().map((u: any) => u.profile)).toEqual(["spare", null]);
    stale.release();
    writeFileSync(join(dir, "fleet.yaml"), yaml("hsinlin")); fm.loadConfig(join(dir, "fleet.yaml"));
  });
});
