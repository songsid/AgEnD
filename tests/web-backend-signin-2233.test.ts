/**
 * #2233: the dashboard's Sign in — the dialog (check → confirm → start → the starter's view, or a refusal in the
 * server's words), the line every admin page shows while a sign-in runs, Settings' list, and Needs you's button.
 * The real modules on the mini DOM with a recording fetch; nothing reaches a server.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

type Req = { method: string; url: string; body: any };
let reqs: Req[] = [];
let answer: (r: Req) => unknown = () => ({});
const fetchFake = async (url: string, init: any = {}) => {
  const r: Req = { method: init.method || "GET", url, body: init.body ? JSON.parse(init.body) : null };
  reqs.push(r);
  const body = await answer(r);
  const status = body && typeof (body as any).__status === "number" ? (body as any).__status : 200;
  return { ok: status < 300, status, json: async () => body };
};

const CODE = "ABCDEFGHJKMNPQRSTVWX";
const CONFIRM = { id: "c".repeat(32), backend: "claude-code", tokenPresent: false, logoutFirst: null, publicLink: false, deviceAuth: false, expiresAt: 0 };
const TERMINAL = { id: "r1", backend: "claude-code", phase: "running", ok: null, startedOn: "Firefox on Linux", startedAt: 1, endedAt: null, mine: true, lines: [],
  hint: null, terminal: { url: "http://localhost:40001/t/abab/", ttlMinutes: 10, command: "claude auth login", loopback: true, public: false }, accessCode: CODE };

let p: AppPage;
let S: any, app: any, shell: any, N: any, nav: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/settings/agents", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  (globalThis as any).navigator.clipboard = { writeText: async () => {} };
  app = await import("/assets/app-store.js");
  shell = await import("/assets/app-shell.js");
  nav = await import("/assets/app-nav.js");
  S = await import("/ui/js/backend-signin.js");
  N = await import("/ui/js/panel-needs.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount();
  reqs = []; answer = () => ({});
  S.signInStore.set({ loaded: false, login: null, targets: [] });
  shell.shellStore.set({ dialog: null });
});
const text = () => p.root.textContent.replace(/\s+/g, " ");
const btn = (label: string) => p.root.querySelectorAll("button, a").find((b: any) => b.textContent.trim() === label);
const dialog = async (props: Record<string, unknown>) => { await p.mount(h(S.SignInDialog, props)); await settle(6); };

describe("#2233 the Sign in dialog", () => {
  it("terminal flow: the pre-check's question, then the starter's terminal link and access code; the start carries only the confirm id", async () => {
    answer = r => r.url === "/ui/backend-login/check" ? { confirm: CONFIRM } : r.url === "/ui/backend-login/start" ? { login: TERMINAL } : { login: TERMINAL, targets: [] };
    await dialog({ backend: "claude-code" });
    expect(reqs[0]).toEqual({ method: "POST", url: "/ui/backend-login/check", body: { backend: "claude-code" } });
    expect(text()).toContain("opens it as a terminal in your browser");
    expect(btn("Use a temporary public link"), "not offered: no button").toBeUndefined();
    fire(btn("Sign in"), "click"); await settle(6);
    expect(reqs.find(r => r.url === "/ui/backend-login/start")!.body).toEqual({ confirm: CONFIRM.id });
    const open = p.root.querySelectorAll("a").find((a: any) => a.textContent.includes("Open the sign-in terminal"));
    expect([open.getAttribute("href"), open.getAttribute("target"), open.getAttribute("rel")]).toEqual([TERMINAL.terminal.url, "_blank", "noopener noreferrer"]);
    expect(text()).toContain(CODE);
    expect(text()).toContain("It works once, for 10 minutes");
    expect(text(), "on the machine itself: no loopback note").not.toContain("listens on the machine's own address only");
    await p.unmount();
    const away = page({ url: "http://192.168.1.20:19281/settings/agents" });
    try {
      S.signInStore.set({ login: TERMINAL });
      await away.mount(h(S.SignInDialog, { backend: "claude-code", resume: true })); await settle(6);
      expect(away.root.textContent, "from another machine: the terminal listens on loopback only").toContain("listens on the machine's own address only");
      await away.unmount();
    } finally { away.restore(); }
  });

  it("still signed in, logout first, a public link offered: said, and the public button asks for the tunnel", async () => {
    answer = r => r.url === "/ui/backend-login/check" ? { confirm: { ...CONFIRM, backend: "kiro-cli", tokenPresent: true, logoutFirst: "kiro-cli logout", publicLink: true } }
      : r.url === "/ui/backend-login/start" ? { login: { ...TERMINAL, backend: "kiro-cli", terminal: { ...TERMINAL.terminal, public: true } } } : {};
    await dialog({ backend: "kiro-cli" });
    expect(text()).toContain("signing in again replaces that login");
    expect(text()).toContain("It signs out first (kiro-cli logout)");
    fire(btn("Use a temporary public link"), "click"); await settle(6);
    expect(reqs.find(r => r.url === "/ui/backend-login/start")!.body).toEqual({ confirm: CONFIRM.id, tunnel: true });
    expect(text()).toContain("anyone with the link and the code could use it");
  });

  it("device flow: the provider's link only on its own host; any other URL is text with Copy, never a link", async () => {
    const device = (url: string, linkable: boolean) => ({ ...TERMINAL, backend: "codex", terminal: null, accessCode: null, hint: { url, code: "ABCD-1234", linkable } });
    S.signInStore.set({ login: device("https://auth.openai.com/codex/device", true) });
    await dialog({ backend: "codex", resume: true });
    expect(p.root.querySelectorAll("a").map((a: any) => a.getAttribute("href"))).toContain("https://auth.openai.com/codex/device");
    expect(text()).toContain("ABCD-1234");
    await p.unmount();
    S.signInStore.set({ login: device("https://evil.example/device", false) });
    await dialog({ backend: "codex", resume: true });
    expect(p.root.querySelectorAll("a").map((a: any) => a.getAttribute("href"))).not.toContain("https://evil.example/device");
    expect(text()).toContain("https://evil.example/device");
  });

  it("a refusal is the server's words; an expired confirm says to start again", async () => {
    answer = r => r.url === "/ui/backend-login/check" ? { message: "codex is not installed on this machine." } : {};
    await dialog({ backend: "codex" });
    expect(text()).toContain("codex is not installed on this machine.");
    expect(reqs.some(r => r.url === "/ui/backend-login/start")).toBe(false);
    await p.unmount();
    answer = r => r.url === "/ui/backend-login/check" ? { confirm: CONFIRM } : r.url === "/ui/backend-login/start" ? { __status: 409, error: "confirm_expired" } : {};
    await dialog({ backend: "claude-code" });
    fire(btn("Sign in"), "click"); await settle(6);
    expect(text()).toContain("That took too long");
  });

  it("someone else's sign-in: who and where, no code or link, and Cancel sign-in posts the cancel", async () => {
    S.signInStore.set({ login: { id: "r1", backend: "claude-code", phase: "running", ok: null, startedOn: "Safari on iPhone", startedAt: 1, endedAt: null, mine: false } });
    answer = () => ({ message: "🛑 Login session for claude-code cancelled." });
    await dialog({ backend: "claude-code", resume: true });
    expect(text()).toContain("Signing in to claude-code (started on Safari on iPhone)");
    expect(text()).not.toContain(CODE);
    fire(btn("Cancel sign-in"), "click"); await settle(6);
    expect(reqs.find(r => r.url === "/ui/backend-login/cancel")).toEqual({ method: "POST", url: "/ui/backend-login/cancel", body: {} });
  });

  it("the end: signed in, with the recovery lines", async () => {
    S.signInStore.set({ login: { ...TERMINAL, phase: "ended", ok: true, terminal: null, accessCode: null, lines: ["✅ claude-code login completed.", "Restarted: agent-a"] } });
    await dialog({ backend: "claude-code", resume: true });
    expect(text()).toContain("claude-code is signed in.");
    expect(text()).toContain("Restarted: agent-a");
    expect(btn("Cancel sign-in")).toBeUndefined();
  });
});

describe("#2262 review", () => {
  it("over the public link: a refusal is said plainly (where to sign in instead), and Needs you offers no Sign in", async () => {
    answer = r => r.url === "/ui/backend-login/check" ? { __status: 403, error: "sign_in_not_over_public_link" } : {};
    await dialog({ backend: "codex" });
    expect(text()).toContain("Signing in is not available over the public link");
    await p.unmount();
    p.document.body.setAttribute("data-public-link", "1");
    try {
      app.appStore.set({ instances: [], needs: [{ id: "auth:a:1", type: "instance", instance: "a", reason: "auth_paused", detail: "", since: Date.now(), signIn: { backend: "codex" } }] });
      await p.mount(h(N.NeedsPanel, { route: { panel: "needs" }, navKey: "needs:|1|en" })); await settle(6);
      expect(p.root.querySelectorAll(".n-item button").map((b: any) => b.textContent.trim())).toEqual([]);
      expect(S.signInOffered()).toBe(false);
    } finally { p.document.body.removeAttribute("data-public-link"); }
  });

  it("over the public link Settings' sign-in list neither reads /ui/backend-login (the link does not serve it) nor shows", async () => {
    await p.unmount();
    S.signInStore.set({ loaded: true, login: null, targets: [{ backend: "codex", state: "not_signed_in", signIn: true }] });
    reqs = [];
    p.document.body.setAttribute("data-public-link", "1");
    try {
      await p.mount(h(S.SignInList, {})); await settle(6);
      expect([reqs.filter(r => r.url.startsWith("/ui/backend-login")), p.root.querySelectorAll(".signin-list").length]).toEqual([[], 0]);
    } finally { p.document.body.removeAttribute("data-public-link"); }
    await p.unmount();
    answer = r => r.url === "/ui/backend-login" ? { login: null, targets: [{ backend: "codex", state: "not_signed_in", signIn: true }] } : {};
    await p.mount(h(S.SignInList, {})); await settle(6);                  // control: on the dashboard itself it reads and shows
    expect([reqs.some(r => r.url === "/ui/backend-login"), p.root.querySelectorAll(".signin-list").length]).toEqual([true, 1]);
  });

  it("an event that lands while a read is on its way is not lost: one more read follows, and its answer is what shows", async () => {
    let release!: (v: unknown) => void, reads = 0;
    answer = () => { reads++; return reads === 1 ? new Promise(r => { release = r; }) : { login: { ...TERMINAL, mine: false }, targets: [] }; };
    const first = S.refreshSignIn();
    S.refreshSignIn();                                        // the event, while the first read is on its way
    release({ login: null, targets: [] });                    // the first read's (older) answer
    await first; await settle(6);
    expect(reads).toBe(2);
    expect(S.signInStore.get().login).toMatchObject({ phase: "running", startedOn: "Firefox on Linux" });
  });
});

describe("#2233 where Sign in is offered", () => {
  it("the line every admin page shows: only while a sign-in runs, and Open shows it", async () => {
    await p.mount(h(S.SignInLine, {})); await settle(4);
    expect(text()).toBe("");
    S.signInStore.set({ login: { ...TERMINAL, mine: false } }); await settle(4);
    expect(text()).toContain("Signing in to claude-code (started on Firefox on Linux)");
    fire(btn("Open"), "click"); await settle(2);
    expect(shell.shellStore.get().dialog.props).toEqual({ backend: "claude-code", resume: true });
  });

  it("Settings' list: each login with its state; Sign in where the dashboard can, the host's command where it cannot; off while one runs", async () => {
    answer = () => ({ login: null, targets: [
      { backend: "claude-code", state: "usable", signIn: true },
      { backend: "codex", state: "not_signed_in", signIn: true },
      { backend: "antigravity", state: "not_signed_in", signIn: false, hostCommand: "agy" },
      { backend: "grok", state: "not_installed", signIn: false, install: "curl -fsSL https://x.ai/cli/install.sh | bash" },
      { backend: "kiro-cli", state: "too_old", signIn: false, update: "curl -fsSL https://cli.kiro.dev/install | bash" },
      { backend: "claude-code", profile: "work", state: "not_signed_in", signIn: true },
    ] });
    await p.mount(h(S.SignInList, {})); await settle(6);
    const rows = p.root.querySelectorAll(".s-row").map((r: any) => r.querySelectorAll("span").map((s: any) => s.textContent.trim()).filter(Boolean).join(" "));
    expect(rows).toEqual([
      "claude-code signed in Sign in again", "codex not signed in Sign in", "antigravity not signed in Sign in on the machine: agy",
      "grok not installed Install on the machine: curl -fsSL https://x.ai/cli/install.sh | bash",
      "kiro-cli too old Update on the machine: curl -fsSL https://cli.kiro.dev/install | bash", "claude-code · profile work not signed in Sign in"]);
    fire(p.root.querySelectorAll(".s-row")[5].querySelector("button"), "click"); await settle(2);
    expect(shell.shellStore.get().dialog.props).toEqual({ backend: "claude-code", profile: "work" });
    S.signInStore.set({ login: { ...TERMINAL, mine: false } }); await settle(4);
    expect(p.root.querySelectorAll(".s-row button").every((b: any) => b.disabled)).toBe(true);
  });

  it("Needs you: a paused-for-sign-in item the dashboard can sign in has Sign in (its backend and profile); one it cannot has none", async () => {
    app.appStore.set({ instances: [], needs: [
      { id: "auth:a:1", type: "instance", instance: "a", reason: "auth_paused", detail: "", since: Date.now(), signIn: { backend: "claude-code", profile: "work" } },
      { id: "auth:b:1", type: "instance", instance: "b", reason: "auth_paused", detail: "", since: Date.now() },
    ] });
    await p.mount(h(N.NeedsPanel, { route: { panel: "needs" }, navKey: "needs:|1|en" })); await settle(6);
    const items = p.root.querySelectorAll(".n-item");
    expect(items.map((i: any) => i.querySelectorAll("button").map((b: any) => b.textContent.trim()))).toEqual([["Sign in"], []]);
    fire(items[0].querySelector("button"), "click"); await settle(2);
    expect(shell.shellStore.get().dialog.props).toEqual({ backend: "claude-code", profile: "work" });
  });
});
