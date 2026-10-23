/**
 * #2293 PR 2: global search on the page — the Spotlight dialog (debounced query, results grouped by agent with a badge
 * each, ↑↓ / Enter / Esc / a click outside, folded filters, recent searches, the index's copy for what the chat no longer
 * has) and how it is opened (the sidebar row, Ctrl+K / ⌘K, Ctrl+F in a chat narrowed to it).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

type Served = any;
const load = async () => (await import("/ui/js/search-dialog.js" as string)) as Served;
let p: AppPage | null = null;
afterEach(async () => { if (p) { await p.unmount(); p.restore(); p = null; } vi.useRealTimers(); vi.unstubAllGlobals(); });

const T = Date.UTC(2026, 9, 21, 6, 0);
const hits = [
  { key: "chat:dev:abc-1", source: "chat", instance: "dev", peer: null, sender: "han", role: "user", ts: T, ref: { boot: "abc", id: 1 }, snippet: "請改 nginx 設定", marks: [[3, 8]], live: true },
  { key: "xmsg:xmsg-1:dev", source: "xmsg", instance: "lead", peer: "dev", sender: "lead", role: "task", ts: T - 1000, ref: { messageId: "xmsg-1" }, snippet: "please fix nginx", marks: [[11, 16]] },
  { key: "chat:dev:old-2", source: "chat", instance: "dev", peer: null, sender: "bot", role: "agent", ts: T - 2000, ref: { boot: "0bd", id: 2 }, snippet: "nginx restarted", marks: [[0, 5]], live: false },
  { key: "task:t1", source: "task", instance: "ops", peer: null, sender: "lead", role: "open", ts: T - 3000, ref: { taskId: "t1" }, snippet: "Upgrade nginx", marks: [[8, 13]] },
];
function fakeFetch(answer: (url: string) => { status?: number; body?: unknown }) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    const a = answer(url);
    return { ok: (a.status ?? 200) < 400, status: a.status ?? 200, json: async () => a.body ?? {} };
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}
type Answer = (url: string) => { status?: number; body?: unknown };
async function open(preset: Record<string, string> = {}, answer: Answer = (url) => (url.startsWith("/ui/teams") ? { body: { teams: { ops: { members: ["a"] } } } } : { body: { hits, limited: false, building: false } })) {
  p = page();
  const calls = fakeFetch(answer);
  const m = await load();
  ((await import("/assets/app-nav.js" as string)) as Served).startRouter(window);
  const onClose = vi.fn();
  await p.mount(h(m.SearchDialog, { preset, onClose }));
  const input: any = p.document.querySelector(".search-input");
  const type = async (text: string) => { input.value = text; fire(input, "input"); await new Promise(r => setTimeout(r, m.DEBOUNCE_MS + 20)); await settle(); };
  const key = async (k: string, init: Record<string, unknown> = {}) => { fire(input, "keydown", { key: k, ...init }); await settle(); };
  return { m, calls, onClose, input, type, key, doc: p.document as any, searches: () => calls.filter(u => u.startsWith("/ui/search?")) };
}

describe("helpers", () => {
  it("searchUrl: the query and only the filters that narrow it", async () => {
    const m = await load();
    const all = { instance: "", team: "", since: "any", sources: ["chat", "xmsg", "task"], mine: false };
    expect(m.searchUrl("  ", all)).toBeNull();
    expect(m.searchUrl(" nginx ", all)).toBe("/ui/search?q=nginx&limit=60");
    const u = new URL(m.searchUrl("x", { instance: "dev", team: "ops", since: "week", sources: ["chat", "task"], mine: true }, 1_000_000_000_000), "http://h");
    expect([u.searchParams.get("instance"), u.searchParams.get("team"), u.searchParams.getAll("source"), u.searchParams.get("since"), u.searchParams.get("mine")])
      .toEqual(["dev", "ops", ["chat", "task"], String(1_000_000_000_000 - 7 * 24 * 3600_000), "1"]);
  });
  it("groupHits: by agent, in the order each agent's newest appears; flatHits is the ↑↓ order", async () => {
    const m = await load();
    const groups = m.groupHits(hits);
    expect(groups.map((g: any) => [g.instance, g.hits.map((x: any) => x.index)])).toEqual([["dev", [0, 1]], ["lead", [2]], ["ops", [3]]]);
    expect(m.flatHits(groups).map((x: any) => x.key)).toEqual(["chat:dev:abc-1", "chat:dev:old-2", "xmsg:xmsg-1:dev", "task:t1"]);
  });
  it("snippetSegments: marks clipped to the text, overlapping or bad ones ignored", async () => {
    const m = await load();
    expect(m.snippetSegments("abc nginx def", [[4, 9]])).toEqual([{ text: "abc " }, { text: "nginx", mark: true }, { text: " def" }]);
    expect(m.snippetSegments("abc", [[2, 99], [1, 2], "x"])).toEqual([{ text: "ab" }, { text: "c", mark: true }]);
    expect(m.snippetSegments("", null)).toEqual([]);
  });
  it("markTerms: every occurrence of each word, any case, overlaps merged", async () => {
    const m = await load();
    expect(m.markTerms("Nginx and nginx, NGINXX", "nginx")).toEqual([{ text: "Nginx", mark: true }, { text: " and " }, { text: "nginx", mark: true }, { text: ", " }, { text: "NGINX", mark: true }, { text: "X" }]);
    expect(m.markTerms("abcd", "abc bcd")).toEqual([{ text: "abcd", mark: true }]);
    expect(m.markTerms("text", "")).toEqual([{ text: "text" }]);
  });
  it("messageKeyOf: only a well-formed boot and id; when(): today, this year, before", async () => {
    const m = await load();
    expect([m.messageKeyOf(hits[0]), m.messageKeyOf({ ref: { boot: "../x", id: 1 } }), m.messageKeyOf({ ref: { boot: "ab", id: -1 } }), m.messageKeyOf({})]).toEqual(["abc-1", null, null, null]);
    const now = new Date(2026, 9, 21, 15, 0).getTime();
    expect([m.when(new Date(2026, 9, 21, 9, 5).getTime(), now), m.when(new Date(2026, 0, 2, 9, 5).getTime(), now), m.when(new Date(2025, 0, 2).getTime(), now), m.when(NaN, now)])
      .toEqual(["09:05", "1/2 09:05", "2025/1/2", ""]);
  });
  it("recent searches: newest first, no repeats, at most RECENT_MAX; unreadable storage is none", async () => {
    p = page();
    const m = await load();
    for (let i = 0; i < m.RECENT_MAX + 2; i++) m.rememberSearch(`q${i}`);
    m.rememberSearch("q3"); m.rememberSearch("  ");
    expect(m.readRecent()).toEqual(["q3", "q9", "q8", "q7", "q6", "q5", "q4", "q2"]);
    localStorage.setItem(m.RECENT_KEY, "{not json");
    expect(m.readRecent()).toEqual([]);
  });
});

describe("the dialog", () => {
  it("opens modal with the query box focused; empty: the hint (and recent searches)", async () => {
    const d = await open();
    const dlg = d.doc.querySelector("dialog.search-dlg");
    expect(dlg.open).toBe(true);
    expect(d.doc.activeElement).toBe(d.input);
    expect(d.doc.querySelector(".search-hint")).not.toBeNull();
    expect(d.searches()).toEqual([]);
  });
  it("searches DEBOUNCE_MS after the last keystroke — one request for a burst of typing", async () => {
    const d = await open();
    for (const s of ["n", "ng", "ngi", "nginx"]) { d.input.value = s; fire(d.input, "input"); await new Promise(r => setTimeout(r, 50)); }
    await new Promise(r => setTimeout(r, d.m.DEBOUNCE_MS + 30)); await settle();
    expect(d.searches()).toEqual(["/ui/search?q=nginx&limit=60"]);
  });
  it("results grouped by agent, each with its badge and marked words; ↑↓ moves the active option", async () => {
    const d = await open();
    await d.type("nginx");
    const groups = d.doc.querySelectorAll(".search-group");
    expect(groups.map((g: any) => g.getAttribute("aria-label"))).toEqual(["dev", "lead", "ops"]);
    expect(d.doc.querySelectorAll(".search-badge").map((b: any) => b.textContent)).toEqual(["Chat", "Chat", "Message", "Task"]);
    expect(d.doc.querySelectorAll(".search-snippet mark").map((x: any) => x.textContent)).toEqual(["nginx", "nginx", "nginx", "nginx"]);
    expect(d.input.getAttribute("aria-activedescendant")).toBe("search-opt-0");
    await d.key("ArrowDown"); await d.key("ArrowDown");
    expect(d.input.getAttribute("aria-activedescendant")).toBe("search-opt-2");
    await d.key("ArrowUp"); await d.key("ArrowUp"); await d.key("ArrowUp");
    expect(d.input.getAttribute("aria-activedescendant")).toBe("search-opt-3");
  });
  it("↑↓ and Enter in the filters are the control's own: the active result does not move, nothing opens", async () => {
    const d = await open({ instance: "dev" });
    await d.type("nginx");
    const select = d.doc.querySelector(".search-filters select");
    fire(select, "keydown", { key: "ArrowDown" }); fire(select, "keydown", { key: "Enter" }); await settle();
    expect([d.input.getAttribute("aria-activedescendant"), d.onClose.mock.calls.length, location.hash]).toEqual(["search-opt-0", 0, ""]);
  });
  it("Enter on a chat row still in the history: closes and opens that chat at the message (#m=), remembered", async () => {
    const d = await open();
    await d.type("nginx");
    const heard: string[] = [];
    window.addEventListener("hashchange", () => heard.push(location.hash));
    await d.key("Enter");
    expect(d.onClose).toHaveBeenCalled();
    expect([location.pathname, location.hash, heard]).toEqual(["/ui/chat/dev", "#m=abc-1", ["#m=abc-1"]]);
    expect(d.m.readRecent()).toEqual(["nginx"]);
  });
  it("a message between agents: the index's copy, with each side's chat to open", async () => {
    const ctx = { doc: { key: "xmsg:xmsg-1:dev", source: "xmsg", instance: "lead", peer: "dev", sender: "lead", ts: T, text: "nginx\nplease fix nginx" }, before: [], after: [], building: false };
    const d = await open({}, (url) => (url.startsWith("/ui/search/context") ? { body: ctx } : { body: { hits, limited: false, building: false } }));
    await d.type("nginx");
    await d.key("ArrowDown"); await d.key("ArrowDown");
    await d.key("Enter"); await settle();
    expect(d.calls.some(u => u === "/ui/search/context?key=xmsg%3Axmsg-1%3Adev")).toBe(true);
    expect(d.onClose).not.toHaveBeenCalled();
    expect(d.doc.querySelector(".search-ctx-line.here .search-ctx-text").textContent).toBe("nginx\nplease fix nginx");
    expect(d.doc.querySelectorAll(".search-ctx-line.here mark").map((x: any) => x.textContent)).toEqual(["nginx", "nginx"]);
    const buttons = d.doc.querySelectorAll(".search-detail-actions .btn");
    expect(buttons.map((b: any) => b.textContent)).toEqual(["Open lead's chat", "Open dev's chat"]);
    fire(buttons[1], "click"); await settle();
    expect([d.onClose.mock.calls.length, location.pathname]).toEqual([1, "/ui/chat/dev"]);
  });
  it("a chat row no longer in the history: the index's copy with its neighbours, said so", async () => {
    const ctx = { doc: { key: "chat:dev:old-2", source: "chat", instance: "dev", sender: "bot", ts: T, text: "nginx restarted" },
      before: [{ key: "b", sender: "han", ts: T - 1, text: "restart it" }], after: [{ key: "a", sender: "han", ts: T + 1, text: "thanks" }] };
    const d = await open({}, (url) => (url.startsWith("/ui/search/context") ? { body: ctx } : { body: { hits, limited: false, building: false } }));
    await d.type("nginx");
    fire(d.doc.querySelectorAll(".search-row")[1], "click"); await settle();
    expect(d.doc.querySelectorAll(".search-ctx-text").map((x: any) => x.textContent)).toEqual(["restart it", "nginx restarted", "thanks"]);
    expect(d.doc.querySelector(".search-detail .search-note")).not.toBeNull();
    // Back to the results, the query kept.
    fire(d.doc.querySelector(".search-detail-head .chip-btn"), "click"); await settle();
    expect([d.doc.querySelectorAll(".search-row").length, d.input.value]).toEqual([4, "nginx"]);
  });
  it("a copy whose answer is not JSON ends as an error, not \"Loading…\" for good (#2298 review)", async () => {
    p = page();
    const m = await load();
    ((await import("/assets/app-nav.js" as string)) as Served).startRouter(window);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.startsWith("/ui/search/context")
      ? { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }
      : { ok: true, status: 200, json: async () => ({ hits, limited: false, building: false }) })));
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    await p.mount(h(m.SearchDialog, { preset: {}, onClose: () => {} }));
    const input: any = (p.document as any).querySelector(".search-input");
    input.value = "nginx"; fire(input, "input"); await new Promise(r => setTimeout(r, m.DEBOUNCE_MS + 20)); await settle();
    fire((p.document as any).querySelectorAll(".search-row")[2], "click"); await settle(); await settle();
    process.off("unhandledRejection", onUnhandled);
    expect((p.document as any).querySelector(".search-detail .search-status.bad").textContent).toBe("Search failed — try again.");
    expect(unhandled).toEqual([]);
  });
  it("Esc (the dialog's cancel) and a click on the backdrop close it; a click inside does not", async () => {
    const d = await open();
    const dlg = d.doc.querySelector("dialog.search-dlg");
    fire(d.doc.querySelector(".search-body"), "click");
    expect(d.onClose).not.toHaveBeenCalled();
    fire(dlg, "cancel", { bubbles: false });
    fire(dlg, "click");
    expect(d.onClose).toHaveBeenCalledTimes(2);
  });
  it("Ctrl+F in a chat: the filters open, narrowed to that agent; the chips narrow the request", async () => {
    const d = await open({ instance: "dev" });
    expect(d.doc.querySelector("#search-filters")).not.toBeNull();
    expect(d.doc.querySelector(".search-filters-toggle").textContent).toBe("Filters (1)");
    await d.type("nginx");
    expect(new URL(d.searches()[0]!, "http://h").searchParams.get("instance")).toBe("dev");
    const chip = d.doc.querySelectorAll(".search-chips .chip-btn").find((b: any) => b.textContent === "Tasks");
    fire(chip, "click"); await new Promise(r => setTimeout(r, d.m.DEBOUNCE_MS + 20)); await settle();
    expect(new URL(d.searches().pop()!, "http://h").searchParams.getAll("source")).toEqual(["chat", "xmsg"]);
  });
  it("answers the server gives: unavailable, busy, still building, limited; nothing found", async () => {
    for (const [status, text] of [[404, "Search is off"], [503, "Search is busy"]] as const) {
      const d = await open({}, () => ({ status, body: { error: "x" } }));
      await d.type("nginx");
      expect(d.doc.querySelector(".search-status.bad").textContent).toContain(text);
      await p!.unmount(); p!.restore(); p = null;
    }
    const d = await open({}, () => ({ body: { hits: [], limited: true, building: true } }));
    await d.type("改");
    const notes = d.doc.querySelectorAll(".search-note").map((n: any) => n.textContent);
    expect(notes.some((n: string) => n.startsWith("Still indexing")) && notes.some((n: string) => n.includes("5,000"))).toBe(true);
    expect(d.doc.querySelector(".search-status").textContent).toBe("Nothing found");
  });
  it("an older query whose body arrives late never replaces a newer one either", async () => {
    let release: (() => void) | null = null;
    p = page();
    const m = await load();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const body = { hits: url.includes("q=old") ? [hits[3]] : [hits[0]], limited: false, building: false };
      return { ok: true, status: 200, json: () => (url.includes("q=old") ? new Promise(r => { release = () => r(body); }) : Promise.resolve(body)) };
    }));
    await p.mount(h(m.SearchDialog, { preset: {}, onClose: () => {} }));
    const input: any = p.document.querySelector(".search-input");
    input.value = "old"; fire(input, "input"); await new Promise(r => setTimeout(r, m.DEBOUNCE_MS + 20));
    input.value = "new"; fire(input, "input"); await new Promise(r => setTimeout(r, m.DEBOUNCE_MS + 20)); await settle();
    release!(); await settle();
    expect((p.document as any).querySelector(".search-badge").textContent).toBe("Chat");
    expect((p.document as any).querySelectorAll(".search-row").length).toBe(1);
  });
  it("the kinds can't all be turned off: the last one on stays on", async () => {
    const d = await open({ instance: "dev" });
    await d.type("nginx");
    const chip = (name: string) => d.doc.querySelectorAll(".search-chips .chip-btn").find((b: any) => b.textContent === name);
    for (const name of ["Chats", "Agent messages", "Tasks"]) { fire(chip(name), "click"); await settle(); }
    expect(["Chats", "Agent messages", "Tasks"].map(n => chip(n).getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
    await new Promise(r => setTimeout(r, d.m.DEBOUNCE_MS + 20)); await settle();
    expect(new URL(d.searches().pop()!, "http://h").searchParams.getAll("source")).toEqual(["task"]);
  });
  it("an older query's late answer (an error) never replaces a newer one", async () => {
    let release: (() => void) | null = null;
    p = page();
    const m = await load();
    vi.stubGlobal("fetch", vi.fn((url: string) => new Promise(r => {
      const body = { hits: url.includes("q=old") ? [hits[3]] : [hits[0]], limited: false, building: false };
      // The old query's answer comes late, and is an error: it must not replace the new results with one.
      if (url.includes("q=old")) release = () => r({ ok: false, status: 503, json: async () => ({}) });
      else r({ ok: true, status: 200, json: async () => body });
    })));
    await p.mount(h(m.SearchDialog, { preset: {}, onClose: () => {} }));
    const input: any = p.document.querySelector(".search-input");
    input.value = "old"; fire(input, "input"); await new Promise(r => setTimeout(r, m.DEBOUNCE_MS + 20));
    input.value = "new"; fire(input, "input"); await new Promise(r => setTimeout(r, m.DEBOUNCE_MS + 20)); await settle();
    release!(); await settle();
    expect((p.document as any).querySelectorAll(".search-row").length).toBe(1);
    expect((p.document as any).querySelector(".search-badge").textContent).toBe("Chat");
  });
});

describe("how it opens", () => {
  it("Ctrl+K anywhere; Ctrl+F only in an agent's chat (elsewhere the browser's find); never over another dialog", async () => {
    p = page({ url: "http://127.0.0.1:19280/ui/fleet" });
    const shell = await import("/assets/app-shell.js" as string) as Served;
    const nav = await import("/assets/app-nav.js" as string) as Served;
    nav.startRouter(window);
    const ev = (key: string, init: Record<string, unknown> = {}) => ({ key, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false, preventDefault: vi.fn(), ...init });
    const f = ev("f"); shell.handleSearchKey(f);
    expect(f.preventDefault).not.toHaveBeenCalled();
    const plain = ev("k", { ctrlKey: false }); shell.handleSearchKey(plain);
    expect(plain.preventDefault).not.toHaveBeenCalled();
    const k = ev("k"); shell.handleSearchKey(k);
    expect(k.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(shell.shellStore.get().dialog?.props?.preset).toEqual({}));
    shell.closeDialog();
    nav.navigate("/ui/chat/dev");
    const inChat = ev("f"); shell.handleSearchKey(inChat);
    expect(inChat.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(shell.shellStore.get().dialog?.props?.preset).toEqual({ instance: "dev" }));
    shell.closeDialog();
    const other: any = p!.document.createElement("dialog"); other.setAttribute("open", ""); p!.document.body.appendChild(other);
    const blocked = ev("k"); shell.handleSearchKey(blocked);
    expect(blocked.preventDefault).not.toHaveBeenCalled();
  });
  it("a guest's page, and the public link kept off (web.search.public_link: false): no shortcut — Ctrl+K and Ctrl+F (in a chat) are left to the browser (#2298 review, #2478)", async () => {
    p = page({ url: "http://127.0.0.1:19280/ui/chat/dev" });
    const shell = await import("/assets/app-shell.js" as string) as Served;
    const nav = await import("/assets/app-nav.js" as string) as Served;
    nav.startRouter(window);
    const ev = (key: string) => ({ key, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false, preventDefault: vi.fn() });
    const body = (p.document as any).body;
    body.dataset.publicLink = "1";
    expect(shell.searchOffered(true), "#2478: the public link offers it by default").toBe(true);
    body.dataset.searchLink = "0";
    for (const k of ["k", "f"]) { const e = ev(k); shell.handleSearchKey(e); expect(e.preventDefault, k).not.toHaveBeenCalled(); }
    expect(shell.searchOffered(true)).toBe(false);
    delete body.dataset.publicLink; delete body.dataset.searchLink;
    body.dataset.tier = "guest";
    const g = ev("k"); shell.handleSearchKey(g);
    expect(g.preventDefault).not.toHaveBeenCalled();
    delete body.dataset.tier;
    expect([shell.searchOffered(true), shell.searchOffered(false)]).toEqual([true, false]);
    shell.closeDialog();
  });
  it("the sidebar's Search row (with its shortcut) on an admin's page — opens search; over the public link too (#2478), not when kept off there", async () => {
    for (const [onLink, keptOff] of [[false, false], [true, false], [true, true]]) {
      p = page({ url: "http://127.0.0.1:19280/ui/chat/dev", storage: { agend_tour_done: "1" } });
      if (onLink) (p.document as any).body.dataset.publicLink = "1";
      if (keptOff) (p.document as any).body.dataset.searchLink = "0";
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })));
      (window as any).AgendAuth = { canWrite: () => true, onSessionEnd() {}, sessionEnded: () => false };
      const nav = await import("/assets/app-nav.js" as string) as Served;
      const store = await import("/assets/app-store.js" as string) as Served;
      const shell = await import("/assets/app-shell.js" as string) as Served;
      store.appStore.set({ viewOnly: false });
      nav.startRouter(window);
      store.applyStatus({ instances: [{ name: "dev", status: "running", backend: "claude-code" }] });
      await p.mount(h(shell.Shell, { panels: new Map([["chat", { Component: () => h("div", null, "chat") }]]), onNewInstance() {}, viewOnly: false }));
      await settle();
      const row = (p.document as any).querySelector("#sidebar .side-nav .side-search");
      expect([onLink, keptOff, !!row]).toEqual([onLink, keptOff, !keptOff]);
      if (row) {
        expect(row.textContent).toMatch(/Search\s*Ctrl K$/);
        fire(row, "click");
        await vi.waitFor(() => expect(shell.shellStore.get().dialog?.props?.preset).toEqual({}));
        shell.closeDialog();
      }
      delete (window as any).AgendAuth;
      await p.unmount(); p.restore(); p = null;
    }
  });
  it("the header's search button: an admin's page — over the public link too (#2478), not when kept off there", async () => {
    const shell = await import("/assets/app-shell.js" as string) as Served;
    for (const [onLink, keptOff] of [[false, false], [true, false], [true, true]]) {
      p = page({ url: "http://127.0.0.1:19280/ui/fleet" });
      if (onLink) (p.document as any).body.dataset.publicLink = "1";
      if (keptOff) (p.document as any).body.dataset.searchLink = "0";
      (window as any).AgendAuth = { canWrite: () => true, onSessionEnd() {}, sessionEnded: () => false };
      await p.mount(h(shell.PanelHeader, { title: "Fleet" }));
      await settle();
      expect([onLink, keptOff, !!(p.document as any).querySelector(".sb-search")]).toEqual([onLink, keptOff, !keptOff]);
      delete (window as any).AgendAuth;
      await p.unmount(); p.restore(); p = null;
    }
  });
  it("the chat follows a #m= change to its own address only (search opening a message of the chat on screen)", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../src/ui/panel-chat.js", import.meta.url), "utf8");
    expect(src).toMatch(/addEventListener\("hashchange", onHash\)/);
    expect(src).toMatch(/removeEventListener\("hashchange", onHash\)/);
    expect(src).toMatch(/location\.pathname === `\/ui\/chat\/\$\{encodeURIComponent\(name\)\}`/);
  });
});
