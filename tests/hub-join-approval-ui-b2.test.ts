/** Mounted Hub page and queue lease; inert fetch, real Preact/shared ErrorState, no account or network. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let ui: any, hook: any, i18n: any, panel: any, clients: any;
const mounted: AppPage[] = [], ID = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
beforeAll(async () => { const p = page(); ui = await import("/ui/js/hub-company-join.js"); hook = await import("/ui/js/hub-join-approval.js"); i18n = await import("/assets/app-i18n.js"); panel = await import("/ui/js/panel-hub.js"); clients = await import("/ui/js/hub-client.js"); p.restore(); });
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } panel.resetHubSession(); clients.setHubClient(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const button = (p: AppPage, label: string) => [...p.root.querySelectorAll("button")].find((b: any) => b.textContent === label);
function queueTimers() {
  const timers: Array<() => void> = [], original = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any, ms: any, ...args: any[]) => ms >= 2000 && ms <= 6000 ? (timers.push(fn), 123 as any) : original(fn, ms, ...args));
  return timers;
}
async function rig(answer: (n: number) => any, lang = "en") {
  const p = page({ url: "https://hub.example.test/ui/hub?join=" + ID, storage: { agend_lang: lang } }); mounted.push(p); i18n.setLang(lang, { store: false });
  const deadline = Date.now() + 60_000, calls: any[] = []; let approvals = 0;
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: any = {}) => {
    calls.push({ path, init }); const result = path.includes("/approve") ? await answer(++approvals)
      : { ok: true, state: "pending", label: "My Fleet", fleetOrigin: "https://fleet.example.test", outerDeadline: deadline };
    return { ok: result.ok !== false, json: async () => result };
  }));
  await p.mount(h(ui.HubCompanyJoinPage, { session: { csrf: "owned-csrf", displayName: "Carol" } })); await settle(15);
  return { p, calls, posts: () => calls.filter(c => c.path.endsWith("/approve")) };
}
describe("B2 actual Hub approval page", () => {
  it("shows the queue and retries the same request and session after backpressure", async () => {
    const timers = queueTimers(), r = await rig(n => n === 1 ? { ok: false, code: "backpressure" } : { ok: true });
    fire(button(r.p, "Connect as Carol"), "click"); await settle(10);
    expect(r.p.root.textContent).toContain("Waiting in the queue"); expect(r.posts()).toHaveLength(1);
    timers.shift()!(); await settle(15); expect(r.posts()).toHaveLength(2);
    expect(r.p.root.textContent).not.toContain("Waiting in the queue");
    expect(r.posts().map(c => JSON.parse(c.init.body))).toEqual([{ requestId: ID }, { requestId: ID }]);
    expect(r.posts().every(c => c.init.headers["X-AgEnD-Hub-CSRF"] === "owned-csrf")).toBe(true);
  });
  it("after eight retries, Try again repeats approve instead of just rereading the request", async () => {
    const timers = queueTimers(), r = await rig(n => n <= 9 ? { ok: false, code: "backpressure" } : { ok: true });
    fire(button(r.p, "Connect as Carol"), "click"); await settle(5);
    for (let i = 0; i < 8; i++) { expect(timers).toHaveLength(1); timers.shift()!(); await settle(5); }
    expect(r.posts()).toHaveLength(9); expect(timers).toHaveLength(0); expect(button(r.p, "Try again")).toBeTruthy();
    fire(button(r.p, "Try again"), "click"); await settle(15); expect(r.posts()).toHaveLength(10);
    expect(r.posts().every(c => JSON.parse(c.init.body).requestId === ID)).toBe(true);
  });
  it("a semantic limit refusal never enters the queue", async () => {
    const timers = queueTimers(), r = await rig(() => ({ ok: false, code: "limit-reached" }));
    fire(button(r.p, "Connect as Carol"), "click"); await settle(15);
    expect(r.posts()).toHaveLength(1); expect(timers).toHaveLength(0); expect(r.p.root.textContent).toContain("Fleet limit is reached");
  });
  it.each([
    ["en", "code-scope", "You are outside the scope of this join code."],
    ["en", "code-ended", "This join code is no longer valid or has been used up."],
    ["zh-TW", "code-scope", "你不在這組加入碼允許的範圍。"],
    ["zh-TW", "code-ended", "加入碼已失效或已用完。"],
  ])("existing company session shows %s/%s feedback", async (lang, reason, message) => {
    const timers = queueTimers(), r = await rig(() => ({ ok: false, code: "denied", reason }), lang);
    fire(button(r.p, "Connect as Carol") || button(r.p, "以 Carol 的身分連接"), "click"); await settle(15);
    expect(r.p.root.textContent).toContain(message); expect(r.posts()).toHaveLength(1); expect(timers).toHaveLength(0);
  });
  it.each([
    ["en", "code-scope", "You are outside the scope of this join code."],
    ["en", "code-ended", "This join code is no longer valid or has been used up."],
    ["zh-TW", "code-scope", "你不在這組加入碼允許的範圍。"],
    ["zh-TW", "code-ended", "加入碼已失效或已用完。"],
  ])("company sign-in preserves %s/%s feedback into its Hub page", async (lang, reason, message) => {
    const p = page({ url: "https://hub.example.test/ui/hub?join=" + ID, storage: { agend_lang: lang } }); mounted.push(p); i18n.setLang(lang, { store: false });
    const deadline = Date.now() + 60_000;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      const r = path.includes("/approve") ? { ok: false, code: "denied", reason } : { ok: true, state: "pending", label: "My Fleet", outerDeadline: deadline };
      return { ok: r.ok !== false, json: async () => r };
    }));
    const signIn = vi.fn(async () => ({ ok: true, signedIn: true, csrf: "new-session", login: "carol", displayName: "Carol", features: [] }));
    clients.setHubClient({ session: async () => ({ ok: true, signedIn: false }), signIn, rooms: async () => ({ ok: true, rooms: [] }) }); panel.resetHubSession();
    await p.mount(h(panel.HubPanel, { route: { tab: "ask" } })); await settle(20);
    const login = p.root.querySelector("#hubLogin"), password = p.root.querySelector("#hubPassword");
    login.value = "carol"; fire(login, "input"); password.value = "inert-fixture"; fire(password, "input"); await settle(3);
    fire(p.root.querySelector("form"), "submit"); await settle(20);
    expect(signIn).toHaveBeenCalledOnce(); expect(p.root.textContent).toContain(message);
  });
  it("an unrelated failure cannot adopt a code-specific reason", async () => {
    const r = await rig(() => ({ ok: false, code: "limit-reached", reason: "code-scope" }));
    fire(button(r.p, "Connect as Carol"), "click"); await settle(15);
    expect(r.p.root.textContent).toContain("Fleet limit is reached"); expect(r.p.root.textContent).not.toContain("outside the scope");
  });
  it("retiring the page during a held approval aborts its signal and publishes no late result", async () => {
    let release!: (value: any) => void; const r = await rig(() => new Promise(resolve => { release = resolve; }));
    fire(button(r.p, "Connect as Carol"), "click"); await settle(5);
    const signal = r.posts()[0].init.signal; expect(signal.aborted).toBe(false);
    await r.p.unmount(); expect(signal.aborted).toBe(true); release({ ok: false, code: "denied" }); await settle(5);
    expect(r.p.root.textContent).toBe("");
  });
  it("approval after company sign-in queues the same request without signing in a second time", async () => {
    const timers = queueTimers(), p = page({ url: "https://hub.example.test/ui/hub?join=" + ID }); mounted.push(p); i18n.setLang("en", { store: false });
    const deadline = Date.now() + 60_000, calls: any[] = []; let approvals = 0;
    vi.stubGlobal("fetch", vi.fn(async (path: string, init: any = {}) => {
      calls.push({ path, init }); const r = path.includes("/approve") ? (++approvals === 1 ? { ok: false, code: "backpressure" } : { ok: true })
        : { ok: true, state: "pending", label: "My Fleet", outerDeadline: deadline };
      return { ok: r.ok !== false, json: async () => r };
    }));
    const signIn = vi.fn(async () => ({ ok: true, signedIn: true, csrf: "new-session", login: "carol", displayName: "Carol", features: [] }));
    clients.setHubClient({ session: async () => ({ ok: true, signedIn: false }), signIn, rooms: async () => ({ ok: true, rooms: [] }) }); panel.resetHubSession();
    await p.mount(h(panel.HubPanel, { route: { tab: "ask" } })); await settle(20);
    const login = p.root.querySelector("#hubLogin"), password = p.root.querySelector("#hubPassword");
    login.value = "carol"; fire(login, "input"); password.value = "inert-fixture"; fire(password, "input"); await settle(3);
    fire(p.root.querySelector("form"), "submit"); await settle(10); expect(p.root.textContent).toContain("Waiting in the queue");
    timers.shift()!(); await settle(15); expect(signIn).toHaveBeenCalledOnce();
    const posts = calls.filter(c => c.path.includes("/approve")); expect(posts).toHaveLength(2);
    expect(posts.every(c => JSON.parse(c.init.body).requestId === ID && c.init.headers["X-AgEnD-Hub-CSRF"] === "new-session")).toBe(true);
    expect(p.root.querySelector("#hubPassword")).toBeNull();
  });
});
describe("B2 mounted approval lease", () => {
  it("a temporary projection failure or changed deadline does not retire or extend the same approval", async () => {
    let api: any, release!: (value: any) => void;
    const approve = vi.fn((..._args: any[]) => new Promise(resolve => { release = resolve; })), p = page(); mounted.push(p);
    const timers: number[] = [], original = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any, ms: any, ...args: any[]) => ms > 10_000 ? (timers.push(ms), 123 as any) : original(fn, ms, ...args));
    function Harness(props: any) { api = hook.useJoinApproval({ ...props, approve }); return h("p", {}, api.busy ? "approving" : "idle"); }
    const deadline = Date.now() + 60_000;
    await p.mount(h(Harness, { requestId: ID, deadline, sessionKey: "session" })); await settle(5);
    const pending = api.run("csrf"); await settle(3); const signal = approve.mock.calls[0]![2];
    await p.mount(h(Harness, { requestId: ID, deadline: undefined, sessionKey: "session" })); await settle(5);
    expect(p.root.textContent).toBe("approving"); expect(signal.aborted).toBe(false);
    await p.mount(h(Harness, { requestId: ID, deadline: deadline + 600_000, sessionKey: "session" })); await settle(5);
    expect(timers).toHaveLength(1); expect(signal.aborted).toBe(false);
    release({ ok: true }); expect(await pending).toEqual({ ok: true });
  });
  it("request/session changes retire held results without AbortController, then allow the new binding", async () => {
    vi.stubGlobal("AbortController", undefined);
    let api: any, release!: (value: any) => void, n = 0;
    const approve = vi.fn(() => ++n === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ ok: true }));
    const p = page(); mounted.push(p); const deadline = Date.now() + 60_000;
    function Harness(props: any) { api = hook.useJoinApproval({ ...props, approve }); return h("p", {}, api.queued ? "queued" : api.busy ? "approving" : "idle"); }
    await p.mount(h(Harness, { requestId: ID, deadline, sessionKey: "session-one" })); await settle(5);
    const prior = api.run("csrf-one"); await settle(3);
    await p.mount(h(Harness, { requestId: OTHER, deadline, sessionKey: "session-two" })); await settle(5);
    expect(await prior).toEqual({ ok: false, code: "retired" }); expect(p.root.textContent).toBe("idle");
    release({ ok: false, code: "backpressure" }); await settle(5); expect(p.root.textContent).toBe("idle");
    expect(await api.run("csrf-two")).toEqual({ ok: true });
    expect(approve.mock.calls.map((args: any[]) => args.slice(0, 2))).toEqual([[ID, "csrf-one"], [OTHER, "csrf-two"]]);
  });
});
