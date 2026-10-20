/**
 * #2236 (a user's report, 2026-10-20): "I added a second Claude profile, my first one's usage is full, and the web
 * usage doesn't show everything." Every claude-code instance had moved to named profiles, so the default login — the
 * full one — got no row: rows were built only for logins an instance used, and the snapshot then kept only logins a
 * running instance used. Now every Claude login on the host has a row: the default ("Claude (default)") and every
 * profile there, used or not — except an unused profile that is signed out (not set up). No row is dropped as "the
 * same account as another" (Prism, #2237: config files cannot prove which account a login is). A login at its limit shows its 100% and reset time; a 429 is an error row,
 * never a missing one. The usage API is a stub; every token is a dummy.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAllUsage, fetchClaudeUsage, providersForConfig, setUsageProvidersForTests } from "../src/usage/providers.js";
import { filterUsageProviders, formatUsageSummary } from "../src/usage/usage-api.js";
import { credentialProfileHome } from "../src/backend/credential-profile.js";

const ENV_KEYS = ["HOME", "AGEND_HOME", "CLAUDE_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
const saved: Record<string, string | undefined> = {};
let root = "", agend = "";
/** What the usage API answers per token: a 5-hour utilization, or an HTTP status. */
let answers: Record<string, number | { status: number }> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), "agend-usage-2236-"));
  agend = join(root, "agend");
  mkdirSync(agend, { recursive: true });
  process.env.HOME = root;                                  // the default login's account file: ~/.claude.json
  process.env.AGEND_HOME = agend;
  process.env.CLAUDE_HOME = join(root, ".claude");           // the default login
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  answers = {};
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
    const a = answers[init.headers.Authorization.replace(/^Bearer /, "")] ?? 5;
    if (typeof a === "object") return { ok: false, status: a.status, headers: { get: () => "120" }, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: a, resets_at: "2026-10-20T08:00:00Z" }, seven_day: { utilization: a, resets_at: "2026-10-23T10:00:00Z" } }) };
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  setUsageProvidersForTests(null);
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
});

const login = (dir: string, token: string, account?: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token, subscriptionType: "team", rateLimitTier: "default" } }));
  if (account) writeFileSync(dir === process.env.CLAUDE_HOME ? join(root, ".claude.json") : join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: account } }));
};
const profileHome = (p: string) => credentialProfileHome(agend, "claude-code", p);
const onProfile = (p: string) => ({ backend: "claude-code", backend_options: { "claude-code": { credential_profile: p } } });
const BASE = [{ id: "claude", name: "Claude", fetch: fetchClaudeUsage }];
/** Every claude-code instance on a named profile — the user's fleet. */
const FLEET = { defaults: { backend: "kiro-cli" }, instances: { a: onProfile("hsinlin"), b: onProfile("hsinlin"), c: onProfile("jefflin") } } as never;
/** The snapshot as get_usage / the web panel / /usage get it: running instances use hsinlin only. */
async function snapshot(active: string[] = ["claude:hsinlin"]) {
  setUsageProvidersForTests(BASE as never);
  return filterUsageProviders(await fetchAllUsage(FLEET), active, { hostLogins: true });
}
const row = (s: { providers: Array<{ id: string }> }, id: string) => s.providers.find(p => p.id === id) as any;

describe("#2236: every Claude login on the host has a row", () => {
  it("the default login beside named profiles: \"Claude (default)\" with its own numbers — no instance uses it, nothing runs on it", async () => {
    login(process.env.CLAUDE_HOME!, "dummy-default", "acct-default");
    login(profileHome("hsinlin"), "dummy-hsinlin", "acct-h");
    login(profileHome("jefflin"), "dummy-jefflin", "acct-j");
    answers = { "dummy-default": 100, "dummy-hsinlin": 47, "dummy-jefflin": 11 };
    expect(providersForConfig(FLEET, BASE as never).map(r => [r.id, r.name])).toEqual([["claude", "Claude (default)"], ["claude:hsinlin", "Claude (hsinlin)"], ["claude:jefflin", "Claude (jefflin)"]]);
    const s = await snapshot();
    expect(s.providers.map(p => [p.id, p.status, (p as any).metrics[0]?.used])).toEqual([["claude", "ok", 100], ["claude:hsinlin", "ok", 47], ["claude:jefflin", "ok", 11]]);
  });
  it("at its limit: 100% with its reset time, in get_usage and in /usage", async () => {
    login(process.env.CLAUDE_HOME!, "dummy-default", "acct-default");
    login(profileHome("hsinlin"), "dummy-hsinlin", "acct-h");
    answers = { "dummy-default": 100 };
    const s = await snapshot();
    expect(row(s, "claude").metrics.map((m: any) => [m.label, m.used, m.resetsAt])).toEqual([["Session", 100, "2026-10-20T08:00:00.000Z"], ["Weekly", 100, "2026-10-23T10:00:00.000Z"]]);
    expect(formatUsageSummary(s)).toMatch(/· Claude \(default\)[^\n]*100%/);
  });
  it("a 429 from the usage endpoint: an error row that says so — never a missing row", async () => {
    login(process.env.CLAUDE_HOME!, "dummy-default", "acct-default");
    login(profileHome("hsinlin"), "dummy-hsinlin", "acct-h");
    answers = { "dummy-default": { status: 429 } };
    const s = await snapshot();
    expect([row(s, "claude")?.status, row(s, "claude")?.error, row(s, "claude:hsinlin")?.status]).toEqual(["error", "Rate limited by Anthropic — try again later.", "ok"]);
    expect(formatUsageSummary(s)).toMatch(/· Claude \(default\)[^\n]*Rate limited/);
  });
  it("a profile no instance uses — signed in: its row, kept through the running-instances filter; signed out: none (not set up)", async () => {
    login(profileHome("hsinlin"), "dummy-hsinlin");
    login(profileHome("spare"), "dummy-spare");
    mkdirSync(profileHome("empty"), { recursive: true });
    answers = { "dummy-spare": 33 };
    const s = await snapshot();
    // No default login on this host; jefflin is used by an instance and signed out: its row says so (#1699); "empty"
    // is used by none and signed out: no row.
    expect(s.providers.map(p => p.id)).toEqual(["claude:hsinlin", "claude:jefflin", "claude:spare"]);
    expect(row(s, "claude:jefflin").hintI18n?.key).toMatch(/claude_profile_signed_out/);
    expect(row(s, "claude:spare").metrics[0].used).toBe(33);
  });
  it("Prism (#2237): no row is dropped as \"the same account\" — both signed in to one account: both rows", async () => {
    login(process.env.CLAUDE_HOME!, "dummy-default", "acct-same");
    login(profileHome("hsinlin"), "dummy-hsinlin", "acct-same");
    const s = await snapshot();
    expect(s.providers.map(p => p.id)).toEqual(["claude", "claude:hsinlin", "claude:jefflin"]);   // jefflin: used, signed out (#1699)
  });
  it("Prism (#2237): the default at 100% beside an unused profile whose stale account file names the same account but which is signed out — the default stays", async () => {
    login(process.env.CLAUDE_HOME!, "dummy-default", "acct-same");
    mkdirSync(profileHome("retired"), { recursive: true });
    writeFileSync(join(profileHome("retired"), ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "acct-same" } }));
    answers = { "dummy-default": 100 };
    setUsageProvidersForTests(BASE as never);
    const s = filterUsageProviders(await fetchAllUsage({ defaults: {}, instances: {} } as never), [], { hostLogins: true });
    expect(s.providers.map(p => [p.id, (p as any).metrics[0]?.used])).toEqual([["claude", 100]]);
  });
  it("Prism (#2237): the default signed in by CLAUDE_CODE_OAUTH_TOKEN, ~/.claude.json naming a profile's account — the default row reads the env login", async () => {
    writeFileSync(join(root, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "acct-same" } }));
    login(profileHome("retired"), "dummy-retired", "acct-same");
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "dummy-env";
    answers = { "dummy-env": 100, "dummy-retired": 20 };
    setUsageProvidersForTests(BASE as never);
    const s = filterUsageProviders(await fetchAllUsage({ defaults: {}, instances: {} } as never), [], { hostLogins: true });
    expect(s.providers.map(p => [p.id, (p as any).metrics[0]?.used])).toEqual([["claude", 100], ["claude:retired", 20]]);
  });
  it("Prism (#2237): a bot running only on the default login keeps its Claude row in its own scoped list, a same-account profile beside it or not", async () => {
    login(process.env.CLAUDE_HOME!, "dummy-default", "acct-same");
    login(profileHome("retired"), "dummy-retired", "acct-same");
    setUsageProvidersForTests(BASE as never);
    const scoped = filterUsageProviders(await fetchAllUsage({ defaults: {}, instances: { a: { backend: "claude-code" } } } as never), ["claude"]);
    expect(scoped.providers.map(p => p.id)).toEqual(["claude"]);
  });
  it("no default login and no profile: no Claude row at all (as before)", async () => {
    setUsageProvidersForTests(BASE as never);
    const s = filterUsageProviders(await fetchAllUsage({ defaults: {}, instances: {} } as never), [], { hostLogins: true });
    expect(s.providers).toEqual([]);
  });
  it("a bot's own scoped list (no hostLogins) stays exactly its running instances' providers", async () => {
    login(process.env.CLAUDE_HOME!, "dummy-default", "acct-default");
    login(profileHome("hsinlin"), "dummy-hsinlin", "acct-h");
    setUsageProvidersForTests(BASE as never);
    const scoped = filterUsageProviders(await fetchAllUsage(FLEET), ["claude:hsinlin"]);
    expect(scoped.providers.map(p => p.id)).toEqual(["claude:hsinlin"]);
  });
});
