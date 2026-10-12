/**
 * #1699 part 3 (design: #1699 comment §6, §2): a Claude credential profile is a subscription of its own, so usage
 * shows one `claude:<profile>` row per profile beside the shared `claude` row — each read with that profile's own
 * login (its config dir's `.credentials.json`; on macOS the Keychain item claude names after that dir), and with the
 * rate limits only its own instances wrote. A profile with no login says so with the line that signs it in; it never
 * shows the shared account's numbers. A fleet without profiles is exactly as before. The usage API is a stub that
 * records the bearer; every token is a dummy.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAllUsage, fetchClaudeUsage, getClaudeOAuthToken, providersForConfig, setClaudeKeychainForTests, setUsageProvidersForTests, shellRcSetsClaudeToken } from "../src/usage/providers.js";
import { filterUsageProviders, formatUsageSummary } from "../src/usage/usage-api.js";
import { claudeKeychainService, claudeProfileConfigDir } from "../src/backend/claude-code.js";
import { credentialProfileHome } from "../src/backend/credential-profile.js";

const ENV_KEYS = ["HOME", "AGEND_HOME", "CLAUDE_HOME", "CLAUDE_CODE_OAUTH_TOKEN", "USER"] as const;
const saved: Record<string, string | undefined> = {};
let root = "", agend = "";
/** The bearer of every usage request. */
let bearers: string[] = [];

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), "agend-claude-usage-1699-"));
  agend = join(root, "agend");
  mkdirSync(agend, { recursive: true });
  process.env.HOME = root;                              // no shell rc of the developer's
  process.env.AGEND_HOME = agend;
  process.env.CLAUDE_HOME = join(root, "shared-claude");  // the shared login
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  bearers = [];
  // The usage API: answers each token with its own numbers, so a row shows whose login it read.
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
    const token = init.headers.Authorization.replace(/^Bearer /, "");
    bearers.push(token);
    const used = { "dummy-shared": 11, "dummy-work": 22, "dummy-team": 33, "dummy-keychain-work": 44 }[token] ?? 99;
    return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: used, resets_at: null } }) };
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  setClaudeKeychainForTests(null);
  setUsageProvidersForTests(null);
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
});

const credentials = (dir: string, accessToken: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken, subscriptionType: "team", rateLimitTier: "default" } }));
};
const profileHome = (profile: string) => credentialProfileHome(agend, "claude-code", profile);
const onProfile = (profile?: string) => ({ backend: "claude-code", ...(profile ? { backend_options: { "claude-code": { credential_profile: profile } } } : {}) });
const BASE = [{ id: "claude", name: "Claude", fetch: fetchClaudeUsage }];
const session = (row: { metrics: Array<{ used?: number }> }) => row.metrics[0]?.used ?? null;
/** An instance's statusline.json: its 5-hour %, where claude said its conversation is, written `ageMs` ago. */
function statusline(instance: string, used: number, transcriptPath: string, ageMs: number) {
  const dir = join(agend, "instances", instance);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "statusline.json");
  writeFileSync(file, JSON.stringify({ transcript_path: transcriptPath, rate_limits: { five_hour: { used_percentage: used, resets_at: Math.floor(Date.now() / 1000) + 3600 } } }));
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(file, t, t);
}

describe("one row per Claude subscription", () => {
  it("two profiles: two claude:<profile> rows, each read with its own token — never the shared one", async () => {
    credentials(process.env.CLAUDE_HOME!, "dummy-shared");
    credentials(profileHome("work"), "dummy-work");
    credentials(profileHome("team"), "dummy-team");
    const rows = providersForConfig({ defaults: {}, instances: { a: onProfile("work"), b: onProfile("team") } } as never, BASE as never);
    expect(rows.map(r => [r.id, r.name])).toEqual([["claude:team", "Claude (team)"], ["claude:work", "Claude (work)"]]);
    const results = [];
    for (const r of rows) { bearers = []; const u = await r.fetch(); results.push([r.id, bearers, session(u)]); }
    expect(results).toEqual([["claude:team", ["dummy-team"], 33], ["claude:work", ["dummy-work"], 22]]);
  });

  it("a fleet mixing the shared login and a profile: the shared row too, each with its own numbers", async () => {
    credentials(process.env.CLAUDE_HOME!, "dummy-shared");
    credentials(profileHome("work"), "dummy-work");
    const rows = providersForConfig({ defaults: {}, instances: { a: onProfile(), b: onProfile("work") } } as never, BASE as never);
    const results = [];
    for (const r of rows) { bearers = []; const u = await r.fetch(); results.push([r.id, bearers, session(u)]); }
    expect(results).toEqual([["claude", ["dummy-shared"], 11], ["claude:work", ["dummy-work"], 22]]);
  });

  it("no profiles: the provider row itself, as before — and the shared login still falls back to CLAUDE_CODE_OAUTH_TOKEN", async () => {
    const rows = providersForConfig({ defaults: {}, instances: { a: onProfile(), b: onProfile() } } as never, BASE as never);
    expect(rows.length === 1 && rows[0] === BASE[0], "the very same row object").toBe(true);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "dummy-shared";
    const u = await rows[0].fetch();
    expect([bearers, session(u)]).toEqual([["dummy-shared"], 11]);
  });
});

describe("an instance that names no backend runs Claude Code (the fleet default)", () => {
  it("its profile gets a row too; with none, the one shared row as before", async () => {
    credentials(profileHome("work"), "dummy-work");
    const implicit = (profile?: string) => (profile ? { backend_options: { "claude-code": { credential_profile: profile } } } : {});
    const rows = providersForConfig({ defaults: {}, instances: { a: implicit(), b: implicit("work") } } as never, BASE as never);
    expect(rows.map(r => r.id)).toEqual(["claude", "claude:work"]);
    bearers = [];
    await rows[1].fetch();
    expect(bearers).toEqual(["dummy-work"]);
    const plain = providersForConfig({ defaults: {}, instances: { a: implicit(), b: implicit() } } as never, BASE as never);
    expect(plain.length === 1 && plain[0] === BASE[0]).toBe(true);
    const otherDefault = providersForConfig({ defaults: { backend: "codex" }, instances: { a: implicit("work") } } as never, BASE as never);
    expect(otherDefault.map(r => r.id), "the fleet default is another backend: not a Claude binding").toEqual(["claude"]);
  });
});

describe("a profile with no login", () => {
  it("says so with the line that signs it in — no request, and none of the shared account's token, env token or numbers", async () => {
    credentials(process.env.CLAUDE_HOME!, "dummy-shared");
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "dummy-shared";
    statusline("shared-one", 70, join(root, ".claude", "projects", "-w", "s.jsonl"), 1000);   // the shared account's limits
    const [row] = providersForConfig({ defaults: {}, instances: { a: onProfile("work") } } as never, BASE as never);
    const u = await row.fetch();
    const host = `CLAUDE_CONFIG_DIR=${JSON.stringify(profileHome("work"))} claude auth login`;
    expect([row.id, bearers, u.status, u.metrics, u.hint, u.hintI18n]).toEqual([
      "claude:work", [], "ok", [], `Not logged in — sign in with \`/login claude-code work\` (or run \`${host}\` on the host).`,
      { key: "usage.hint.claude_profile_signed_out_chat", args: ["/login claude-code work", host] },
    ]);
  });

  it("asked for a config dir alone (no profile name to log in from chat): the host line", async () => {
    const u = await fetchClaudeUsage(profileHome("work"));
    const host = `CLAUDE_CONFIG_DIR=${JSON.stringify(profileHome("work"))} claude auth login`;
    expect([bearers, u.status, u.hint, u.hintI18n]).toEqual([[], "ok", `Not logged in — sign in with: ${host}`, { key: "usage.hint.claude_profile_signed_out", args: [host] }]);
  });

  it("its token reader gives nothing either (no shared or env fallback)", async () => {
    credentials(process.env.CLAUDE_HOME!, "dummy-shared");
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "dummy-shared";
    expect([await getClaudeOAuthToken(profileHome("work")), await getClaudeOAuthToken()]).toEqual([null, "dummy-shared"]);
  });
});

describe("what /usage and get_usage carry", () => {
  it("the snapshot has the shared row and one per profile; the active filter keeps the claude:<profile> ids; /usage prints each", async () => {
    credentials(process.env.CLAUDE_HOME!, "dummy-shared");
    credentials(profileHome("work"), "dummy-work");
    setUsageProvidersForTests(BASE as never);
    const snapshot = await fetchAllUsage({ defaults: {}, instances: { a: onProfile(), b: onProfile("work"), c: onProfile("team") } } as never);
    const active = filterUsageProviders(snapshot, ["claude", "claude:work", "claude:team"]);
    expect(active.providers.map(p => [p.id, p.name, p.status])).toEqual([
      ["claude", "Claude", "ok"], ["claude:team", "Claude (team)", "ok"], ["claude:work", "Claude (work)", "ok"],
    ]);
    const text = formatUsageSummary(active);
    expect(text).toMatch(/· Claude \(Team Standard \(1\.25x\)\): [^\n]*11%/);
    expect(text).toMatch(/· Claude \(work\) \(Team Standard \(1\.25x\)\): [^\n]*22%/);
    expect(text).toContain(`· Claude (team): `);
    expect(text).toContain(`Not logged in — sign in with \`/login claude-code team\` (or run \`CLAUDE_CONFIG_DIR=${JSON.stringify(profileHome("team"))} claude auth login\` on the host).`);
  });
});

describe("macOS: the profile's own Keychain item", () => {
  it("is Claude Code-credentials-<sha256(dir)[0..8]> of the dir claude was launched with — the canonical one, whatever AGEND_HOME looked like", async () => {
    process.env.AGEND_HOME = `${agend}/./`;                                      // not canonical as written
    const launched = claudeProfileConfigDir({ credential_profile: "work" })!;     // what CLAUDE_CONFIG_DIR carries at launch
    const expected = `Claude Code-credentials-${createHash("sha256").update(join(agend, "credential-profiles", "claude-code", "work").normalize("NFC")).digest("hex").slice(0, 8)}`;
    const asked: Array<[string, string]> = [];
    process.env.USER = "someone";
    setClaudeKeychainForTests({ platform: "darwin", read: async (service, account) => { asked.push([service, account]); return JSON.stringify({ claudeAiOauth: { accessToken: "dummy-keychain-work" } }); } });
    const [row] = providersForConfig({ defaults: {}, instances: { a: onProfile("work") } } as never, BASE as never);
    const u = await row.fetch();
    expect([claudeKeychainService(launched), asked, bearers, session(u)]).toEqual([expected, [[expected, "someone"]], ["dummy-keychain-work"], 44]);
  });

  it("the shared row is as before on macOS: no Keychain read", async () => {
    credentials(process.env.CLAUDE_HOME!, "dummy-shared");
    const read = vi.fn(async () => null);
    setClaudeKeychainForTests({ platform: "darwin", read });
    await fetchClaudeUsage();
    expect([read.mock.calls.length, bearers]).toEqual([0, ["dummy-shared"]]);
  });

  it("no Keychain item: the profile's .credentials.json; neither: not logged in", async () => {
    setClaudeKeychainForTests({ platform: "darwin", read: async () => null });
    credentials(profileHome("work"), "dummy-work");
    const [work] = providersForConfig({ defaults: {}, instances: { a: onProfile("work") } } as never, BASE as never);
    const [team] = providersForConfig({ defaults: {}, instances: { a: onProfile("team") } } as never, BASE as never);
    const w = await work.fetch(), t = await team.fetch();
    expect([session(w), bearers, t.hintI18n?.key]).toEqual([22, ["dummy-work"], "usage.hint.claude_profile_signed_out_chat"]);
  });
});

describe("review r1: the Keychain as claude reads it", () => {
  /** A Keychain holding one item: `service` under `account` → `secret`. */
  const keychain = (account: string, secret: string, username: () => string = () => "unused") =>
    setClaudeKeychainForTests({ platform: "darwin", username, read: async (service, acct) => (service === claudeKeychainService(profileHome("work")) && acct === account ? secret : null) });
  const KEY = JSON.stringify({ claudeAiOauth: { accessToken: "dummy-keychain-work" } });
  const workRow = () => providersForConfig({ defaults: {}, instances: { a: onProfile("work") } } as never, BASE as never)[0];

  it("no $USER: the OS user name is the account", async () => {
    delete process.env.USER;
    keychain("dummy-os-user", KEY, () => "dummy-os-user");
    const u = await workRow().fetch();
    expect([bearers, session(u), await getClaudeOAuthToken(profileHome("work"))]).toEqual([["dummy-keychain-work"], 44, "dummy-keychain-work"]);
  });

  it("a $USER claude would not use (not [a-zA-Z0-9._-]+), or no name at all: claude-code-user", async () => {
    process.env.USER = "bad account";
    keychain("claude-code-user", KEY);
    const a = await workRow().fetch();
    delete process.env.USER;
    keychain("claude-code-user", KEY, () => { throw new Error("no passwd entry"); });
    bearers = [];
    const b = await workRow().fetch();
    expect([session(a), session(b), bearers]).toEqual([44, 44, ["dummy-keychain-work"]]);
  });

  it("an item with no OAuth in it is the profile's login (none): an older .credentials.json beside it is not read", async () => {
    keychain("someone", JSON.stringify({ mcpOAuth: {} }));
    process.env.USER = "someone";
    credentials(profileHome("work"), "dummy-team");
    const u = await workRow().fetch();
    expect([bearers, u.metrics, u.hintI18n?.key, await getClaudeOAuthToken(profileHome("work"))]).toEqual([[], [], "usage.hint.claude_profile_signed_out_chat", null]);
  });

  it("control: an item that is not a credentials document (unparseable) is no item — the file is read", async () => {
    keychain("someone", "not json");
    process.env.USER = "someone";
    credentials(profileHome("work"), "dummy-work");
    expect(session(await workRow().fetch())).toBe(22);
  });
});

describe("statusline rate limits stay with their subscription", () => {
  /** The usage API is down: each row falls back to the limits its own instances wrote. */
  const apiDown = () => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

  it("a profile's row: its own instance's reading, even when the shared one's is fresher; the shared row: never the profile's", async () => {
    credentials(process.env.CLAUDE_HOME!, "dummy-shared");
    credentials(profileHome("work"), "dummy-work");
    statusline("on-work", 55, join(profileHome("work"), "projects", "-w", "s.jsonl"), 60_000);
    statusline("on-shared", 15, join(root, ".claude", "projects", "-w", "s.jsonl"), 1_000);
    apiDown();
    const rows = providersForConfig({ defaults: {}, instances: { a: onProfile(), b: onProfile("work") } } as never, BASE as never);
    const got = [];
    for (const r of rows) got.push([r.id, session(await r.fetch())]);
    expect(got).toEqual([["claude", 15], ["claude:work", 55]]);
    statusline("on-shared", 15, join(root, ".claude", "projects", "-w", "s.jsonl"), 120_000);   // now the profile's is the fresher
    const again = [];
    for (const r of rows) again.push([r.id, session(await r.fetch())]);
    expect(again).toEqual([["claude", 15], ["claude:work", 55]]);
  });

  it("review r1: a token in the environment can sign the profile's instances in — their readings are not the profile's", async () => {
    statusline("on-work", 71, join(profileHome("work"), "projects", "-w", "s.jsonl"), 1_000);
    apiDown();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "dummy-shared";
    const workRow = () => providersForConfig({ defaults: {}, instances: { a: onProfile("work") } } as never, BASE as never)[0];
    const signedOut = await workRow().fetch();                        // (a) no login of its own
    credentials(profileHome("work"), "dummy-work");
    const failing = await workRow().fetch();                          // (b) its own login, API down
    expect([session(signedOut), signedOut.hintI18n?.key, session(failing), failing.status]).toEqual([null, "usage.hint.claude_profile_signed_out_chat", null, "error"]);
  });

  it("review r1: the same with the token exported in a shell rc (the pane's shell reads it)", async () => {
    statusline("on-work", 71, join(profileHome("work"), "projects", "-w", "s.jsonl"), 1_000);
    credentials(profileHome("work"), "dummy-work");
    apiDown();
    writeFileSync(join(root, ".bashrc"), "export CLAUDE_CODE_OAUTH_TOKEN=dummy-shared\n");
    const [work] = providersForConfig({ defaults: {}, instances: { a: onProfile("work") } } as never, BASE as never);
    const u = await work.fetch();
    expect([session(u), u.status]).toEqual([null, "error"]);
  });

  it("review r2: a shell rc setting the token from another variable ($X, ${X}) reaches claude too — the readings are not the profile's", async () => {
    const outcomes = [];
    for (const rc of ['SHARED_TOKEN=dummy-shared\nexport CLAUDE_CODE_OAUTH_TOKEN="$SHARED_TOKEN"\n', 'SHARED_TOKEN=dummy-shared\nexport CLAUDE_CODE_OAUTH_TOKEN="${SHARED_TOKEN}"\n']) {
      statusline("on-work", 71, join(profileHome("work"), "projects", "-w", "s.jsonl"), 1_000);
      credentials(profileHome("work"), "dummy-work");
      apiDown();
      writeFileSync(join(root, ".bashrc"), rc);
      const [work] = providersForConfig({ defaults: {}, instances: { a: onProfile("work") } } as never, BASE as never);
      const u = await work.fetch();
      outcomes.push([u.status, session(u)]);
    }
    expect(outcomes).toEqual([["error", null], ["error", null]]);
  });

  it("review r2 control: an rc exporting only another variable leaves the profile's own reading as its fallback", async () => {
    statusline("on-work", 71, join(profileHome("work"), "projects", "-w", "s.jsonl"), 1_000);
    credentials(profileHome("work"), "dummy-work");
    apiDown();
    writeFileSync(join(root, ".bashrc"), "export SHARED_TOKEN=dummy-shared\n");
    const [work] = providersForConfig({ defaults: {}, instances: { a: onProfile("work") } } as never, BASE as never);
    const u = await work.fetch();
    expect([u.status, session(u)]).toEqual(["ok", 71]);
  });

  it("what counts as an rc setting the token (any assignment, export or declaration — not a comment, not another name)", () => {
    const sets = (rc: string) => shellRcSetsClaudeToken(() => rc, "/h", ["rc"]);
    const yes = ["CLAUDE_CODE_OAUTH_TOKEN=x", "export CLAUDE_CODE_OAUTH_TOKEN=x", '  export CLAUDE_CODE_OAUTH_TOKEN="$T"', "export CLAUDE_CODE_OAUTH_TOKEN=${T}",
      "export A=1 CLAUDE_CODE_OAUTH_TOKEN=$T", "export CLAUDE_CODE_OAUTH_TOKEN", "declare -x CLAUDE_CODE_OAUTH_TOKEN=$T", "typeset -x CLAUDE_CODE_OAUTH_TOKEN",
      "readonly CLAUDE_CODE_OAUTH_TOKEN=x", "setenv CLAUDE_CODE_OAUTH_TOKEN x", "CLAUDE_CODE_OAUTH_TOKEN=", "export CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.tok)"];
    const no = ["# export CLAUDE_CODE_OAUTH_TOKEN=x", "export SHARED_TOKEN=x", "echo $CLAUDE_CODE_OAUTH_TOKEN", "export MY_CLAUDE_CODE_OAUTH_TOKEN=x", "export A=1 # CLAUDE_CODE_OAUTH_TOKEN=x", ""];
    expect([yes.filter((l) => !sets(l)), no.filter((l) => sets(l))]).toEqual([[], []]);
    expect(shellRcSetsClaudeToken(() => { throw new Error("ENOENT"); }, "/h", ["rc"])).toBe(false);
    // Every rc is read: a harmless .bashrc does not hide the .zshrc that sets it.
    const rcs: Record<string, string> = { "/h/.bashrc": "export PATH=$PATH:~/bin\n", "/h/.zshrc": 'export CLAUDE_CODE_OAUTH_TOKEN="$T"\n' };
    expect(shellRcSetsClaudeToken((p) => { if (p in rcs) return rcs[p]; throw new Error("ENOENT"); }, "/h")).toBe(true);
  });

  it("review r1 control: no token in the environment — the profile's own reading is its fallback", async () => {
    statusline("on-work", 71, join(profileHome("work"), "projects", "-w", "s.jsonl"), 1_000);
    credentials(profileHome("work"), "dummy-work");
    apiDown();
    const [work] = providersForConfig({ defaults: {}, instances: { a: onProfile("work") } } as never, BASE as never);
    expect(session(await work.fetch())).toBe(71);
  });

  it("another profile's reading is not this profile's; a reading with no transcript path is the shared login's", async () => {
    credentials(profileHome("work"), "dummy-work");
    statusline("on-team", 77, join(profileHome("team"), "projects", "-w", "s.jsonl"), 1_000);
    apiDown();
    const [work] = providersForConfig({ defaults: {}, instances: { a: onProfile("work") } } as never, BASE as never);
    const w = await work.fetch();
    expect([w.status, session(w)]).toEqual(["error", null]);
    const dir = join(agend, "instances", "old-cli");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "statusline.json"), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5, resets_at: Math.floor(Date.now() / 1000) + 3600 } } }));
    const [shared] = providersForConfig({ defaults: {}, instances: { a: onProfile(), b: onProfile("work") } } as never, BASE as never);
    expect(session(await shared.fetch())).toBe(5);
  });

  it("a path only beginning like the profile's projects dir is not in it", async () => {
    credentials(profileHome("work"), "dummy-work");
    statusline("sibling", 66, join(profileHome("work"), "projects-old", "-w", "s.jsonl"), 1_000);
    apiDown();
    const [work] = providersForConfig({ defaults: {}, instances: { a: onProfile("work") } } as never, BASE as never);
    expect(session(await work.fetch())).toBe(null);
  });

  it("no profiles: every instance's reading counts, as before (the freshest wins)", async () => {
    statusline("x", 40, join(profileHome("old"), "projects", "-w", "s.jsonl"), 1_000);   // even one under a profile dir
    statusline("y", 20, join(root, ".claude", "projects", "-w", "s.jsonl"), 60_000);
    const [row] = providersForConfig({ defaults: {}, instances: { a: onProfile() } } as never, BASE as never);
    expect(session(await row.fetch())).toBe(40);
  });
});
