/** #3637 PR1: page services stay shared; mounted panes own their DOM, focus and cleanup. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage, chat: any, ctx: any, shell: any, app: any, preview: any, tabs: any;
const requests: string[] = [];
const fetchFake = async (path: string) => {
  requests.push(path);
  return { ok: true, status: 200, json: async () => path.startsWith("/ui/history") ? { messages: [] } : {} };
};
const stream = { on() { return () => {}; } };
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/chat/alpha", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  ctx = await import("/assets/app-ctx.js");
  shell = await import("/assets/app-shell.js");
  app = await import("/assets/app-store.js");
  tabs = await import("/assets/instance-switch.js");
  chat = await import("/ui/js/panel-chat.js");
  preview = await import("/ui/js/preview-panel.js");
  chat.boot({ stream, boot: null, deps: { fetch: fetchFake } });
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount(); preview.closePanel(); chat.forgetKeptThreads(); requests.length = 0;
  app.applyStatus({ uptime: 1, instances: ["alpha", "beta"].map(name => ({ name, status: "running", state: "idle", execution_state: "idle" })) });
});
const pane = (id: string, focused: boolean, child: unknown, extra = {}) => h(ctx.PaneScope, { value: { id, focused, ...extra } }, child);
const panel = (name: string) => h(chat.ChatPanel, { route: { panel: "chat", instance: name }, navKey: `chat:${name}|1|en` });

describe("visible chats are distinct from page focus", () => {
  it("recovers both visible histories once after a gap, defers hidden chats and survives an older owner's cleanup", async () => {
    const reads: string[] = [];
    const st = (await import("/ui/js/chat-store.js") as any).createChatStore({
      fetch: async (path: string) => { reads.push(path); return { json: async () => ({ messages: [] }) }; },
      t: (key: string) => key, toast: vi.fn(), announce: vi.fn(), now: () => 1,
    });
    const a = st.show("alpha"), b = st.show("beta"); a.focus(true);
    await st.openHistory("hidden"); reads.length = 0;
    st.onGap(); await settle();
    expect(reads).toEqual(["/ui/history?instance=alpha&limit=200", "/ui/history?instance=beta&limit=200"]);
    b.focus(true); a.close();
    expect(st.state.current).toBe("beta");
    reads.length = 0; st.onGap(); await settle();
    expect(reads).toEqual(["/ui/history?instance=beta&limit=200"]);
    b.close(); expect(st.state.current).toBeNull();
  });
  it("publishes a prompt in the unfocused visible pane without a hidden-chat toast", async () => {
    const toast = vi.fn(), changed = vi.fn();
    const st = (await import("/ui/js/chat-store.js") as any).createChatStore({ fetch: fetchFake, t: (key: string) => key, toast, announce: vi.fn() });
    const a = st.show("alpha"), b = st.show("beta"); a.focus(true);
    const off = st.subscribe(changed);
    st.onPrompt({ nonce: "pane-beta", instance: "beta", text: "Permission", actions: [] });
    expect(changed).toHaveBeenCalledWith("beta", "state");
    expect(toast).not.toHaveBeenCalled();
    st.onPrompt({ nonce: "pane-hidden", instance: "hidden", text: "Other permission", actions: [] });
    expect(toast).toHaveBeenCalledTimes(1);
    off(); a.close(); b.close();
  });
  it("an old aborted read cannot clear the newer gap recovery's read marker or publish its body", async () => {
    const answer: Array<(value: unknown) => void> = [];
    const fetch = vi.fn(() => new Promise(resolve => answer.push(resolve)));
    const st = (await import("/ui/js/chat-store.js") as any).createChatStore({ fetch, t: (key: string) => key, toast: vi.fn(), announce: vi.fn() });
    const ac = new AbortController();
    const first = st.openHistory("alpha", null, ac.signal);
    st.setCurrent("alpha"); st.onGap();
    expect(fetch).toHaveBeenCalledTimes(2);
    ac.abort(); answer[0]({ json: async () => ({ messages: [] }) }); await first;
    const third = st.openHistory("alpha");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await third).toBe(false);
    answer[1]({ json: async () => ({ messages: [] }) }); await settle();
    expect(st.state.historyRead.has("alpha")).toBe(true);
  });
  it("never evicts any mounted thread, including while a different pane leaves", () => {
    expect(chat.threadsToLetGo([["a", 400], ["b", 400], ["hidden", 1]], null,
      { keep: 1, maxNodes: 2, favorites: new Set(), protected: new Set(["a", "b"]) })).toEqual(["hidden"]);
  });
});

describe("pane scope adds no DOM and retains legacy defaults", () => {
  it("resizes only scoped composers when their physical width changes, without touching an IME", async () => {
    const observed = new Map<any, () => void>();
    (globalThis as any).ResizeObserver = class { constructor(private update: () => void) {} observe(el: any) { if (el.tagName === "TEXTAREA") observed.set(el, this.update); } disconnect() {} };
    try {
      await p.mount(h("div", null, pane("a", true, panel("alpha")), pane("b", false, panel("beta"))));
      const a: any = p.document.getElementById("pane-a-msgIn");
      expect(observed.has(a)).toBe(true);
      let width = 600; a.getBoundingClientRect = () => ({ width });
      Object.defineProperty(a, "scrollHeight", { configurable: true, get: () => width < 300 ? 600 : width < 400 ? 96 : 48 });
      a.value = "A wrapped draft"; fire(a, "input"); await settle(3);
      observed.get(a)!(); await settle(2); expect(a.style.height).toBe("48px");
      fire(a, "compositionstart"); width = 360; observed.get(a)!(); await settle(2); expect(a.style.height).toBe("48px");
      fire(a, "compositionend"); await settle(2); expect(a.style.height).toBe("96px");
      width = 600; observed.get(a)!(); await settle(2); expect(a.style.height).toBe("48px");
      width = 260; observed.get(a)!(); await settle(2); expect(a.style.height).toBe("240px");
      await p.unmount(); width = 360; observed.get(a)!(); await settle(2); expect(a.style.height).toBe("240px"); await p.mount(panel("alpha")); const single = p.document.getElementById("msgIn"); expect(observed.has(single)).toBe(false);
    } finally { delete (globalThis as any).ResizeObserver; }
  });

  it("hands a local draft to the real composer and refuses IME or later source edits without sending", async () => {
    await p.mount(h("div", null, pane("a", true, panel("alpha")), pane("b", false, panel("beta"))));
    const a: any = p.document.getElementById("pane-a-msgIn"), b: any = p.document.getElementById("pane-b-msgIn");
    a.value = "move this"; fire(a, "input"); b.value = ""; fire(b, "input"); await settle(3);
    const ticket = chat.capturePaneDraft("alpha"); expect(ticket.current()).toBe(true);
    fire(b, "compositionstart"); expect(chat.acceptPaneDraft("beta", ticket.payload)).toBe(false); fire(b, "compositionend");
    expect(chat.acceptPaneDraft("beta", ticket.payload)).toBe(true); await settle(3); expect(b.value).toBe("move this");
    fire(a, "compositionstart"); expect(chat.capturePaneDraft("alpha")).toBeNull(); expect(ticket.current()).toBe(false);
    a.value = "later typing"; fire(a, "compositionend"); expect(ticket.current()).toBe(false);
    expect(requests.filter(path => /send|upload|command/.test(path))).toEqual([]);
  });

  it("cross-pane quote edits only B's draft, records undo and never sends or copies A's reply identity", async () => {
    await p.mount(h("div", null, pane("a", true, panel("alpha")), pane("b", false, panel("beta"))));
    const undo = await import("/assets/text-undo.js") as any;
    const a = p.document.getElementById("pane-a-msgIn") as any, b = p.document.getElementById("pane-b-msgIn") as any;
    a.value = "A keeps typing"; fire(a, "input"); b.value = "Before"; fire(b, "input"); await settle(3);
    const offUndo = undo.installTextUndo({ doc: p.document, win: p.window });
    try {
    const originalReply = chat.store.state.replies.beta;
    expect(chat.insertPaneQuote("beta", "alpha", "Selected passage", () => false)).toBe(false);
    expect(b.value).toBe("Before");
    expect(chat.insertPaneQuote("beta", "alpha", "Selected passage")).toBe(true); await settle(4);
    expect(a.value).toBe("A keeps typing"); expect(b.value).toContain("> alpha:\n> Selected passage");
    expect(chat.store.state.replies.beta).toBe(originalReply);
    expect(requests.filter(path => /send|command|reply-button/.test(path))).toEqual([]);
    expect(fire(b, "keydown", { key: "z", ctrlKey: true }).defaultPrevented).toBe(true); expect(b.value).toBe("Before");
    } finally { offUndo(); }
  });
  it("keeps legacy composer IDs without a pane scope", async () => {
    await p.mount(panel("alpha"));
    expect(p.document.querySelectorAll("#msgIn")).toHaveLength(1);
    expect(p.document.querySelectorAll(".panel.p-chat")).toHaveLength(1);
  });
  it("binds each composer and delayed feedback to its own agent; only the focused pane publishes its title", async () => {
    await p.mount(h("div", null, pane("a", true, panel("alpha")), pane("b", false, panel("beta"))));
    expect(p.document.title).toBe("alpha · AgEnD");
    const a = p.document.getElementById("pane-a-msgIn"), b = p.document.getElementById("pane-b-msgIn");
    expect(a).not.toBeNull(); expect(b).not.toBeNull();
    expect(p.document.querySelectorAll("textarea")).toHaveLength(2);
    expect(p.document.activeElement).toBe(a);
    const feedback = (await import("/ui/js/preview-panel-actions.js") as any).panelFeedback();
    feedback.addToDraft("beta", "A quoted page"); feedback.focus("beta"); await settle();
    expect(chat.store.state.drafts.beta).toContain("A quoted page");
    expect(p.document.activeElement).toBe(b);
    a?.focus(); feedback.addToDraft("beta", "From retained actions"); feedback.focus(); await settle();
    expect(p.document.activeElement).toBe(b); // old preview actions omit the argument
    expect(requests.filter(path => !path.startsWith("/ui/history") && path !== "/ui/authorization")).toEqual([]);
  });
  it("routes Escape to the focused busy pane and transfers focus without remounting", async () => {
    const busy = { uptime: 1, instances: ["alpha", "beta"].map(name => ({ name, status: "running", state: "working", execution_state: "working" })) };
    app.applyStatus(busy); chat.store.applyStatus(busy);
    const main = p.document.createElement("main"); main.id = "main"; p.document.body.appendChild(main); main.appendChild(p.root);
    const make = (focused: string) => h("div", null, pane("a", focused === "a", panel("alpha")), pane("b", focused === "b", panel("beta")));
    try {
      await p.mount(make("b")); p.document.body.focus();
      shell.handleKey(fire(p.document.body, "keydown", { key: "Escape" })); await settle();
      expect(requests.filter(path => path.startsWith("/ui/cancel/"))).toEqual(["/ui/cancel/beta"]);
      await p.mount(make("a")); expect(p.document.title).toBe("alpha · AgEnD");
      expect(chat.store.state.current).toBe("alpha");
      shell.handleKey(fire(p.document.body, "keydown", { key: "Escape" })); await settle();
      expect(requests.filter(path => path.startsWith("/ui/cancel/"))).toEqual(["/ui/cancel/beta", "/ui/cancel/alpha"]);
    } finally { p.document.body.appendChild(p.root); main.remove(); }
  });
  it("routes ordinary text-tab clicks through their pane but leaves browser modified clicks alone", async () => {
    const navigate = vi.fn();
    await p.mount(pane("a", true, h(tabs.InstanceSwitch, { name: "alpha", current: "chat" }), { navigate }));
    const link = p.document.querySelector('.inst-switch a[href="/view/alpha"]');
    expect(link).not.toBeNull();
    if (!link) throw new Error("missing View tab");
    const modified = fire(link, "click", { button: 0, ctrlKey: true });
    expect(modified.defaultPrevented).toBe(false); expect(navigate).not.toHaveBeenCalled();
    const plain = fire(link, "click", { button: 0 });
    expect(plain.defaultPrevented).toBe(true); expect(navigate).toHaveBeenCalledWith("/view/alpha");
  });
  it("leaving A cannot close B's newly opened preview", async () => {
    const make = (a: boolean) => h("div", null, a ? h("div", { key: "a" }, panel("alpha")) : null, h("div", { key: "b" }, panel("beta")));
    await p.mount(make(true));
    preview.openPanel({ key: "b-html", instance: "beta", code: "<h1>B</h1>", msgKey: "b-1" }); await settle();
    await p.mount(make(false));
    expect(preview.shownKey()).toBe("b-html");
  });
  it("has one image host and closing A preserves B's image until B leaves", async () => {
    const images = await import("/ui/js/image-lightbox.js") as any;
    const make = (a: boolean) => h("div", null, a ? h("div", { key: "a" }, panel("alpha")) : null, h("div", { key: "b" }, panel("beta")));
    await p.mount(make(true));
    const b = p.document.querySelectorAll(".p-chat")[1];
    const link = p.document.createElement("a"); link.setAttribute("href", "/ui/file/" + "a".repeat(32)); b.appendChild(link);
    images.openLightbox([link], link); await settle();
    expect(p.document.querySelectorAll(".lb")).toHaveLength(1);
    await p.mount(make(false)); expect(images.lightboxStore.get().open).not.toBeNull();
    await p.unmount(); expect(images.lightboxStore.get().open).toBeNull();
  });
  it("keeps each Details category heading's accessible ID in its own pane", async () => {
    const settings = await import("/ui/js/agent-details-settings.js") as any;
    const nav = (name: string) => h(settings.AgentCategoryNav, { name, kind: "fleet", cat: "overview" });
    await p.mount(h("div", null, pane("a", true, nav("alpha")), pane("b", false, nav("beta"))));
    expect(p.document.getElementById("pane-a-ap-grp-settings")).not.toBeNull();
    expect(p.document.getElementById("pane-b-ap-grp-settings")).not.toBeNull();
    expect(p.document.querySelectorAll('[aria-labelledby="pane-b-ap-grp-settings"]')).toHaveLength(1);
  });
  it("50 pane mounts return leases and focused ownership to their baseline", async () => {
    const before = ctx.leaseCount();
    for (let i = 0; i < 50; i++) {
      await p.mount(pane("a", true, panel(i % 2 ? "alpha" : "beta")));
      await p.unmount();
    }
    expect(ctx.leaseCount()).toBe(before); expect(chat.store.state.current).toBeNull();
  });
  it("keeps two staged Details guards registered and releases only the leaving owner", async () => {
    const routing = await import("/assets/app-nav.js") as any;
    const settings = await import("/ui/js/agent-details-settings.js") as any;
    const sessions: Record<string, any> = {};
    function Probe({ name }: { name: string }) {
      sessions[name] = settings.useAgentSettings({ name, lease: ctx.useLease(name), enabled: false, navKey: name });
      return h("span", null, name);
    }
    const oldConfirm = (globalThis as any).confirm; (globalThis as any).confirm = undefined;
    routing.startRouter(p.window);
    await p.mount(h("div", null, h(Probe, { name: "alpha", key: "a" }), h(Probe, { name: "beta", key: "b" })));
    sessions.alpha.stage("a", { label: "A" }); sessions.beta.stage("b", { label: "B" }); await settle();
    const confirm = (await import("/assets/ui-confirm.js") as any).confirmStore;
    routing.navigate("/ui/chat/beta"); await settle();
    expect(confirm.get().queue).toHaveLength(1);
    const { answerConfirm } = await import("/assets/ui-confirm.js") as any;
    answerConfirm(confirm.get().queue[0].id, false); await settle();
    await p.mount(h("div", null, h(Probe, { name: "alpha", key: "a" })));
    routing.navigate("/ui/chat/beta"); await settle();
    expect(confirm.get().queue).toHaveLength(1);
    answerConfirm(confirm.get().queue[0].id, false); await settle();
    (globalThis as any).confirm = oldConfirm;
  });
  for (const acceptSecond of [true, false]) it(`keeps A discarded across a rerender while B ${acceptSecond ? "accepts" : "cancels"} its question`, async () => {
    const routing = await import("/assets/app-nav.js") as any;
    const settings = await import("/ui/js/agent-details-settings.js") as any;
    const confirm = await import("/assets/ui-confirm.js") as any;
    const sessions: Record<string, any> = {};
    function Probe({ name, revision }: { name: string; revision: number }) {
      sessions[name] = settings.useAgentSettings({ name, lease: ctx.useLease(name), enabled: false, navKey: name });
      return h("span", null, name, revision);
    }
    const make = (revision: number) => h("div", null, h(Probe, { name: "alpha", revision, key: "a" }), h(Probe, { name: "beta", revision, key: "b" }));
    const previousConfirm = (globalThis as any).confirm; (globalThis as any).confirm = undefined;
    try {
      routing.startRouter(p.window); routing.navigate("/ui/chat/alpha", { force: true });
      await p.mount(make(0));
      sessions.alpha.stage("a", { label: "A" }); sessions.beta.stage("b", { label: "B" }); await settle();
      routing.navigate("/ui/chat/beta"); await settle();
      expect(confirm.confirmStore.get().queue).toHaveLength(1);
      confirm.answerConfirm(confirm.confirmStore.get().queue[0].id, true); await settle();
      expect(confirm.confirmStore.get().queue).toHaveLength(1); // B still has its own decision
      await p.mount(make(1)); // status/parent rerender while B's question is open
      confirm.answerConfirm(confirm.confirmStore.get().queue[0].id, acceptSecond); await settle();
      expect(confirm.confirmStore.get().queue).toHaveLength(0);
      expect(routing.navStore.get().route.instance).toBe(acceptSecond ? "beta" : "alpha");
      expect(sessions.alpha.staged.size).toBe(0);
      expect(sessions.beta.staged.size).toBe(acceptSecond ? 0 : 1);
      if (!acceptSecond) {
        routing.navigate("/ui/chat/beta"); await settle();
        expect(confirm.confirmStore.get().queue).toHaveLength(1);
        confirm.answerConfirm(confirm.confirmStore.get().queue[0].id, false); await settle();
        expect(sessions.alpha.staged.size).toBe(0); expect(sessions.beta.staged.size).toBe(1);
      }
    } finally {
      await p.unmount();
      for (const question of [...confirm.confirmStore.get().queue]) confirm.answerConfirm(question.id, false);
      (globalThis as any).confirm = previousConfirm;
    }
  });
  it("notifies every outlet waiting on one shared lazy import", async () => {
    let done!: (component: unknown) => void;
    const load = vi.fn(() => new Promise(resolve => { done = resolve; }));
    const panels = new Map([["probe", { load }]]);
    const props = { route: { panel: "probe" }, seq: 1, panels };
    await p.mount(h("div", null, h(shell.Outlet, props), h(shell.Outlet, props)));
    expect(load).toHaveBeenCalledTimes(1);
    done(() => h("span", { class: "ready-pane" }, "Ready")); await settle();
    expect(p.document.querySelectorAll(".ready-pane")).toHaveLength(2);
  });
});
