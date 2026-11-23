/**
 * M-3533 R1-page (docs/design/hub-office-visit.md §2.1, §2.2, §2.4): a room's office on its page.
 * - Desktop: Chat | Office in the header just before its tools; the office fills the content area — no purpose card, no
 *   message box; Chat returns. A phone: no tabs, Office first in ⋯, the header's second line says Office, back returns.
 * - Off (or a Hub that does not serve it): no tabs, no menu item. A first read that fails says so with a retry.
 * - The drawing's input: each agent named as members see it (never its member id), in the member list's words, answering
 *   here as the more specific 處理中; its card the owner and introduction; its reads answered from the room's state only.
 * - Room settings: the Room office switch, managers only; the line a change posts, in the viewer's words.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { createHubRoomsFixture } from "./support/hub-rooms-fixture.js";

let client: any, shell: any, store: any, router: any, i18n: any, hubPanel: any, thread: any, office: any, settings: any;
const mounted: AppPage[] = [];
const g = globalThis as any;
const until = async (fn: () => unknown, n = 300) => { for (let i = 0; i < n && !fn(); i++) await settle(5); };
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  store = await import("/assets/app-store.js"); router = await import("/assets/app-nav.js"); shell = await import("/assets/app-shell.js");
  i18n = await import("/assets/app-i18n.js"); client = await import("/ui/js/hub-client.js"); hubPanel = await import("/ui/js/panel-hub.js");
  thread = await import("/ui/js/hub-room-thread.js"); office = await import("/ui/js/hub-room-office.js"); settings = await import("/ui/js/hub-room-settings.js");
  pg.restore();
});
const realES = g.EventSource;
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); i18n.setLang("en", { store: false }); g.EventSource = realES; vi.restoreAllMocks(); });

const STATE = (ids: string[]) => ({
  instances: [
    { name: ids[0], display_name: "Notes", status: "running", execution_state: "working", presence: "idle", answering: true },
    { name: ids[1], display_name: "Notes", status: "running", execution_state: "idle", presence: "idle" },
    { name: "assistant", display_name: "Hub assistant", status: "running", execution_state: "idle", presence: "idle", assistant: true },
  ],
  org: { general: [], teams: [], instances: {} }, needs: [], traffic: { now: new Date().toISOString(), items: [], delegations: [] }, text: false, office: "room",
  offices: { rev: 0, readable: true, offices: [{ id: "room", name: "Weekly", skin: "studio", members: [...ids, "assistant"] }] },
});

/** The weekly room of the rooms fixture, its office on (or not), its state answered by `answer` (status, body). */
async function roomPage(opts: { on?: boolean; narrow?: boolean; lang?: string; answer?: () => { status: number; body: unknown } } = {}) {
  const fx = createHubRoomsFixture(), realFetch = g.fetch, room = fx.rooms.find((r: any) => r.id === "room-weekly")! as any;
  if (opts.on !== false) room.settings.office = { enabled: true, style: "studio" };
  const reads: string[] = [];
  const answer = opts.answer ?? (() => ({ status: 200, body: STATE(room.members.filter((m: any) => m.kind === "agent").slice(0, 2).map((m: any) => m.id)) }));
  g.fetch = async (url: string, init?: any) => {
    if (/\/hub\/v1\/rooms\/room-weekly\/office\/state$/.test(String(url))) {
      reads.push(String(url)); const a = answer();
      return { ok: a.status === 200, status: a.status, headers: { get: () => "application/json" }, json: async () => a.body, text: async () => JSON.stringify(a.body) };
    }
    return fx.fetch(url, init);
  };
  g.EventSource = fx.EventSource;
  const pg = page({ url: "http://127.0.0.1:19280/ui/hub?room=room-weekly", storage: { agend_tour_done: "1" }, ...(opts.narrow ? { matchNarrow: true } : {}) });
  pg.document.body.setAttribute("data-hub", "hub"); pg.document.body.setAttribute("data-hub-name", "Team Hub"); mounted.push(pg);
  i18n.setLang(opts.lang ?? "en", { store: false });
  client.setHubClient(client.createHubWebClient()); hubPanel.resetHubSession(); router.startRouter(pg.window); store.applyStatus({ instances: [] });
  await pg.mount(h(shell.Shell, { panels: new Map([["hub", { Component: hubPanel.HubPanel || (() => null) }]]), onNewInstance() {} }));
  await until(() => pg.root.querySelectorAll(".hub-room-page .thread .msg").length > 5);
  return { pg, fx, room, reads, restore: () => { g.fetch = realFetch; } };
}
const q = (pg: AppPage, s: string) => pg.root.querySelector(s) as any;
const openMenu = async (pg: AppPage) => { fire(q(pg, ".hub-room-menu button"), "click"); await settle(); return [...pg.root.querySelectorAll("[role=menuitem], [role=menuitemcheckbox]")] as any[]; };

describe("the drawing's input (pure)", () => {
  it("names each agent as members see it, agents of one name by their owner, and keeps its member id", () => {
    const members = [{ kind: "agent", id: "e1", owner: { name: "Alex Sample" } }, { kind: "agent", id: "e2", owner: { name: "Casey Sample" } }];
    i18n.setLang("zh-TW", { store: false });
    const d = office.named(STATE(["e1", "e2"]), members);
    expect(d.instances.map((i: any) => [i.name, i.display_name, i.member])).toEqual([["Notes（Alex Sample）", "Notes（Alex Sample）", "e1"], ["Notes（Casey Sample）", "Notes（Casey Sample）", "e2"], ["房間助理", "房間助理", "assistant"]]);
    expect(d.offices.offices[0].members).toEqual(["Notes（Alex Sample）", "Notes（Casey Sample）", "房間助理"]);
    expect(JSON.stringify(d.instances.map((i: any) => [i.name, i.display_name]))).not.toMatch(/e1|e2/);
    i18n.setLang("en", { store: false });
    expect(office.named(STATE(["e1", "e2"]), members).instances.map((i: any) => i.name)).toEqual(["Notes (Alex Sample)", "Notes (Casey Sample)", "Room assistant"]);
    // A unique name stays bare; too long with the owner: the owner's first word.
    const long = [{ kind: "agent", id: "e1", owner: { name: "Alexandra Samplesworth" } }, { kind: "agent", id: "e2", owner: { name: "Casey Sample" } }];
    expect(office.named(STATE(["e1", "e2"]), long).instances.map((i: any) => i.name).slice(0, 2)).toEqual(["Notes (Alexandra)", "Notes (Casey Sample)"]);
    // One owner's two agents of one name (or no owner known) are still never merged into one figure.
    const same = office.named(STATE(["e1", "e2"]), [{ kind: "agent", id: "e1", owner: { name: "Alex" } }, { kind: "agent", id: "e2", owner: { name: "Alex" } }]);
    expect(new Set(same.instances.map((i: any) => i.name)).size).toBe(3);
    expect(new Set(office.named(STATE(["e1", "e2"])).instances.map((i: any) => i.name)).size).toBe(3);
  });
  it("words every state as the member list does; answering here is 處理中 doing what it does now", () => {
    i18n.setLang("zh-TW", { store: false });
    const w = (i: any, members: any[] = []) => office.officeWords({ i: { name: "Notes", member: "e1", ...i } }, members);
    expect(w({ presence: "working" })).toEqual({ state: "處理中", now: "" });
    expect(w({ presence: "idle" })).toEqual({ state: "待命", now: "" });
    expect(w({ presence: "paused" })).toEqual({ state: "暫停", now: "" });
    expect(w({ presence: "offline" })).toEqual({ state: "離線", now: "" });
    expect(w({ presence: "later" })).toEqual({ state: "上線時回答", now: "" });
    expect(w({ presence: "idle", answering: true })).toEqual({ state: "處理中", now: "正在回答這個房間的問題" });
    // The list's own reason while it says the same presence (a paused agent out of quota), not a stale one.
    const list = [{ kind: "agent", id: "e1", presence: "offline", presenceReason: "update" }];
    expect(w({ presence: "offline" }, list)).toEqual({ state: "需要更新 AgEnD", now: "" });
    expect(w({ presence: "idle" }, list)).toEqual({ state: "待命", now: "" });
    expect(office.officeWords({ i: { name: "房間助理", member: "assistant", assistant: true, presence: "paused" } }, []).state).toBe("暫時無法回答");
  });
  it("a card's rows: owner and introduction from the room's members; the assistant provided by the Hub", () => {
    i18n.setLang("en", { store: false });
    const members = [{ kind: "agent", id: "e1", owner: { name: "Example owner" }, intro: "Answers release questions." }];
    expect(office.officeCardRows(members, "e1")).toEqual([{ key: "owner", label: "Owner", value: "Example owner" }, { key: "intro", label: "Introduction", value: "Answers release questions." }]);
    expect(office.officeCardRows(members, "assistant")).toEqual([{ key: "owner", label: "Owner", value: "Provided by the Hub" }]);
    expect(office.officeCardRows(members, "gone")).toEqual([]);
  });
  it("answers the drawing's reads from the room's state only: its one office, no acts, no packs; nothing else, no writes", async () => {
    const d = office.named(STATE(["e1", "e2"])), reads = office.officeReads(() => d);
    expect(await (await reads("/ui/offices")).json()).toEqual(d.offices);
    expect((await (await reads("/ui/office-acts")).json()).acts).toEqual([]);
    expect(await (await reads("/ui/office-skins")).json()).toEqual({ rev: "", packs: [] });
    for (const p of ["/ui/office-levels", "/ui/office-skins/x", "/ui/status", "/api/settings"]) expect((await reads(p)).status, p).toBe(404);
    expect((await reads("/ui/offices", { method: "PUT", body: "{}" })).status).toBe(404);
  });
  it("keeps this browser's choices apart from the Fleet office's", () => {
    const base = new Map<string, string>(), ls = { getItem: (k: string) => base.get(k) ?? null, setItem: (k: string, v: string) => void base.set(k, v), removeItem: (k: string) => void base.delete(k) };
    const s = office.roomOfficeStorage(ls); s.setItem("agend_org_office", "room");
    expect([...base.keys()]).toEqual(["agend_hub_room_office:agend_org_office"]); expect(s.getItem("agend_org_office")).toBe("room");
  });
});

describe("the room page", () => {
  it("desktop: Chat | Office before the header's tools; the office has no purpose card and no message box; Chat returns", async () => {
    const { pg, reads, room, restore } = await roomPage();
    try {
      const agentNames = room.members.filter((m: any) => m.kind === "agent").slice(0, 2).map((m: any) => `@${m.name} `);
      const tabs = q(pg, ".hub-chat-head .hub-room-tabs");
      expect([...tabs.querySelectorAll(".seg-item")].map((a: any) => [a.textContent, a.classList.contains("active")])).toEqual([["Chat", true], ["Office", false]]);
      const head = [...q(pg, ".hub-chat-head").children].map((e: any) => e.className); expect(head.indexOf("hub-head-tools") - head.findIndex((c: string) => c.includes("hub-room-tabs"))).toBe(1);
      expect([!!q(pg, ".hub-dock"), !!q(pg, ".hub-room-office")]).toEqual([true, false]);
      // On the Fleet dashboard's own origin an admin session may edit the fleet's offices, and the page has the fleet's
      // stream: the room's office edits nothing and listens to none of it.
      const heard: string[] = [], realAuth = g.AgendAuth;
      g.AgendAuth = { canWrite: async () => true };
      store.appStore.set((st: any) => ({ ...st, streamOn: (kind: string) => { heard.push(kind); return () => {}; } }));
      fire(tabs.querySelectorAll(".seg-item")[1], "click"); await until(() => q(pg, ".hub-room-office .oo")); await settle(30);
      g.AgendAuth = realAuth;
      expect(heard.filter((k) => /office|message/.test(k))).toEqual([]);
      expect([!!q(pg, ".hub-room-office .oo-edit"), !!q(pg, ".hub-room-office .oo-layout")]).toEqual([false, false]);
      expect(pg.window.location.search).toContain("view=office");
      expect([!!q(pg, ".hub-room-office .oo"), !!q(pg, ".hub-dock"), !!q(pg, ".hub-room-card"), !!q(pg, ".hub-room-page .thread"), !!q(pg, ".hub-room-office select.oo-office"), !!q(pg, ".hub-room-office .oo-edit")])
        .toEqual([true, false, false, false, false, false]);
      expect(reads.length).toBeGreaterThan(0);
      const desks = [...pg.root.querySelectorAll(".hub-room-office .oo-desk")].map((e: any) => e.getAttribute("aria-label"));
      expect(desks.join(" ")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(desks.some((l: string) => /^Notes \(.+\) — Working/.test(l) && l.includes("Answering a question in this room"))).toBe(true);
      // The card's "@ it": back to Chat with the mention in the box.
      const desk = [...pg.root.querySelectorAll(".hub-room-office .oo-desk")].find((e: any) => /^Notes/.test(e.textContent)) as any;
      fire(desk, "click"); await until(() => q(pg, ".oo-card-action"));
      expect([q(pg, ".oo-card-action").textContent, q(pg, ".oo-card-action").getAttribute("aria-label")]).toEqual(["@ it", `Ask ${desk.textContent} in the chat`]);
      fire(q(pg, ".oo-card-action"), "click"); await until(() => q(pg, ".hub-dock textarea")?.value);
      expect([!!q(pg, ".hub-room-office"), pg.window.location.search.includes("view=office"), q(pg, ".hub-dock textarea").value]).toEqual([false, false, expect.any(String)]);
      // The member list's own name for it (what the composer resolves), not the office's label.
      expect(agentNames).toContain(q(pg, ".hub-dock textarea").value);
      fire(pg.root.querySelectorAll(".hub-room-tabs .seg-item")[1], "click"); await until(() => q(pg, ".hub-room-office .oo"));
      fire(q(pg, ".hub-room-tabs .seg-item"), "click"); await until(() => q(pg, ".hub-dock"));
      expect([!!q(pg, ".hub-dock"), !!q(pg, ".hub-room-office"), pg.window.location.search.includes("view=office")]).toEqual([true, false, false]);
    } finally { restore(); }
  });
  it("off, or a Hub that does not serve it: no tabs and no menu item; a view=office address shows the chat", async () => {
    const { pg, reads, restore } = await roomPage({ on: false });
    try {
      expect(q(pg, ".hub-room-tabs")).toBeNull();
      expect((await openMenu(pg)).map((b) => b.textContent.trim())).not.toContain("Office");
      expect([!!q(pg, ".hub-dock"), reads]).toEqual([true, []]);
    } finally { restore(); }
  });
  it("a first read that fails says so in plain words with a retry, and Chat still works", async () => {
    let status = 503;
    const { pg, restore } = await roomPage({ answer: () => (status === 200 ? { status, body: STATE(["e1", "e2"]) } : { status, body: { code: "unavailable" } }) });
    try {
      fire(pg.root.querySelectorAll(".hub-room-tabs .seg-item")[1], "click");
      await until(() => q(pg, ".hub-room-office .error-state"));
      expect(q(pg, ".hub-room-office .error-state p").textContent).toBe("Can't load the office right now. The chat still works.");
      status = 200; fire(q(pg, ".hub-room-office .error-state button"), "click"); await until(() => q(pg, ".hub-room-office .oo"));
      expect(!!q(pg, ".hub-room-office .oo")).toBe(true);
      fire(q(pg, ".hub-room-tabs .seg-item"), "click"); await until(() => q(pg, ".hub-dock"));
      expect(!!q(pg, ".hub-room-page .hub-dock")).toBe(true);
    } finally { restore(); }
  });
  it("a phone (zh-TW): no tabs; 辦公室 first in ⋯; in the office the header says 辦公室 and back returns to the chat", async () => {
    const { pg, restore } = await roomPage({ narrow: true, lang: "zh-TW" });
    try {
      expect(q(pg, ".hub-room-tabs")).toBeNull();
      const items = await openMenu(pg);
      expect(items[0].textContent.trim()).toBe("辦公室");
      fire(items[0], "click"); await until(() => q(pg, ".hub-room-office .oo"));
      expect(q(pg, ".hub-chat-title .s").textContent).toBe("辦公室");
      // The office's options are one sheet, not rows over the scene: none until 辦公室選項 in ⋯ opens it.
      expect([!!q(pg, ".hub-room-office .oo.phone"), !!q(pg, ".hub-room-office .oo-bar"), !!q(pg, ".oo-sheet")]).toEqual([true, false, false]);
      const inOffice = await openMenu(pg);
      expect(inOffice.map((b) => b.textContent.trim())).not.toContain("辦公室");
      fire(inOffice.find((b) => b.textContent.trim() === "辦公室選項"), "click"); await until(() => q(pg, ".oo-sheet .oo-hide-asleep"));
      expect(!!q(pg, ".oo-sheet .oo-sheet-bar .oo-hide-asleep")).toBe(true);
      fire(q(pg, ".oo-sheet .oo-sheet-fit"), "click"); await until(() => !q(pg, ".oo-sheet"));
      fire(q(pg, ".hub-back"), "click"); await until(() => q(pg, ".hub-dock"));
      expect([!!q(pg, ".hub-room-office"), q(pg, ".hub-chat-title .s").textContent.includes("辦公室")]).toEqual([false, false]);
    } finally { restore(); }
  });
});

describe("an office read that keeps failing", () => {
  it("one or two misses keep the picture silently; the third says it may be old; the next good read clears it", async () => {
    const p = page(); mounted.push(p); i18n.setLang("zh-TW", { store: false });
    let fail = false, reads = 0;
    const roomOfficeState = async () => { reads++; return fail ? { ok: false, status: 503, code: "unavailable" } : { ok: true, ...STATE(["e1", "e2"]) }; };
    await p.mount(h(office.RoomOffice, { client: { roomOfficeState }, roomId: "room", members: [], pollMs: 15 }));
    await until(() => q(p, ".hub-room-office .oo"));
    fail = true; const at = reads; await until(() => reads >= at + 2); await settle(2);
    expect([!!q(p, ".hub-room-office .oo"), q(p, ".hub-room-office-stale")]).toEqual([true, null]);
    await until(() => q(p, ".hub-room-office-stale"));
    expect([q(p, ".hub-room-office-stale").textContent, q(p, ".hub-room-office-stale").getAttribute("role"), reads - at >= 3, !!q(p, ".hub-room-office .oo")]).toEqual(["畫面可能不是最新，正在重新連線…", "status", true, true]);
    fail = false; await until(() => !q(p, ".hub-room-office-stale"));
    expect(q(p, ".hub-room-office-stale")).toBeNull();
  });
});

describe("Room settings and the line", () => {
  it("the Room office switch, when the Hub serves it; a change is one PATCH, put back when refused", async () => {
    const p = page(); mounted.push(p); i18n.setLang("zh-TW", { store: false });
    const update = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce({ ok: true });
    const detail = (on: boolean | undefined) => ({ room: { id: "room", name: "Room", kind: "group" }, me: { id: "m", role: "manager" }, members: [],
      settings: { allMention: true, historyForNew: "since-join", ...(on === undefined ? {} : { office: { enabled: on, style: "studio" } }) } });
    await p.mount(h(settings.RoomSettings, { client: { roomOfficeV1: true, updateRoom: update }, roomId: "room", detail: detail(true), assistant: false })); await settle();
    const sw = q(p, "#hubRoomOffice");
    expect([q(p, ".hub-room-office-settings h4").textContent, sw.closest("label").textContent.trim(), sw.checked]).toEqual(["房間辦公室", "顯示房間辦公室", true]);
    sw.checked = false; fire(sw, "change"); await settle(20);
    expect(update).toHaveBeenLastCalledWith("room", { office: { enabled: false } }); expect(q(p, "#hubRoomOffice").checked).toBe(true);
    q(p, "#hubRoomOffice").checked = false; fire(q(p, "#hubRoomOffice"), "change"); await settle(20); expect(q(p, "#hubRoomOffice").checked).toBe(false);
    await p.mount(h(settings.RoomSettings, { client: { updateRoom: update }, roomId: "room", detail: detail(true), assistant: false })); await settle();
    expect(q(p, "#hubRoomOffice")).toBeNull();
    await p.mount(h(settings.RoomSettings, { client: { roomOfficeV1: true, updateRoom: update }, roomId: "room", detail: detail(undefined), assistant: false })); await settle();
    expect(q(p, "#hubRoomOffice")).toBeNull();
  });
  it.each([["en", "Owner turned the room office on.", "Owner turned the room office off."], ["zh-TW", "Owner 開啟了房間辦公室。", "Owner 關閉了房間辦公室。"]])("the line in the viewer's words (%s)", (lang, on, off) => {
    i18n.setLang(lang, { store: false });
    expect(thread.systemText({ system: { kind: "office-changed", name: "Owner", enabled: true }, text: "x" })).toBe(on);
    expect(thread.systemText({ system: { kind: "office-changed", name: "Owner", enabled: false }, text: "x" })).toBe(off);
    expect(thread.systemText({ system: { kind: "office-changed", name: "Owner" }, text: "stored" })).toBe("stored");
  });
});
