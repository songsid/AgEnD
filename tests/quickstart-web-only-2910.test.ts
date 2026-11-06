/**
 * #2910 PR1 (the user, hmsg-41f549f7: 「要從 agend quickstart 開始 加入網頁為主相容」): `agend quickstart`'s web-only
 * path — the fleet it writes (no channel, no token, one agent bound to no connection), the first-agent questions, and
 * the sign-in code fetched once the fleet runs. The bot path's own prompts are unchanged (the PR's acceptance compares
 * real transcripts with main).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { askFirstAgent, fetchWebSignInCode, firstAgentFolder, newQuickstartFleet, newWebOnlyFleet, prepareFirstAgent, quickstartMode, retireOldBotTokens } from "../src/quickstart.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { parseEnvText } from "../src/env-file.js";
import { setLocale, getLocale } from "../src/locale.js";

const home = mkdtempSync(join(tmpdir(), "agend-qs-2910-"));
const locale = getLocale();
beforeEach(() => { vi.stubEnv("AGEND_HOME", home); setLocale("en"); vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); setLocale(locale); });
afterAll(() => rmSync(home, { recursive: true, force: true }));

const rl = (answers: string[]) => ({ question: vi.fn(async (_q: string) => { if (!answers.length) throw Error("unexpected prompt"); return answers.shift()!; }) });

describe("#2910 quickstart, web only: the fleet it writes", () => {
  it("no channel, no channels, one agent with its folder and backend; valid; the new-fleet defaults as the bot path's", () => {
    const fleet = newWebOnlyFleet(["/srv/projects"], "claude-code", { name: "agent-1", workingDirectory: "/srv/agents/a1" });
    expect(["channel" in fleet, "channels" in fleet]).toEqual([false, false]);
    expect(fleet.instances).toEqual({ "agent-1": { working_directory: "/srv/agents/a1", backend: "claude-code" } });
    expect([fleet.project_roots, fleet.defaults]).toEqual([["/srv/projects"], newQuickstartFleet([], ["/srv/projects"], "claude-code").defaults]);
    const v = validateFleetConfig(fleet);
    expect([v.valid, v.errors]).toEqual([true, []]);
  });
  it("a kiro fleet keeps the TUI default; no project roots: none written", () => {
    const fleet = newWebOnlyFleet([], "kiro-cli", { name: "k", workingDirectory: "/w" });
    expect([fleet.defaults.kiro_ui, "project_roots" in fleet]).toEqual(["tui", false]);
  });
});

describe("#2910 quickstart, web only: the first agent", () => {
  it("Enter twice: agent-1, in its own workspace under AGEND_HOME", async () => {
    const r = rl(["", ""]);
    expect(await askFirstAgent(r, "2/3")).toEqual({ name: "agent-1", workingDirectory: join(home, "workspaces", "agent-1"), ownWorkspace: true });
    expect(r.question.mock.calls.map(c => c[0])).toEqual(["  Agent name [agent-1]: ", `  Project folder (press Enter for its own workspace, ${join(home, "workspaces", "agent-1")}): `]);
  });
  it("a name that is not a path segment, and a relative folder, are asked again; ~ is the home directory", async () => {
    const r = rl(["../x", "..", "helper", "projects/app", "~/code/app"]);
    expect(await askFirstAgent(r, "2/3")).toEqual({ name: "helper", workingDirectory: join(homedir(), "code/app"), ownWorkspace: false });
    expect(r.question.mock.calls.length).toBe(5);
  });
  it("an absolute folder is kept as typed", async () => {
    expect(await askFirstAgent(rl(["web", "/srv/site"]), "2/3")).toEqual({ name: "web", workingDirectory: "/srv/site", ownWorkspace: false });
  });
  it("zh-TW: the questions are worded in Traditional Chinese", async () => {
    setLocale("zh-TW");
    const r = rl(["", ""]);
    await askFirstAgent(r, "2/3");
    expect(r.question.mock.calls[0]![0]).toBe("  agent 名稱 [agent-1]： ");
    expect(r.question.mock.calls[1]![0]).toMatch(/^  專案資料夾（直接按 Enter 使用它自己的工作區 .+）： $/);
  });
});

describe("#2910 quickstart, web only: the sign-in code once the fleet runs", () => {
  it("retries `agend web --code` until the fleet answers, then returns what it printed", async () => {
    let n = 0;
    const run = vi.fn(() => (++n < 3 ? { status: 1, stdout: "" } : { status: 0, stdout: "Sign-in page: http://localhost:19280/signin\nCode:         ABCD-EFGH   (works once, valid ~5 min)\n" }));
    expect(await fetchWebSignInCode(run, 1_000, 10)).toBe("Sign-in page: http://localhost:19280/signin\nCode:         ABCD-EFGH   (works once, valid ~5 min)");
    expect(run).toHaveBeenCalledTimes(3);
  });
  it("a success that printed nothing is not a code: it keeps asking", async () => {
    let n = 0;
    const run = vi.fn(() => (++n < 2 ? { status: 0, stdout: "  \n" } : { status: 0, stdout: "Code:         WXYZ-1234\n" }));
    expect(await fetchWebSignInCode(run, 1_000, 10)).toBe("Code:         WXYZ-1234");
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("not reachable before the deadline: null (the caller then says how to get one)", async () => {
    const run = vi.fn(() => ({ status: 1, stdout: "" }));
    expect(await fetchWebSignInCode(run, 50, 20)).toBeNull();
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// #2912 review (Fable).
describe("#2912 review: web only is the default; the workspace; ~; old bot tokens", () => {
  it("(1) the first question: Enter, 1 and anything else mean web only; only 2 means with a bot", () => {
    expect(["", "  ", "1", " 1 ", "x", "web", "3", "2", " 2 "].map(quickstartMode))
      .toEqual(["web", "web", "web", "web", "web", "web", "web", "bot", "bot"]);
  });
  it("(2) its own workspace is made with .git; a typed folder is the user's and left alone", () => {
    const own = join(home, "workspaces", "ws-own");
    prepareFirstAgent({ workingDirectory: own, ownWorkspace: true });
    expect([existsSync(own), existsSync(join(own, ".git")), (statSync(own).mode & 0o777).toString(8)]).toEqual([true, true, "700"]);
    const typed = join(home, "typed-folder");
    prepareFirstAgent({ workingDirectory: typed, ownWorkspace: false });
    expect(existsSync(typed)).toBe(false);
  });
  it("(4) ~ and ~/x are the home directory; ~bob/x and relative paths are not folders (asked again)", () => {
    expect([firstAgentFolder("~"), firstAgentFolder("~/code/app"), firstAgentFolder("/srv/x/../y"), firstAgentFolder("~bob/x"), firstAgentFolder("code/app")])
      .toEqual([homedir(), join(homedir(), "code/app"), "/srv/y", null, null]);
  });
  it("(3) start fresh from a bot fleet: its bot tokens leave .env (a backup keeps the whole file), other secrets stay", () => {
    const env = join(home, "env-retire"), now = 1_793_000_000_000;
    writeFileSync(env, "TG_TOKEN=111:aaa\nDISCORD_TOKEN=bbb\nANTHROPIC_API_KEY=keep-me\nAGEND_CLOUDFLARE_TUNNEL_TOKEN=keep-too\n");
    const old = { channels: [{ type: "telegram", bot_token_env: "TG_TOKEN" }, { type: "discord", bot_token_env: "DISCORD_TOKEN" }] };
    expect(retireOldBotTokens(env, old, now)).toEqual({ keys: ["TG_TOKEN", "DISCORD_TOKEN"], backup: `${env}.bak-${now}` });
    expect(readFileSync(env, "utf8")).toBe("ANTHROPIC_API_KEY=keep-me\nAGEND_CLOUDFLARE_TUNNEL_TOKEN=keep-too\n");
    expect(readFileSync(`${env}.bak-${now}`, "utf8")).toContain("TG_TOKEN=111:aaa");
    expect([(statSync(env).mode & 0o777).toString(8), (statSync(`${env}.bak-${now}`).mode & 0o777).toString(8)]).toEqual(["600", "600"]);
  });
  it("(3) #2912 r2: lines keyed as the daemon's .env reader keys them — `export KEY=…`, spaces around =; comments kept", () => {
    const env = join(home, "env-export");
    writeFileSync(env, "export AGEND_BOT_TOKEN=secret1\nOTHER=keep\n  AGEND_DISCORD_TOKEN = secret2\n# AGEND_BOT_TOKEN=a comment\nexport\tKEEP_ME=1\n");
    const old = { channels: [{ bot_token_env: "AGEND_BOT_TOKEN" }, { bot_token_env: "AGEND_DISCORD_TOKEN" }] };
    expect(retireOldBotTokens(env, old, 9)?.keys).toEqual(["AGEND_BOT_TOKEN", "AGEND_DISCORD_TOKEN"]);
    expect(readFileSync(env, "utf8")).toBe("OTHER=keep\n# AGEND_BOT_TOKEN=a comment\nexport\tKEEP_ME=1\n");
    expect(parseEnvText(readFileSync(env, "utf8"))).toEqual(new Map([["OTHER", "keep"], ["KEEP_ME", "1"]]));
  });
  it("(3) nothing to retire: a single-channel fleet whose key is absent, no fleet before, no .env — nothing written", () => {
    const env = join(home, "env-none");
    writeFileSync(env, "OTHER=1\n");
    expect([retireOldBotTokens(env, { channel: { bot_token_env: "TG_TOKEN" } }), retireOldBotTokens(env, null), retireOldBotTokens(join(home, "no-env"), { channel: { bot_token_env: "X" } })])
      .toEqual([null, null, null]);
    expect(readFileSync(env, "utf8")).toBe("OTHER=1\n");
    const single = join(home, "env-single");
    writeFileSync(single, "TG=1\n");
    expect(retireOldBotTokens(single, { channel: { bot_token_env: "TG" } }, 7)?.keys).toEqual(["TG"]);
    expect(readFileSync(single, "utf8")).toBe("");
  });
});
