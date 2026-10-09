/**
 * #1408 step 4 = #1386 part (b): "Needs you" in the app shell.
 * - The panel renders the store's `needs` (SSE `needs` / the /ui/poll field) and reads nothing itself — not on mount,
 *   not while it stays open (#1374). Grouped by instance in the server's order; the server's own wording.
 * - Its writes are a person's: a prompt's buttons through the chat store (one claim with Chat), Acknowledge on a
 *   delivery (POST /ui/needs/ack), and Open (a link to the chat).
 * - The shell: a sidebar entry with a count (hidden at 0), a bottom tab with a badge, "(N) " on the tab's title.
 * - Desktop notifications: opt-in per device, only for an unseen item while the page is hidden, a terminal wait only
 *   at ≥ 5 s, tag = id, a click opens that chat; not offered on a phone or a plain-HTTP LAN address.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
const ITEMS = [
  { id: "prompt:p1", type: "prompt", instance: "api-server", reason: "assist", detail: "Ask General to help?", since: Date.now() - 140_000,
    nonce: "n1", actions: [{ id: "confirm", label: "Ask General" }, { id: "cancel", label: "Myself" }] },
  { id: "awaiting:api-server:1", type: "awaiting_input", instance: "api-server", reason: "permission", detail: "Allow psql?", since: Date.now() - 120_000 },
  { id: "instance:qa-bot:crashed:1", type: "instance", instance: "qa-bot", reason: "crashed", detail: "", since: Date.now() - 47 * 60_000 },
  { id: "delivery:d1", type: "delivery", instance: "docs-writer", reason: "delivery_uncertain", detail: "general → docs-writer · task", since: Date.now() - 3 * 3_600_000, deliveryId: "d1" },
];

let p: AppPage;
let N: any, app: any, chat: any, shell: any, nav: any, ctx: any, notifier: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/needs", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  shell = await import("/assets/app-shell.js");
  nav = await import("/assets/app-nav.js");
  ctx = await import("/assets/app-ctx.js");
  notifier = await import("/assets/app-needs.js");
  chat = await import("/ui/js/panel-chat.js");
  // As the entry does: the booted chat store is published as the page's prompt owner.
  app.appStore.set({ chatOwner: chat.boot({ stream: { on() { return () => {}; } }, boot: null, deps: { fetch: fetchFake } }) });
  N = await import("/ui/js/panel-needs.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  vi.useRealTimers();
  await p.unmount();
  reqs = []; answer = () => ({});
  app.appStore.set({ needs: ITEMS.map(i => ({ ...i })), instances: [] });
});
const mount = (key = "needs:|1|en") => p.mount(h(N.NeedsPanel, { route: { panel: "needs" }, navKey: key }));
const btn = (scope: any, text: string) => scope.querySelectorAll("button, a").find((b: any) => b.textContent.includes(text));

describe("the panel renders the server's list and reads nothing itself (#1374)", () => {
  it("no request on mount, and none in two minutes open (only a display tick)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    const m = mount(); await vi.advanceTimersByTimeAsync(50); await m;
    expect(p.root.querySelectorAll(".n-item")).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reqs).toEqual([]);
  });

  it("grouped by instance in the server's order, in the server's words, each with Open; the store's next list is what shows", async () => {
    await mount(); await settle(4);
    expect(p.root.querySelectorAll(".n-group-head").map((e: any) => e.textContent)).toEqual(["api-server", "qa-bot", "docs-writer"]);
    expect(p.root.querySelectorAll(".n-title strong").map((e: any) => e.textContent)).toEqual(["Waiting at its terminal", "Permission needed", "Crashed", "Could not confirm delivery"]);
    expect(p.root.querySelectorAll(".n-age").map((e: any) => e.textContent)).toEqual(["2 min", "2 min", "47 min", "3 h"]);
    expect(p.root.querySelectorAll(".n-item a").map((a: any) => a.getAttribute("href"))).toEqual(["/ui/chat/api-server", "/ui/chat/api-server", "/ui/chat/qa-bot", "/ui/chat/docs-writer"]);
    // Resolved anywhere: the server's next list drops it, and so does the panel.
    app.appStore.set({ needs: ITEMS.filter(i => i.id !== "delivery:d1") });
    await settle(4);
    expect(p.root.querySelectorAll(".n-item")).toHaveLength(3);
    app.appStore.set({ needs: [] });
    await settle(4);
    expect(p.root.querySelector(".empty")?.textContent).toContain("Nothing needs you right now");
  });

  it("a hostile detail is text, never markup", async () => {
    app.appStore.set({ needs: [{ ...ITEMS[2], detail: '<img src=x onerror="alert(1)">' }] });
    await mount(); await settle(4);
    expect(p.root.querySelector(".n-detail").textContent).toBe('<img src=x onerror="alert(1)">');
    expect(p.root.querySelector(".n-detail img")).toBeNull();
  });
});

describe("its writes are a person's", () => {
  it("a prompt's button answers through the chat store: one POST /ui/prompt, and the buttons stay off while it is claimed", async () => {
    chat.store.applyPrompts([{ instance: "api-server", nonce: "n1", text: "Ask General to help?", actions: ITEMS[0]!.actions, expiresAt: Date.now() + 60_000 }]);
    const held: { open?: () => void } = {};
    answer = (r) => (r.url === "/ui/prompt" ? new Promise(res => { held.open = () => res({ answered: true }); }) : {});
    await mount(); await settle(4);
    const item = p.root.querySelectorAll(".n-item")[0];
    btn(item, "Ask General").click(); await settle(4);
    expect(reqs).toEqual([{ method: "POST", url: "/ui/prompt", body: { instance: "api-server", nonce: "n1", action: "confirm" } }]);
    const again = btn(p.root.querySelectorAll(".n-item")[0], "Myself") ?? btn(p.root.querySelectorAll(".n-item")[0], "Answering");
    expect(again.disabled).toBe(true);
    again.click(); await settle(2);
    expect(reqs.filter(r => r.url === "/ui/prompt")).toHaveLength(1);
    held.open!(); await settle(4);
    chat.store.resolvePrompt({ nonce: "n1", outcome: "answered" });
  });

  it("a prompt the chat store does not hold is answered directly, once", async () => {
    app.appStore.set({ needs: [{ ...ITEMS[0], id: "prompt:p9", nonce: "n9" }] });
    answer = () => ({ answered: true });
    await mount(); await settle(4);
    btn(p.root.querySelector(".n-item"), "Ask General").click(); await settle(6);
    expect(reqs).toEqual([{ method: "POST", url: "/ui/prompt", body: { instance: "api-server", nonce: "n9", action: "confirm" } }]);
  });

  it("Acknowledge: one POST /ui/needs/ack with the item's id, off while it runs; the item leaves with the server's next list", async () => {
    let open!: () => void;
    answer = (r) => (r.url === "/ui/needs/ack" ? new Promise(res => { open = () => res({ acknowledged: true, message: "Acknowledged." }); }) : {});
    await mount(); await settle(4);
    const ack = () => btn(p.root.querySelectorAll(".n-item")[3], "Acknowledg");
    ack().click(); await settle(2);
    expect(ack().disabled).toBe(true);
    ack().click(); await settle(2);
    expect(reqs).toEqual([{ method: "POST", url: "/ui/needs/ack", body: { id: "delivery:d1" } }]);
    open(); await settle(4);
    expect(ack().disabled).toBe(true);                             // taken: claimed until the server's list drops it (#1463 review)
    expect(ack().textContent.trim()).toBe("Acknowledge");
    app.appStore.set({ needs: ITEMS.filter(i => i.id !== "delivery:d1") }); await settle(4);
    expect(p.root.querySelectorAll(".n-item")).toHaveLength(3);
    expect(reqs).toHaveLength(1);
  });

  it("only deliveries offer Acknowledge, only prompts their buttons", async () => {
    await mount(); await settle(4);
    const items = p.root.querySelectorAll(".n-item");
    expect(items.map((i: any) => i.querySelectorAll("button").map((b: any) => b.textContent.trim()))).toEqual([["Ask General", "Myself"], [], [], ["Acknowledge"]]);
  });
});

describe("the shell", () => {
  const panels = () => new Map([["needs", { load: async () => N.NeedsPanel }], ["chat", { load: async () => () => h("div", { class: "panel" }, "chat") }]]);
  it("a sidebar entry with the count (hidden at 0), a bottom tab with a badge, and '(N) ' on the tab's title", async () => {
    nav.navigate("/ui/needs");
    await p.mount(h(shell.Shell, { panels: panels(), onNewInstance() {} })); await settle(8);
    const link = p.root.querySelector('.side-nav a[href="/ui/needs"]');
    expect(link.querySelector(".nav-count").textContent).toBe("4");
    expect(link.getAttribute("aria-label")).toBe("Needs you (4 waiting)");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(p.root.querySelector('.tabs a[href="/ui/needs"] .tab-badge').textContent).toBe("4");
    expect(p.document.title).toBe("(4) Needs you · AgEnD");
    app.appStore.set({ needs: [] }); await settle(4);
    expect(p.root.querySelector('.side-nav a[href="/ui/needs"] .nav-count')).toBeNull();
    expect(p.root.querySelector('.tabs a[href="/ui/needs"] .tab-badge')).toBeNull();
    expect(p.document.title).toBe("Needs you · AgEnD");
    await p.unmount();
  });

  it("View-only renders no Needs you at all", async () => {
    nav.navigate("/view");
    await p.mount(h(shell.Shell, { panels: new Map([["view", { load: async () => () => h("div", { class: "panel" }, "v") }]]), viewOnly: true })); await settle(6);
    expect(p.root.querySelector('a[href="/ui/needs"]')).toBeNull();
    await p.unmount();
  });

  it("the notifier starts in the signed-in branch of the entry only", () => {
    const src = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.js"), "utf8");
    const full = src.slice(src.indexOf('if (mode === "full") {'), src.indexOf("} else appStore.set"));
    expect(full).toContain("startNeedsNotifier(");
    expect(src.split("startNeedsNotifier(").length - 1).toBe(1);
  });

  it("50 mounts leave nothing", async () => {
    await settle();
    const base = { leases: ctx.leaseCount(), doc: p.document.listenerCount(), win: p.window.listenerCount() };
    for (let i = 0; i < 50; i++) { await mount(`needs:|${i}|en`); await p.unmount(); }
    expect(ctx.leaseCount()).toBe(base.leases);
    expect(p.document.listenerCount()).toBe(base.doc);
    expect(p.window.listenerCount()).toBe(base.win);
  });
});

describe("desktop notifications (#1386 §6.3)", () => {
  function env(o: { ua?: string; secure?: boolean; permission?: string; noApi?: boolean } = {}) {
    const shown: Array<{ title: string; body: string; tag: string; n: any }> = [];
    const asked: number[] = [];
    let hidden = false;
    const listeners = new Set<() => void>();
    class FakeNotification {
      static permission = o.permission ?? "granted";
      static async requestPermission() { asked.push(1); return FakeNotification.permission; }
      onclick: null | (() => void) = null; closed = false;
      constructor(title: string, opts: { body: string; tag: string }) { shown.push({ title, body: opts.body, tag: opts.tag, n: this }); }
      close() { this.closed = true; }
    }
    const e: any = {
      Notification: o.noApi ? undefined : FakeNotification, navigator: { userAgent: o.ua ?? "Mozilla/5.0 (X11; Linux x86_64) Chrome/140" },
      isSecureContext: o.secure ?? true, focus: vi.fn(),
      document: { get hidden() { return hidden; }, addEventListener: (_: string, f: () => void) => listeners.add(f), removeEventListener: (_: string, f: () => void) => listeners.delete(f) },
    };
    return { e, shown, asked, FakeNotification, setHidden: (v: boolean) => { hidden = v; for (const f of [...listeners]) f(); }, listeners };
  }
  beforeEach(() => { p.storage.set("agend_needs_notify", "1"); app.appStore.set({ needs: [] }); });

  it("only an item this page has not seen, only while hidden; tag = id; once", async () => {
    const x = env();
    const opened: string[] = [];
    const stop = notifier.startNeedsNotifier({ env: x.e, open: (n: string) => opened.push(n) });
    app.appStore.set({ needs: [ITEMS[2]] });                        // visible: seen, no notification
    expect(x.shown).toEqual([]);
    x.setHidden(true);
    app.appStore.set({ needs: [ITEMS[2], ITEMS[3]] });
    expect(x.shown.map(s => [s.title, s.body, s.tag])).toEqual([["docs-writer", "Could not confirm delivery: general → docs-writer · task", "delivery:d1"]]);
    app.appStore.set({ needs: [ITEMS[2], ITEMS[3]] });              // the same again: nothing new
    expect(x.shown).toHaveLength(1);
    x.shown[0]!.n.onclick();
    expect(opened).toEqual(["docs-writer"]);
    expect(x.e.focus).toHaveBeenCalled();
    expect(x.shown[0]!.n.closed).toBe(true);
    stop();
    expect(x.listeners.size).toBe(0);
  });

  it("a terminal wait notifies only at 5 s, and not if it went meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(1_000_000);
    const x = env();
    const stop = notifier.startNeedsNotifier({ env: x.e });
    x.setHidden(true);
    const young = { ...ITEMS[1], id: "awaiting:a:2", since: 1_000_000 - 2_000 };
    const gone = { ...ITEMS[1], id: "awaiting:a:3", since: 1_000_000 - 1_000 };
    app.appStore.set({ needs: [young, gone] });
    expect(x.shown).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_900);
    expect(x.shown).toEqual([]);
    expect(vi.getTimerCount()).toBe(2);
    app.appStore.set({ needs: [young] });                           // the dialog was answered by AgEnD itself
    expect(vi.getTimerCount(), "the wait that left the list has no timer left").toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(x.shown.map(s => s.tag)).toEqual(["awaiting:a:2"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(x.shown.map(s => s.tag)).toEqual(["awaiting:a:2"]);
    stop();
  });

  it("off unless chosen on this device and permitted; asking the browser happens only on the toggle", async () => {
    p.storage.delete("agend_needs_notify");
    const x = env();
    const stop = notifier.startNeedsNotifier({ env: x.e });
    x.setHidden(true);
    app.appStore.set({ needs: [ITEMS[3]] });
    expect(x.shown).toEqual([]);
    expect(x.asked).toEqual([]);
    stop();
    const d = env({ permission: "denied" });
    expect(await notifier.setNotify(true, d.e)).toBe("denied");
    expect(d.asked).toHaveLength(1);
    expect(p.storage.get("agend_needs_notify")).toBeUndefined();
    const g = env({ permission: "default" });
    g.FakeNotification.requestPermission = async () => { g.asked.push(1); g.FakeNotification.permission = "granted"; return "granted"; };
    expect(await notifier.setNotify(true, g.e)).toBe("on");
    expect(p.storage.get("agend_needs_notify")).toBe("1");
    expect(await notifier.setNotify(false, g.e)).toBe("off");
    expect(p.storage.get("agend_needs_notify")).toBeUndefined();
  });

  it("not offered on a phone, on a plain-HTTP LAN address, or without the API — and the panel says why", async () => {
    expect(notifier.notifySupport(env().e)).toBe("ok");
    expect(notifier.notifySupport(env({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile/15E148" }).e)).toBe("mobile");
    expect(notifier.notifySupport(env({ ua: "Mozilla/5.0 (Linux; Android 15) Chrome/140 Mobile" }).e)).toBe("mobile");
    expect(notifier.notifySupport(env({ secure: false }).e)).toBe("insecure");
    expect(notifier.notifySupport(env({ noApi: true }).e)).toBe("unsupported");
    // In the panel (this mini-dom has no Notification API): no toggle, and the reason in words.
    await mount(); await settle(4);
    const card = p.root.querySelector(".n-notify");
    expect(card.querySelector("button")).toBeNull();
    expect(card.textContent).toContain("This browser cannot show notifications.");
  });
});

// ── #1463 review: claims belong to the page, not to a render or a mount ──

describe("#1463 review: one claim per prompt and per acknowledgement, for the life of the page", () => {
  const held = () => { let open!: (v: unknown) => void; const p = new Promise(r => { open = r; }); return { p, open }; };
  const item = () => p.root.querySelectorAll(".n-item")[0];
  const nPosts = (url: string) => reqs.filter(r => r.method === "POST" && r.url === url).length;
  beforeEach(() => { for (const n of Object.keys(chat.store.state.prompts)) delete chat.store.state.prompts[n]; N.claims.set({ acks: {}, prompts: {} }); });

  it("a prompt: two clicks in the same turn send one answer", async () => {
    const h1 = held();
    answer = (r) => (r.url === "/ui/prompt" ? h1.p : {});
    await mount(); await settle(4);
    btn(item(), "Ask General").click(); btn(item(), "Myself").click();
    await settle(2);
    expect(nPosts("/ui/prompt")).toBe(1);
    h1.open({ answered: true }); await settle(4);
  });

  it("a prompt: Chat learning of it while its answer is out does not free it", async () => {
    const h1 = held();
    answer = (r) => (r.url === "/ui/prompt" ? h1.p : {});
    await mount(); await settle(4);
    btn(item(), "Ask General").click(); await settle(2);
    chat.store.applyPrompts([{ instance: "api-server", nonce: "n1", text: "Ask General to help?", actions: ITEMS[0]!.actions, expiresAt: Date.now() + 60_000 }]);
    chat.store.onPrompt({ instance: "api-server", nonce: "n1", text: "Ask General to help?", actions: ITEMS[0]!.actions, expiresAt: Date.now() + 60_000 });
    await settle(4);
    expect(btn(item(), "Myself") ?? btn(item(), "Answering")).toHaveProperty("disabled", true);
    (btn(item(), "Myself") ?? btn(item(), "Answering")).click(); await settle(2);
    expect(nPosts("/ui/prompt")).toBe(1);
    h1.open({ answered: true }); await settle(4);
  });

  it("a prompt: answered, and the list has not caught up yet — still taken; the server's outcome settles it", async () => {
    answer = (r) => (r.url === "/ui/prompt" ? { answered: true } : {});
    await mount(); await settle(4);
    btn(item(), "Ask General").click(); await settle(6);
    btn(item(), "Myself")?.click(); btn(item(), "Answering")?.click(); await settle(4);
    expect(nPosts("/ui/prompt")).toBe(1);
    chat.store.resolvePrompt({ nonce: "n1", outcome: "answered" }); await settle(4);
    expect(nPosts("/ui/prompt")).toBe(1);
  });

  it("Acknowledge: two clicks in the same turn send one", async () => {
    const h1 = held();
    answer = (r) => (r.url === "/ui/needs/ack" ? h1.p : {});
    await mount(); await settle(4);
    const ack = () => btn(p.root.querySelectorAll(".n-item")[3], "Acknowledg");
    ack().click(); ack().click();
    await settle(2);
    expect(nPosts("/ui/needs/ack")).toBe(1);
    h1.open({ acknowledged: true, message: "Acknowledged." }); await settle(4);
  });

  it("Acknowledge: leaving Needs you and opening it again while it is out finds it taken", async () => {
    const h1 = held();
    answer = (r) => (r.url === "/ui/needs/ack" ? h1.p : {});
    await mount(); await settle(4);
    btn(p.root.querySelectorAll(".n-item")[3], "Acknowledg").click(); await settle(2);
    await p.unmount();
    await mount("needs:|2|en"); await settle(4);
    const again = btn(p.root.querySelectorAll(".n-item")[3], "Acknowledg");
    expect(again.disabled).toBe(true);
    again.click(); await settle(2);
    expect(nPosts("/ui/needs/ack")).toBe(1);
    h1.open({ __status: 500, error: "could not record" }); await settle(4);
    expect(btn(p.root.querySelectorAll(".n-item")[3], "Acknowledg").disabled).toBe(false);   // refused: free again
  });

  it("the notification choice: a toggle mounted while the browser was asking learns the answer", async () => {
    const notifier = await import("/assets/app-needs.js");
    let grant!: (v: string) => void;
    class FakeNotification { static permission = "default"; static requestPermission() { return new Promise<string>(r => { grant = (v) => { FakeNotification.permission = v; r(v); }; }); } }
    const real = { N: (globalThis as any).Notification, secure: (globalThis as any).isSecureContext, ua: (globalThis as any).navigator };
    (globalThis as any).Notification = FakeNotification; (globalThis as any).isSecureContext = true;
    (globalThis as any).navigator = { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140", language: "en" };
    p.storage.delete("agend_needs_notify");
    notifier.notifyStore.set({ state: "off", asking: false });
    try {
      await mount(); await settle(4);
      btn(p.root.querySelector(".n-notify"), "Turn on").click(); await settle(2);
      await p.unmount();
      await mount("needs:|3|en"); await settle(4);
      expect(btn(p.root.querySelector(".n-notify"), "Turn on").disabled).toBe(true);     // the browser is asking
      grant("granted"); await settle(6);
      expect(p.storage.get("agend_needs_notify")).toBe("1");
      expect(btn(p.root.querySelector(".n-notify"), "Turn off")).toBeDefined();
      expect(p.root.querySelector(".n-notify .note").textContent).toContain("Notifications are on");
    } finally {
      (globalThis as any).Notification = real.N; (globalThis as any).isSecureContext = real.secure; (globalThis as any).navigator = real.ua;
      notifier.notifyStore.set({ state: "off", asking: false });
    }
  });
});

describe("#1463 review: before Chat has booted, the page's own claim — handed to the chat store when it comes", () => {
  it("one answer for a prompt, kept across a remount until the list drops it", async () => {
    vi.resetModules();
    const fresh = await import("/ui/js/panel-needs.js");
    const appFresh = await import("/assets/app-store.js");
    appFresh.appStore.set({ needs: [ITEMS[0]], chatOwner: null });
    let open!: (v: unknown) => void;
    answer = (r) => (r.url === "/ui/prompt" ? new Promise(res => { open = res; }) : {});
    // A fresh module graph has its own Preact: render with it (the harness's render is the first graph's).
    const P = await import("/assets/preact.module.js");
    P.options.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
    const mountFresh = async (k: string) => { P.render(P.h(fresh.NeedsPanel, { route: { panel: "needs" }, navKey: k }), p.root); await settle(); };
    const unmountFresh = async () => { P.render(null, p.root); await settle(); };
    try {
      await mountFresh("f1"); await settle(4);
      btn(p.root.querySelector(".n-item"), "Ask General").click(); btn(p.root.querySelector(".n-item"), "Myself").click();
      await settle(2);
      await unmountFresh(); await mountFresh("f2"); await settle(4);
      btn(p.root.querySelector(".n-item"), "Myself")?.click(); await settle(2);
      expect(reqs.filter(r => r.url === "/ui/prompt")).toHaveLength(1);
      open({ answered: true }); await settle(4);
      btn(p.root.querySelector(".n-item"), "Myself")?.click(); await settle(2);
      expect(reqs.filter(r => r.url === "/ui/prompt")).toHaveLength(1);
      appFresh.appStore.set({ needs: [] }); await settle(2);
      expect(fresh.claims.get().prompts).toEqual({});
    } finally { await unmountFresh(); vi.resetModules(); }
  });

  it("a claim taken before Chat booted is the chat store's once it boots: no second answer from Chat or Needs you", async () => {
    vi.resetModules();
    const fresh = await import("/ui/js/panel-needs.js");
    const appFresh = await import("/assets/app-store.js");
    const chatFresh = await import("/ui/js/panel-chat.js");
    appFresh.appStore.set({ needs: [ITEMS[0]], chatOwner: null });
    let open!: (v: unknown) => void;
    answer = (r) => (r.url === "/ui/prompt" ? new Promise(res => { open = res; }) : {});
    const P = await import("/assets/preact.module.js");
    P.options.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
    const mountFresh = async () => { P.render(P.h(fresh.NeedsPanel, { route: { panel: "needs" }, navKey: "h1" }), p.root); await settle(); };
    try {
      await mountFresh(); await settle(4);
      btn(p.root.querySelector(".n-item"), "Ask General").click(); await settle(2);
      // Chat boots now (the entry publishes its store): the claim is handed over.
      const owner = chatFresh.boot({ stream: { on() { return () => {}; } }, boot: null, deps: { fetch: fetchFake } });
      appFresh.appStore.set({ chatOwner: owner }); await settle(4);
      expect(owner.state.prompts.n1?.busy).toBe(true);
      owner.answerByNonce(ITEMS[0], "cancel"); await settle(2);                     // Chat's button: already taken
      btn(p.root.querySelector(".n-item"), "Myself")?.click(); btn(p.root.querySelector(".n-item"), "Answering")?.click(); await settle(2);
      expect(reqs.filter(r => r.url === "/ui/prompt")).toHaveLength(1);
      open({ error: "refused" }); await settle(4);                                  // refused: free again, in the owner
      expect(owner.state.prompts.n1?.busy).toBe(false);
      expect(fresh.claims.get().prompts).toEqual({});
    } finally { P.render(null, p.root); await settle(); vi.resetModules(); }
  });
});
