/**
 * #2910 PR1 (the user, hmsg-41f549f7: 「要從 agend quickstart 開始 加入網頁為主相容」): `agend quickstart`'s web-only
 * path — the fleet it writes (no channel, no token, one agent bound to no connection), the first-agent questions, and
 * the sign-in code fetched once the fleet runs. The bot path's own prompts are unchanged (the PR's acceptance compares
 * real transcripts with main).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { askFirstAgent, fetchWebSignInCode, newQuickstartFleet, newWebOnlyFleet } from "../src/quickstart.js";
import { validateFleetConfig } from "../src/config-validator.js";
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
