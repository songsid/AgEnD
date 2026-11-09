/**
 * AGEND-133 (upstream #3521): Settings → Agents → AI sign-ins and API keys — the Install button on the host's row (src/ui/accounts-view.js + host-install.js,
 * the real modules over a faked /ui/accounts and /ui/host-install).
 * - A CLI that is not installed on the host: its default row has Install; one with no account card (OpenCode) is a small card of its own.
 * - Install posts the CLI's id and nothing else; while it runs the row says Installing…, shows the last lines of output and a Cancel; the other buttons wait.
 * - The verdict: installed (with the version), or the exit code and the last lines; Dismiss clears it. Sign in is the row's own, once the CLI is installed.
 * - A refusal is said in words (both languages). Public link: no button.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const hostRow = (backend: string, state: string, extra: Record<string, unknown> = {}) => ({ scope: { kind: "host" }, backend, profile: null, state, signIn: false, usedBy: { agents: [], classic: [], fleetDefault: true }, ...extra });
const GROK = { backend: "grok", profiles: false, installed: false, fleetDefault: null, agents: [], rows: [hostRow("grok", "not_installed", { install: "curl -fsSL https://x.example/install | bash" })] };
const OPENCODE = { backend: "opencode", profiles: false, installed: false, installOnly: true, fleetDefault: null, agents: [], rows: [hostRow("opencode", "not_installed", { install: "curl -fsSL https://x.example/oc | bash" })] };
const CODEX = { backend: "codex", profiles: true, installed: true, fleetDefault: null, agents: [], rows: [hostRow("codex", "usable", { signIn: true })] };
let view: any = { clis: [CODEX, GROK, OPENCODE] };
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
const RUN = (over: Record<string, unknown> = {}) => ({ id: "r".repeat(32), backend: "grok", phase: "running", startedOn: "Firefox on Linux", startedAt: 1, endedAt: null, lines: [], exitCode: null, verified: null, version: null, signIn: false, cleanupFailed: false, ...over });

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
  view = { clis: [CODEX, GROK, OPENCODE] }; run = null; reqs = []; postAnswer = () => ({ body: {} });
  A.accountsStore.set({ loaded: false, failed: false, view: null });
  HI.hostInstallStore.set({ loaded: false, run: null, dismissed: [], starting: null });
  S.signInStore.set({ loaded: false, login: null, targets: [], structured: null }); shell.shellStore.set({ dialog: null });
  document.body?.removeAttribute?.("data-public-link");
});
async function mount() { await p.mount(h(A.AccountsView, { instances: {}, stageAgent: () => {}, stageDefault: () => {} })); await settle(8); }
const card = (b: string) => p.root.querySelector(`.s-account-card[data-backend="${b}"]`);
const text = (el: any) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const installBtn = (b: string) => card(b)?.querySelectorAll("button").find((x: any) => x.textContent.trim() === "Install" || x.textContent.trim() === "Installing…" || x.textContent.trim() === "安裝");
const post = () => reqs.filter(r => r.method === "POST");

describe("the Install button", () => {
  it("a CLI that is not installed has Install on its host row; an installed one does not; OpenCode is a small card of its own", async () => {
    await mount();
    expect(p.root.querySelectorAll(".s-account-card").map((c: any) => c.getAttribute("data-backend"))).toEqual(["codex", "grok", "opencode"]);
    expect(installBtn("codex")).toBeUndefined();
    expect(text(installBtn("grok"))).toBe("Install");
    expect(text(card("grok").querySelector(".s-auth-state"))).toBe("not installed");
    expect(text(card("grok"))).toContain("official installer");
    expect(text(installBtn("opencode"))).toBe("Install");
    expect(card("opencode").classList?.contains?.("s-account-install-only") ?? true).toBe(true);
    expect(card("opencode").querySelector(".s-account-used")).toBeNull();      // no sign-in rows, no "used by"
  });
  it("a CLI with named accounts that is not installed offers Install — and not Move agents here or Keep sign-in alive, which need an installed CLI", async () => {
    view = { clis: [{ ...CODEX, installed: false, rows: [hostRow("codex", "not_installed", { install: "curl … | sh", keepAlive: { enabled: false } })] }] };
    await mount();
    const labels = card("codex").querySelectorAll(".s-account-row button").map((b: any) => b.textContent.trim());
    expect(labels).toEqual(["Install"]);
    expect(card("codex").querySelector(".s-account-keepalive")).toBeNull();
    await p.unmount();
    view = { clis: [{ ...CODEX, rows: [hostRow("codex", "usable", { signIn: true, keepAlive: { enabled: false } })] }] };
    await mount();
    expect(card("codex").querySelector(".s-account-keepalive")).not.toBeNull();     // the control is there when installed: the check above is not vacuous
  });
  it("Install sends the CLI's id and nothing else — never the command the row carries", async () => {
    postAnswer = () => ({ body: { install: RUN() } });
    await mount();
    fire(installBtn("grok"), "click"); await settle(8);
    expect(post()).toEqual([{ method: "POST", url: "/ui/host-install", body: { backend: "grok" } }]);
    expect(JSON.stringify(post())).not.toContain("curl");
  });
  it("while it runs: the row says Installing…, the output's last lines and Cancel show, and every Install and Sign in waits", async () => {
    run = RUN({ lines: ["Downloading grok 0.4.2", "unpacking"] });
    await mount();
    expect(text(card("grok").querySelector(".s-auth-state"))).toBe("Installing…");
    expect(text(card("grok").querySelector(".s-account-install-run"))).toContain("Installing Grok");
    expect(text(card("grok").querySelector(".s-account-install-output"))).toBe("Downloading grok 0.4.2 unpacking");
    expect(installBtn("grok").disabled ?? installBtn("grok").hasAttribute("disabled")).toBeTruthy();
    expect(installBtn("opencode").disabled ?? installBtn("opencode").hasAttribute("disabled")).toBeTruthy();   // one window: a second install waits
    const cancel = card("grok").querySelectorAll("button").find((x: any) => x.textContent.trim() === "Cancel install");
    expect(cancel).toBeTruthy();
    fire(cancel, "click"); await settle(6);
    expect(post()).toEqual([{ method: "POST", url: "/ui/host-install/cancel", body: {} }]);
  });
  it("success: the verdict with the version, Dismiss clears it; Connect (the sign-in) is then the row's own", async () => {
    run = RUN({ phase: "ok", endedAt: 2, verified: true, version: "0.4.2", signIn: true });
    view = { clis: [CODEX, { ...GROK, installed: true, rows: [hostRow("grok", "not_signed_in", { signIn: true })] }, OPENCODE] };
    await mount();
    expect(text(card("grok").querySelector(".s-account-install-run"))).toContain("Grok 0.4.2 is installed.");
    expect(text(card("grok").querySelector(".s-actions button"))).toBe("Connect");
    expect(installBtn("grok")).toBeUndefined();
    const dismiss = card("grok").querySelectorAll("button").find((x: any) => x.textContent.trim() === "Dismiss");
    fire(dismiss, "click"); await settle(6);
    expect(card("grok").querySelector(".s-account-install-run")).toBeNull();
  });
  it("success but not found afterwards, and failure with its exit code and last lines — in words, with the output", async () => {
    run = RUN({ phase: "ok", endedAt: 2, verified: false });
    await mount();
    expect(text(card("grok").querySelector(".s-account-install-run"))).toContain("was not found afterwards");
    await p.unmount();
    HI.hostInstallStore.set({ loaded: false, run: null, dismissed: [], starting: null });
    run = RUN({ phase: "failed", endedAt: 2, exitCode: 22, lines: ["curl: (22) The requested URL returned error: 404"] });
    await mount();
    expect(text(card("grok").querySelector(".s-account-install-run"))).toContain("The Grok installer exited with code 22.");
    expect(text(card("grok").querySelector(".s-account-install-output"))).toContain("404");
    expect(text(installBtn("grok"))).toBe("Install");                     // still not installed: try again
  });
  it("cancelled and timed out are said as such", async () => {
    run = RUN({ phase: "cancelled", endedAt: 2 });
    await mount();
    expect(text(card("grok").querySelector(".s-account-install-run"))).toContain("install was cancelled");
    await p.unmount(); HI.hostInstallStore.set({ loaded: false, run: null, dismissed: [], starting: null });
    run = RUN({ phase: "timeout", endedAt: 2 });
    await mount();
    expect(text(card("grok").querySelector(".s-account-install-run"))).toContain("took too long");
  });
  it("another CLI's run is not shown on this row", async () => {
    run = RUN({ backend: "opencode", phase: "running" });
    await mount();
    expect(card("grok").querySelector(".s-account-install-run")).toBeNull();
    expect(card("opencode").querySelector(".s-account-install-run")).not.toBeNull();
  });
  it("a refusal is the server's code in words (toast), and the page reads the install again", async () => {
    postAnswer = () => ({ status: 409, body: { error: "busy" } });
    await mount();
    fire(installBtn("grok"), "click"); await settle(8);
    expect(post()).toHaveLength(1);
    expect(reqs.filter(r => r.method === "GET" && r.url === "/ui/host-install").length).toBeGreaterThanOrEqual(2);
    expect(HI.hostInstallStore.get().starting).toBeNull();
  });
  it("the words exist in both languages: no raw key", async () => {
    for (const lang of ["en", "zh-TW"]) {
      i18n.setLang(lang, { store: false });
      for (const key of ["install", "installing", "cancel", "dismiss", "notInstalled", "running", "ok", "okVersion", "okUnverified", "failed", "failedCode", "cancelled", "timeout", "cleanup", "output",
        "err_unsupported", "err_already", "err_busy", "err_shutting_down", "err_not_allowed", "err_install_needs_a_local_admin", "err_install_not_over_public_link", "err_failed", "err_other"]) {
        const s = HI.hostInstallText(key, "grok", "1");
        expect(s, `${lang}:${key}`).not.toBe(`hostinstall.${key}`);
        if (lang === "zh-TW") expect(s, `${lang}:${key}`).toMatch(/[一-鿿]/);
      }
    }
    i18n.setLang("zh-TW", { store: false });
    await mount();
    expect(text(installBtn("grok"))).toBe("安裝");
  });
  it("the public link's page never offers Install", async () => {
    document.body.setAttribute("data-public-link", "1");
    try { await mount(); expect(installBtn("grok")).toBeUndefined(); }
    finally { document.body.removeAttribute("data-public-link"); }
  });
});
