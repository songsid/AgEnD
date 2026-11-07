/**
 * #3292: Settings → Accounts → Keep sign-in alive (src/ui/accounts-keepalive.js, hooked into accounts-view.js's Row) —
 * the real modules over a faked GET /ui/accounts. A line under each Claude Code / Codex host row that has the part:
 * the switch, what it does (no model request), Claude Code's fallback once on, the sign-in's end date (a warning in its
 * last ten days), the plan and the last check; a paired computer's rows and rows without the part draw none. Switching
 * POSTs /ui/accounts/keep-alive and reads the view again fresh. Both languages; its own stylesheet linked once.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const DAY = 86_400_000;
const soon = new Date(Date.now() + 3 * DAY).toISOString(), later = new Date(Date.now() + 30 * DAY).toISOString();
const used = { agents: [], classic: [], fleetDefault: false };
const VIEW = () => ({ clis: [
  { backend: "claude-code", profiles: true, installed: true, fleetDefault: null, agents: [],
    rows: [
      { scope: { kind: "host" }, backend: "claude-code", profile: null, state: "usable", signIn: true, usedBy: used, keepAlive: { enabled: false, fallback: false, endsAt: later } },
      { scope: { kind: "host" }, backend: "claude-code", profile: "work", state: "usable", signIn: true, usedBy: used,
        keepAlive: { enabled: true, fallback: false, endsAt: soon, lastAt: new Date().toISOString(), lastOutcome: "not_renewed" } },
      { scope: { kind: "machine", id: "m1", name: "Desk PC", online: true }, backend: "claude-code", profile: "home", state: "usable", signIn: false, usedBy: used, keepAlive: { enabled: true } },
    ] },
  { backend: "codex", profiles: true, installed: true, fleetDefault: null, agents: [],
    rows: [
      { scope: { kind: "host" }, backend: "codex", profile: null, state: "usable", signIn: true, usedBy: used, keepAlive: { enabled: true, planType: "free", lastAt: new Date().toISOString(), lastOutcome: "refreshed" } },
      { scope: { kind: "host" }, backend: "codex", profile: "team2", state: "usable", signIn: true, usedBy: used },
    ] },
  { backend: "kiro-cli", profiles: true, installed: true, fleetDefault: null, agents: [],
    rows: [{ scope: { kind: "host" }, backend: "kiro-cli", profile: null, state: "usable", signIn: true, usedBy: used }] },
] });
let view: any, posts: Array<{ url: string; body: any }>, reads = 0, postOk = true;
const fetchFake = async (url: string, init?: { method?: string; body?: string }) => {
  if (init?.method === "POST") { posts.push({ url: String(url), body: JSON.parse(init.body!) }); return { ok: postOk, status: postOk ? 200 : 500, json: async () => (postOk ? {} : { error: "write" }) }; }
  if (String(url).startsWith("/ui/accounts")) reads++;
  return { ok: true, status: 200, json: async () => (String(url).startsWith("/ui/accounts") ? view : { login: null, targets: [] }) };
};
let p: AppPage, A: any, S: any, i18n: any, shell: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19282/settings/agents", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  shell = await import("/assets/app-shell.js"); i18n = await import("/assets/app-i18n.js");
  S = await import("/ui/js/backend-signin.js");
  A = await import("/ui/js/accounts-view.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount(); i18n.setLang("en", { store: false }); view = VIEW(); posts = []; reads = 0; postOk = true;
  A.accountsStore.set({ loaded: false, failed: false, view: null });
  S.signInStore.set({ loaded: false, login: null, targets: [], structured: null }); shell.shellStore.set({ dialog: null });
});
async function mount() { await p.mount(h(A.AccountsView, { instances: {}, stageAgent: () => {}, stageDefault: () => {} })); await settle(8); }
const card = (backend: string) => p.root.querySelector(`.s-account-card[data-backend="${backend}"]`);
const rowOf = (backend: string, acct: string) => card(backend).querySelectorAll(".s-account-row").find((r: any) => r.getAttribute("data-account") === acct);
const text = (el: any) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const ka = (backend: string, acct: string) => rowOf(backend, acct)?.querySelector(".s-account-keepalive") ?? null;

describe("Keep sign-in alive on the Accounts rows (#3292)", () => {
  it("drawn on host rows that carry it; never on a paired computer's row or a row without it", async () => {
    await mount();
    expect([ka("claude-code", "default"), ka("claude-code", "work"), ka("codex", "default")].every(Boolean)).toBe(true);
    expect([ka("claude-code", "home"), ka("codex", "team2"), ka("kiro-cli", "default")]).toEqual([null, null, null]);
  });
  it("says what it does, the end date (a warning in its last ten days), the plan and the last check", async () => {
    await mount();
    const off = ka("claude-code", "default"), on = ka("claude-code", "work"), cx = ka("codex", "default");
    expect(text(off.querySelector("label"))).toBe("Keep sign-in alive");
    expect(off.querySelector('input[type="checkbox"]').checked).toBe(false);
    expect(text(off.querySelector(".s-keepalive-hint"))).toContain("No model request");
    expect(off.querySelector(".s-keepalive-fallback")).toBeNull();                         // the fallback only once it is on
    expect(off.querySelector(".s-keepalive-ends").className).not.toContain("is-warn");
    expect(on.querySelector(".s-keepalive-ends").className).toContain("is-warn");
    expect(text(on.querySelector(".s-keepalive-ends"))).toContain("Renewing can't move this date");
    expect(text(on.querySelector(".s-keepalive-fallback"))).toContain("smallest model");
    expect(on.querySelector(".s-keepalive-last").className).toContain("is-bad");
    expect(text(on.querySelector(".s-keepalive-last"))).toMatch(/^Last check .+: not renewed$/);
    expect(text(cx.querySelector(".s-keepalive-hint"))).toContain("Codex's own refresh");
    expect([text(cx.querySelector(".s-keepalive-plan")), cx.querySelector(".s-keepalive-ends"), cx.querySelector(".s-keepalive-fallback")]).toEqual(["Plan: free", null, null]);
  });
  it("switching POSTs the setting (profile null for the default) and reads the view again", async () => {
    await mount();
    const before = reads;
    { const box = ka("claude-code", "default").querySelector('input[type="checkbox"]'); box.checked = true; fire(box, "change"); }
    await settle(8);
    expect(posts).toEqual([{ url: "/ui/accounts/keep-alive", body: { backend: "claude-code", profile: null, enabled: true, fallback: false } }]);
    expect(reads).toBeGreaterThan(before);
    { const box = ka("claude-code", "work").querySelector(".s-keepalive-fallback input"); box.checked = true; fire(box, "change"); }
    { const box = ka("codex", "default").querySelector('input[type="checkbox"]'); box.checked = false; fire(box, "change"); }
    await settle(8);
    expect(posts.slice(1)).toEqual([
      { url: "/ui/accounts/keep-alive", body: { backend: "claude-code", profile: "work", enabled: true, fallback: true } },
      { url: "/ui/accounts/keep-alive", body: { backend: "codex", profile: null, enabled: false } },
    ]);
  });
  it("a refused write reads nothing again", async () => {
    await mount();
    postOk = false;
    const before = reads;
    { const box = ka("codex", "default").querySelector('input[type="checkbox"]'); box.checked = false; fire(box, "change"); }
    await settle(8);
    expect(posts.length).toBe(1);
    expect(reads).toBe(before);
  });
  it("an answer after the row is gone (the page left) shows no toast and reads nothing again (#3313 review P3)", async () => {
    const T = await import("/assets/ui-toast.js");
    const K = await import("/ui/js/accounts-keepalive.js");
    const { useState } = await import("/assets/app-html.js");
    let hide: () => void = () => {}, saved = 0, release: (v: unknown) => void = () => {};
    (globalThis as any).fetch = (url: string, init?: { method?: string }) => init?.method === "POST" ? new Promise(r => { release = r; }) : fetchFake(url, init as never);
    const row = { backend: "codex", profile: null, scope: { kind: "host" }, keepAlive: { enabled: false } };
    function Host() { const [shown, set] = useState(true); hide = () => set(false); return h("div", {}, shown ? h(K.KeepAliveControl, { row, onSaved: () => { saved++; } }) : null, h(T.Toasts, {})); }
    await p.mount(h(Host, {})); await settle(4);
    const box = p.root.querySelector(".s-account-keepalive input"); box.checked = true; fire(box, "change"); await settle(2);
    const texts = () => [...p.root.querySelectorAll(".toast")].map((t: any) => t.textContent);
    const before = texts();
    hide(); await settle(2);
    release({ ok: true, status: 200, json: async () => ({}) }); await settle(6);
    expect(texts().filter(x => !before.includes(x))).toEqual([]);
    expect(saved).toBe(0);
    (globalThis as any).fetch = fetchFake;
  });
  it("Traditional Chinese, and its stylesheet linked once", async () => {
    i18n.setLang("zh-TW", { store: false });
    await mount();
    const on = ka("claude-code", "work");
    expect(text(on.querySelector("label"))).toBe("保持登入");
    expect(text(on.querySelector(".s-keepalive-last"))).toMatch(/：沒有續期$/);
    expect(text(on.querySelector(".s-keepalive-ends"))).toContain("續期無法延後這個日期");
    expect(p.document.querySelectorAll('link[data-accounts-keepalive-css="1"]').length).toBe(1);
  });
});
