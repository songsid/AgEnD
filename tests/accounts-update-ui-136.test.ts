/**
 * AGEND-136 (upstream #3521): the Update button on the host's row (src/ui/accounts-view.js + host-install.js, the real modules over a faked /ui/accounts and /ui/host-*).
 * - An installed CLI shows its version against the audited release. Behind it → "Update to <audited>" (the label says which release it installs); at it → "up to date"
 *   and no button; newer than anything audited → "not verified by AgEnD yet" and no button; a CLI that updates itself → the versions and no button.
 * - Update posts the CLI's id to /ui/host-update and nothing else; the row says Updating…, shows the output and a Cancel; the verdict says the version before and after,
 *   or the exit code and the last lines. One window: every other Install, Update and Sign in waits.
 * - The public link's page shows neither a button nor the line. Both languages, no raw key.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const hostRow = (backend: string, state: string, extra: Record<string, unknown> = {}) => ({ scope: { kind: "host" }, backend, profile: null, state, signIn: false, usedBy: { agents: [], classic: [], fleetDefault: true }, ...extra });
const upd = (state: string, installed: string, audited: string, over: Record<string, unknown> = {}) => ({ state, installed, audited, button: state === "behind", via: "dashboard", ...over });
const GROK_BEHIND = { backend: "grok", profiles: false, installed: true, fleetDefault: null, agents: [], rows: [hostRow("grok", "usable", { signIn: true, version: "1.0.70", cliUpdate: upd("behind", "1.0.70", "1.0.77") })] };
const CODEX_CURRENT = { backend: "codex", profiles: true, installed: true, fleetDefault: null, agents: [], rows: [hostRow("codex", "usable", { signIn: true, version: "0.166.0", cliUpdate: upd("current", "0.166.0", "0.166.0") })] };
const CLAUDE_NEWER = { backend: "claude-code", profiles: true, installed: true, fleetDefault: null, agents: [], rows: [hostRow("claude-code", "usable", { signIn: true, version: "2.1.319", cliUpdate: upd("newer", "2.1.319", "2.1.318") })] };
const AGY_SELF = { backend: "antigravity", profiles: true, installed: true, fleetDefault: null, agents: [], rows: [hostRow("antigravity", "usable", { signIn: true, version: "1.3.5", cliUpdate: upd("behind", "1.3.5", "1.3.6", { via: "self", button: false }) })] };
const OPENCODE_BEHIND = { backend: "opencode", profiles: false, installed: true, installOnly: true, fleetDefault: null, agents: [], rows: [hostRow("opencode", "usable", { version: "1.17.20", cliUpdate: upd("behind", "1.17.20", "1.18.34") })] };
let view: any = { clis: [CLAUDE_NEWER, CODEX_CURRENT, GROK_BEHIND, AGY_SELF, OPENCODE_BEHIND] };
let run: any = null;
type Req = { method: string; url: string; body: any };
let reqs: Req[] = [];
let postAnswer: (r: Req) => { status?: number; body: unknown } = () => ({ body: {} });
const fetchFake = async (url: string, init: any = {}) => {
  const r: Req = { method: init.method || "GET", url: String(url), body: init.body ? JSON.parse(init.body) : null };
  reqs.push(r);
  if (r.method === "POST") { const a = postAnswer(r); const status = a.status ?? 200; return { ok: status < 300, status, json: async () => a.body }; }
  const body = r.url.startsWith("/ui/accounts") ? view : r.url === "/ui/host-install" ? { install: run } : { login: null, targets: [] };
  return { ok: true, status: 200, json: async () => body };
};
const RUN = (over: Record<string, unknown> = {}) => ({ id: "u".repeat(32), backend: "grok", mode: "update", fromVersion: "1.0.70", targetVersion: "1.0.77", phase: "running", startedOn: "Firefox on Linux", startedAt: 1, endedAt: null, lines: [], exitCode: null, verified: null, version: null, signIn: false, cleanupFailed: false, ...over });

let p: AppPage, A: any, S: any, HI: any, i18n: any, shell: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/settings/agents", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  shell = await import("/assets/app-shell.js"); i18n = await import("/assets/app-i18n.js");
  S = await import("/ui/js/backend-signin.js");
  HI = await import("/ui/js/host-install.js");
  A = await import("/ui/js/accounts-view.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount(); i18n.setLang("en", { store: false });
  view = { clis: [CLAUDE_NEWER, CODEX_CURRENT, GROK_BEHIND, AGY_SELF, OPENCODE_BEHIND] }; run = null; reqs = []; postAnswer = () => ({ body: {} });
  A.accountsStore.set({ loaded: false, failed: false, view: null });
  HI.hostInstallStore.set({ loaded: false, run: null, dismissed: [], starting: null });
  S.signInStore.set({ loaded: false, login: null, targets: [], structured: null }); shell.shellStore.set({ dialog: null });
  document.body?.removeAttribute?.("data-public-link");
});
async function mount() { await p.mount(h(A.AccountsView, { instances: {}, stageAgent: () => {}, stageDefault: () => {} })); await settle(8); }
const card = (b: string) => p.root.querySelector(`.s-account-card[data-backend="${b}"]`);
const text = (el: any) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const updateBtn = (b: string) => card(b)?.querySelectorAll("button").find((x: any) => /^(Update to |Updating|更新)/.test(x.textContent.trim()));
const line = (b: string) => card(b)?.querySelector(".s-account-version");
const post = () => reqs.filter(r => r.method === "POST");
const disabled = (el: any) => !!(el?.disabled ?? el?.hasAttribute?.("disabled"));

describe("the version line and the Update button", () => {
  it("behind the audited release: the line says both versions, the button names the release it installs", async () => {
    await mount();
    expect(text(line("grok"))).toContain("1.0.70 is installed");
    expect(text(line("grok"))).toContain("1.0.77");
    expect(text(line("grok"))).toContain("not the newest release");
    expect(text(updateBtn("grok"))).toBe("Update to 1.0.77");
    expect(line("grok").getAttribute("data-cli-update")).toBe("behind");
  });
  it("at the audited release: up to date, and no button", async () => {
    await mount();
    expect(text(line("codex"))).toContain("up to date");
    expect(text(line("codex"))).toContain("0.166.0");
    expect(updateBtn("codex")).toBeUndefined();
  });
  it("newer than anything audited: 'not verified by AgEnD yet', and no button", async () => {
    await mount();
    expect(text(line("claude-code"))).toContain("2.1.319");
    expect(text(line("claude-code"))).toContain("not verified by AgEnD yet");
    expect(updateBtn("claude-code")).toBeUndefined();
  });
  it("a CLI that updates itself: the versions and the reason, and no button even though it is behind", async () => {
    await mount();
    expect(text(line("antigravity"))).toContain("1.3.5");
    expect(text(line("antigravity"))).toContain("1.3.6");
    expect(text(line("antigravity"))).toContain("updates itself in the background");
    expect(line("antigravity").getAttribute("data-via")).toBe("self");
    expect(updateBtn("antigravity")).toBeUndefined();
  });
  it("OpenCode (no account card) is a small card with its version line and Update", async () => {
    await mount();
    expect(text(updateBtn("opencode"))).toBe("Update to 1.18.34");
    expect(card("opencode").querySelector(".s-account-used")).toBeNull();
  });
  it("a version that could not be read says so, without a button", async () => {
    view = { clis: [{ ...GROK_BEHIND, rows: [hostRow("grok", "usable", { signIn: true, cliUpdate: { state: "unknown", installed: null, audited: "1.0.77", button: false, via: "dashboard" } })] }] };
    await mount();
    expect(text(line("grok"))).toContain("could not be read");
    expect(updateBtn("grok")).toBeUndefined();
  });
});

describe("pressing Update", () => {
  it("posts the CLI's id to /ui/host-update and nothing else — no version, no command", async () => {
    postAnswer = () => ({ body: { install: RUN() } });
    await mount();
    fire(updateBtn("grok"), "click"); await settle(8);
    expect(post()).toEqual([{ method: "POST", url: "/ui/host-update", body: { backend: "grok" } }]);
    expect(JSON.stringify(post())).not.toMatch(/curl|1\.0\.77|install\.sh/);
  });
  it("while it runs: the row says Updating…, shows the target and the last lines with Cancel update, and every other button waits", async () => {
    run = RUN({ lines: ["Downloading grok 1.0.77", "unpacking"] });
    await mount();
    expect(text(card("grok").querySelector(".s-auth-state"))).toBe("Updating…");
    expect(text(card("grok").querySelector(".s-account-install-run"))).toContain("Updating Grok to 1.0.77");
    expect(text(card("grok").querySelector(".s-account-install-output"))).toBe("Downloading grok 1.0.77 unpacking");
    expect(disabled(updateBtn("grok"))).toBe(true);
    expect(disabled(updateBtn("opencode"))).toBe(true);                       // one window: a second update waits
    const cancel = card("grok").querySelectorAll("button").find((x: any) => x.textContent.trim() === "Cancel update");
    expect(cancel).toBeTruthy();
    fire(cancel, "click"); await settle(6);
    expect(post()).toEqual([{ method: "POST", url: "/ui/host-install/cancel", body: {} }]);
  });
  it("success: the version before and after (the binary probe's), with no Connect hand-off; Dismiss clears it", async () => {
    run = RUN({ phase: "ok", endedAt: 2, verified: true, version: "1.0.77", reached: true, signIn: false });
    await mount();
    expect(text(card("grok").querySelector(".s-account-install-run"))).toContain("Grok was updated from 1.0.70 to 1.0.77.");
    const dismiss = card("grok").querySelectorAll("button").find((x: any) => x.textContent.trim() === "Dismiss");
    fire(dismiss, "click"); await settle(6);
    expect(card("grok").querySelector(".s-account-install-run")).toBeNull();
  });
  it("exit code 0 but not at the audited version: a warning that names the installed and the audited version — not a success", async () => {
    run = RUN({ phase: "ok", endedAt: 2, verified: true, version: "1.0.70", reached: false, lines: ["already latest"] });
    await mount();
    const box = card("grok").querySelector(".s-account-install-run");
    expect(text(box)).toContain("Warning: the Grok installer finished (exit code 0), but the installed version is 1.0.70 and the audited version is 1.0.77");
    expect(text(box)).not.toContain("was updated");
    expect(box.querySelector(".signin-warn")).not.toBeNull();
    expect(box.querySelector(".signin-ok")).toBeNull();
    expect(text(card("grok").querySelector(".s-account-install-output"))).toContain("already latest");
  });
  it("a version that could not be read afterwards is a warning too (not known whether it reached the audited version)", async () => {
    run = RUN({ phase: "ok", endedAt: 2, verified: true, version: null, reached: null });
    await mount();
    const box = card("grok").querySelector(".s-account-install-run");
    expect(text(box)).toContain("could not be read afterwards");
    expect(text(box)).toContain("1.0.77");
    expect(box.querySelector(".signin-warn")).not.toBeNull();
  });
  it("failure: the exit code and the last lines; cancelled and timed out are their own words", async () => {
    run = RUN({ phase: "failed", endedAt: 2, exitCode: 22, lines: ["curl: (22) The requested URL returned error: 404"] });
    await mount();
    expect(text(card("grok").querySelector(".s-account-install-run"))).toContain("The Grok update exited with code 22.");
    expect(text(card("grok").querySelector(".s-account-install-output"))).toContain("404");
    expect(text(updateBtn("grok"))).toBe("Update to 1.0.77");                  // still behind: try again
    for (const [phase, words] of [["cancelled", "update was cancelled"], ["timeout", "update took too long"]] as const) {
      await p.unmount(); HI.hostInstallStore.set({ loaded: false, run: null, dismissed: [], starting: null });
      run = RUN({ phase, endedAt: 2 });
      await mount();
      expect(text(card("grok").querySelector(".s-account-install-run"))).toContain(words);
    }
  });
  it("a refusal is the server's code in words, and the page reads the run again", async () => {
    postAnswer = () => ({ status: 409, body: { error: "up_to_date" } });
    await mount();
    fire(updateBtn("grok"), "click"); await settle(8);
    expect(post()).toHaveLength(1);
    expect(reqs.filter(r => r.method === "GET" && r.url === "/ui/host-install").length).toBeGreaterThanOrEqual(2);
    expect(HI.hostInstallStore.get().starting).toBeNull();
  });
});

describe("who sees it, and in which words", () => {
  it("the public link's page shows neither the line nor the button", async () => {
    document.body.setAttribute("data-public-link", "1");
    try { await mount(); expect(updateBtn("grok")).toBeUndefined(); expect(line("grok")).toBeNull(); }
    finally { document.body.removeAttribute("data-public-link"); }
  });
  it("the words exist in both languages: no raw key", async () => {
    for (const lang of ["en", "zh-TW"]) {
      i18n.setLang(lang, { store: false });
      for (const key of ["update", "updating", "cancelUpdate", "verCurrent", "verBehind", "verSelf", "verNewer", "verUnknown", "runningUpdate", "updated", "updatedNoFrom", "updatedWarn", "updatedNoVersion",
        "failedUpdate", "failedUpdateCode", "cancelledUpdate", "timeoutUpdate", "err_not_installed", "err_up_to_date", "err_version_unreadable", "cardLabelUpdate"]) {
        const s = HI.hostInstallText(key, "grok", "1.0.70", "1.0.77");
        expect(s, `${lang}:${key}`).not.toBe(`hostinstall.${key}`);
        if (lang === "zh-TW") expect(s, `${lang}:${key}`).toMatch(/[一-鿿]/);
      }
    }
    i18n.setLang("zh-TW", { store: false });
    await mount();
    expect(text(updateBtn("grok"))).toBe("更新到 1.0.77");
  });
});

// AGEND-153 (the maintainer's decision on #3539): Antigravity's Update is the one named exception — it goes to the vendor's LATEST release, which AgEnD has not audited, and says so on the button.
describe("AGEND-153: the named exception (Antigravity — update to the latest, not audited)", () => {
  const AGY = (state: string, installed: string) => ({ backend: "antigravity", profiles: true, installed: true, fleetDefault: null, agents: [], rows: [hostRow("antigravity", "usable", { signIn: true, version: installed, cliUpdate: upd(state, installed, "1.5.3", { button: true, latest: true }) })] });
  const LABEL = "Update to latest (not audited by AgEnD)";
  const AGY_RUN = (over: Record<string, unknown> = {}) => RUN({ backend: "antigravity", fromVersion: "1.5.3", targetVersion: null, latest: true, ...over });
  it.each([["behind", "1.3.5"], ["current", "1.5.3"], ["newer", "1.5.9"]])("%s (%s): the button is there and says 'latest, not audited'; the line says the version AgEnD audited and that the update is not audited", async (state, installed) => {
    view = { clis: [AGY(state, installed)] };
    await mount();
    expect(text(updateBtn("antigravity"))).toBe(LABEL);
    expect(text(line("antigravity"))).toContain(`${installed} is installed`);
    expect(text(line("antigravity"))).toContain("1.5.3");
    expect(text(line("antigravity"))).toMatch(/not audited/i);
    expect(line("antigravity").getAttribute("data-latest")).toBe("1");
    expect(line("antigravity").getAttribute("data-via")).toBe("dashboard");
  });
  it("another CLI's button is the audited release as before, and says nothing about 'latest'", async () => {
    await mount();
    expect(text(updateBtn("grok"))).toBe("Update to 1.0.77");
    expect(line("grok").getAttribute("data-latest")).toBe("0");
    expect(text(line("grok"))).not.toContain("NOT audited");
  });
  it("pressing it posts the CLI's id and the explicit `acceptLatestUnaudited` to /ui/host-update, nothing else — no version, no command (AGEND-154: the server refuses the request without it)", async () => {
    view = { clis: [AGY("current", "1.5.3")] };
    postAnswer = () => ({ body: { install: AGY_RUN() } });
    await mount();
    fire(updateBtn("antigravity"), "click"); await settle(8);
    expect(post()).toEqual([{ method: "POST", url: "/ui/host-update", body: { backend: "antigravity", acceptLatestUnaudited: true } }]);
    expect(JSON.stringify(post())).not.toMatch(/agy|1\.5|\.exe/);
  });
  it("AGEND-154: an audited (pinned) update — Grok — posts `{ backend }` alone, never the acknowledgement", async () => {
    postAnswer = () => ({ body: { install: RUN() } });
    await mount();
    fire(updateBtn("grok"), "click"); await settle(8);
    expect(post()).toEqual([{ method: "POST", url: "/ui/host-update", body: { backend: "grok" } }]);
  });
  it("while it runs: it says 'the latest release, not audited by AgEnD' (and no audited target)", async () => {
    view = { clis: [AGY("current", "1.5.3")] };
    run = AGY_RUN({ lines: ["checking for updates"] });
    await mount();
    expect(text(card("antigravity").querySelector(".s-account-install-run"))).toContain("Updating Antigravity to the latest release, not audited by AgEnD");
    expect(text(card("antigravity").querySelector(".s-account-install-run"))).not.toContain("to ?");
  });
  it.each([
    ["moved on", { version: "1.6.0" }, "Antigravity was updated from 1.5.3 to 1.6.0, the latest release the vendor serves (not audited by AgEnD).", "signin-ok"],
    ["already the newest", { version: "1.5.3" }, "Antigravity is already at 1.5.3, the latest release the vendor serves (not audited by AgEnD).", "signin-ok"],
    ["version unreadable after", { version: null }, "could not be read afterwards", "signin-warn"],
  ])("success, %s: the version before and after, never the 'did not reach the audited version' warning", async (_name, over, words, cls) => {
    view = { clis: [AGY("current", "1.5.3")] };
    run = AGY_RUN({ phase: "ok", endedAt: 2, verified: true, reached: null, ...over });
    await mount();
    const box = card("antigravity").querySelector(".s-account-install-run");
    expect(text(box)).toContain(words);
    expect(box.querySelector(`.${cls}`)).not.toBeNull();
    expect(text(box)).not.toContain("audited version is");
  });
  it("a failure is the exit code and the last lines, as for any update", async () => {
    view = { clis: [AGY("current", "1.5.3")] };
    run = AGY_RUN({ phase: "failed", endedAt: 2, exitCode: 1, lines: ["no network"] });
    await mount();
    expect(text(card("antigravity").querySelector(".s-account-install-run"))).toContain("The Antigravity update exited with code 1.");
  });
  it("in zh-TW the button is 更新到最新版（未經盤點）", async () => {
    view = { clis: [AGY("current", "1.5.3")] };
    i18n.setLang("zh-TW", { store: false });
    await mount();
    expect(text(updateBtn("antigravity"))).toBe("更新到最新版（未經盤點）");
    expect(text(line("antigravity"))).toContain("尚未稽核");
    expect(text(card("antigravity"))).not.toMatch(/hostinstall\./);
  });
  it("the public link's page shows neither", async () => {
    view = { clis: [AGY("current", "1.5.3")] };
    document.body.setAttribute("data-public-link", "1");
    try { await mount(); expect(updateBtn("antigravity")).toBeUndefined(); expect(line("antigravity")).toBeNull(); }
    finally { document.body.removeAttribute("data-public-link"); }
  });
});
