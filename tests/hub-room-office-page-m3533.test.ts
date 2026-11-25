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
async function roomPage(opts: { on?: boolean; narrow?: boolean; lang?: string; sameName?: boolean; canAsk?: number[]; answer?: () => { status: number; body: unknown } } = {}) {
  const fx = createHubRoomsFixture(), realFetch = g.fetch, room = fx.rooms.find((r: any) => r.id === "room-weekly")! as any;
  if (opts.on !== false) room.settings.office = { enabled: true, style: "studio" };
  // M-3565: the viewer may ask the office's first agent (a who-may-ask grant), and has no one-to-one with it yet.
  const asked: any[] = [];
  const askable = (opts.canAsk || []).map((i) => room.members.filter((m: any) => m.kind === "agent")[i]);
  for (const m of askable) m.canAsk = true;
  // Two agents of one name (of different owners), as the office's first two.
  if (opts.sameName) { const two = room.members.filter((m: any) => m.kind === "agent").slice(0, 2); two[1].name = two[0].name; }
  const reads: string[] = [], posts: any[] = [];
  const answer = opts.answer ?? (() => ({ status: 200, body: STATE(room.members.filter((m: any) => m.kind === "agent").slice(0, 2).map((m: any) => m.id)) }));
  g.fetch = async (url: string, init?: any) => {
    if (/\/hub\/v1\/rooms\/room-weekly\/office\/state$/.test(String(url))) {
      reads.push(String(url)); const a = answer();
      return { ok: a.status === 200, status: a.status, headers: { get: () => "application/json" }, json: async () => a.body, text: async () => JSON.stringify(a.body) };
    }
    if (/\/hub\/v1\/rooms\/room-weekly\/messages$/.test(String(url)) && String(init?.method).toUpperCase() === "POST") posts.push(JSON.parse(String(init.body)));
    if (askable.length) {
      const json = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => body, text: async () => JSON.stringify(body) });
      if (/\/hub\/v1\/exposures$/.test(String(url)) && String(init?.method || "GET").toUpperCase() === "GET")
        return json({ mine: [], askable: askable.map((m: any) => ({ exposure: { id: m.id, revision: 1, displayName: m.name }, grant: { id: `grant-${m.id}` }, ownerName: "Alex Sample" })) });
      if (/\/hub\/v1\/rooms$/.test(String(url)) && String(init?.method).toUpperCase() === "POST") {
        const body = JSON.parse(String(init.body)); if (body.exposureId) { asked.push(body); return json({ ok: true, room: { id: "room-direct-m3565" } }); }
      }
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
  return { pg, fx, room, reads, posts, asked, restore: () => { g.fetch = realFetch; } };
}
const q = (pg: AppPage, s: string) => pg.root.querySelector(s) as any;
/** The message box shown (in the office it stays mounted, hidden, with its draft). */
const docked = (pg: AppPage) => { const d = q(pg, ".hub-dock"); return !!d && !d.hasAttribute("hidden"); };
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
    // The owner part also rides beside the label, for the office's tag (#4379 review); a unique name has none.
    expect(office.named(STATE(["e1", "e2"]), members).instances.map((i: any) => i.tag_fit ?? null)).toEqual([{ owner: [" (", "Alex Sample", ")"] }, { owner: [" (", "Casey Sample", ")"] }, { short: "Assistant" }]);
    // A unique name stays bare; too long with the owner: the owner's first word.
    const long = [{ kind: "agent", id: "e1", owner: { name: "Alexandra Samplesworth" } }, { kind: "agent", id: "e2", owner: { name: "Casey Sample" } }];
    expect(office.named(STATE(["e1", "e2"]), long).instances.map((i: any) => i.name).slice(0, 2)).toEqual(["Notes (Alexandra)", "Notes (Casey Sample)"]);
    // One owner's two agents of one name (or no owner known) are still never merged into one figure.
    const same = office.named(STATE(["e1", "e2"]), [{ kind: "agent", id: "e1", owner: { name: "Alex" } }, { kind: "agent", id: "e2", owner: { name: "Alex" } }]);
    expect(new Set(same.instances.map((i: any) => i.name)).size).toBe(3);
    expect(new Set(office.named(STATE(["e1", "e2"])).instances.map((i: any) => i.name)).size).toBe(3);
  });
  // #4379 review: a tag too narrow for "Atlas（Alex Sample）" cut the owner ("Atlas（Al…"), the only thing telling the two
  // Atlases apart. With its owner part, the tag keeps the owner and cuts the name; then the owner's first word, then its
  // first character; never wider than its width (#4376's places hold). Without one (a Fleet name), cut at its end as before.
  it("a tag keeps the owner and cuts the name; never wider than its width; a name with no owner part is cut at its end", async () => {
    const { fitText, tagBox } = await import("/ui/js/fleet-office-skin.js");
    const ctx = { save() {}, restore() {}, font: "", measureText: (t: string) => ({ width: [...t].length * 6 }) };   // 6 per character
    const fit = (s: string, max: number, f: any = null) => { const t = fitText(ctx, s, max, f); expect(t.length * 6, `${t} within ${max}`).toBeLessThanOrEqual(max); return t; };
    const zh = { owner: ["（", "Alex Sample", "）"] }, en = { owner: [" (", "Alex Sample", ")"] };
    expect(fit("Atlas（Alex Sample）", 200, zh)).toBe("Atlas（Alex Sample）");     // fits: as it is
    expect(fit("Atlas（Alex Sample）", 84, zh)).toBe("Atlas（Alex）");             // the whole name, the owner's first word
    expect(fit("Atlas（Alex Sample）", 60, zh)).toBe("Atl…（Alex）");             // a cut name, the owner's word kept
    expect(fit("Atlas（Alex Sample）", 48, zh)).toBe("A…（Alex）");               // the owner's word before the name's length
    expect(fit("Atlas (Alex Sample)", 48, en)).toBe("Atl… (A)");                   // narrower than that: the owner's initial
    expect(fit("Atlas（Alex Sample）", 84)).toBe("Atlas（Alex Sa…");                   // no owner part: cut at its end, as before
    expect(fit("Build bot (staging area)", 60)).toBe("Build bot…");
    expect(fit("Atlas（Alex Sample）", 84, { owner: ["（", "Casey", "）"] })).toBe("Atlas（Alex Sa…");
    // #4379 review: two owners of one first word ("Alex A", "Alex B"): the whole owner with the name cut, never two
    // identical "Longer (Alex)" tags where a cut name with each whole owner fits.
    const pair = ["Alex A", "Alex B"].map((o) => fit(`Longer (${o})`, 84, { owner: [" (", o, ")"] }));
    expect(pair).toEqual(["Long… (Alex A)", "Long… (Alex B)"]);
    expect(new Set(pair).size).toBe(2);  // an owner that is not the label's end: ignored
    // The whole name with the owner's word cut, before only its initial; the room assistant's shorter word.
    expect(fit("Atlas (Morganstern Lee)", 90, { owner: [" (", "Morganstern Lee", ")"] })).toBe("Atlas (Morgan…)");
    expect(fit("Room assistant", 60, { short: "Assistant" })).toBe("Assistant");
    expect(fit("Room assistant", 40, { short: "Assistant" })).toBe("Room …");               // the short word too long: cut at its end, as before
    // The tag's own box takes the same text, so the places measured from it (#4376) are the drawn tag's.
    expect(tagBox(ctx, 100, 50, "Atlas（Alex Sample）", false, zh).text).toBe("Atlas（Alex）");
    expect(tagBox(ctx, 100, 50, "Atlas（Alex Sample）", true, zh).text).toBe("A…（Alex）");
    // And what the tag itself paints, from the look's owner part (fleet-office.js looksOf → look.tail).
    const { pixelSkin, DEFAULT_PAL } = await import("/ui/js/fleet-office-skin.js");
    const painted: string[] = [];
    const g = new Proxy({ ...ctx, fillText: (t: string) => { painted.push(t); } } as any, { get(o, k) { return k in o ? o[k] : () => {}; }, set(o, k, v) { o[k] = v; return true; } });
    pixelSkin.drawTag(g, 100, 50, { label: "Atlas（Alex Sample）", fit: zh }, { pal: { ...DEFAULT_PAL }, mode: "light" }, true);
    expect(painted).toContain("A…（Alex）");
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
      expect([docked(pg), !!q(pg, ".hub-room-office")]).toEqual([true, false]);
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
      expect([!!q(pg, ".hub-room-office .oo"), docked(pg), !!q(pg, ".hub-room-card"), !!q(pg, ".hub-room-page .thread"), !!q(pg, ".hub-room-office select.oo-office"), !!q(pg, ".hub-room-office .oo-edit")])
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
      fire(q(pg, ".hub-room-tabs .seg-item"), "click"); await until(() => docked(pg));
      expect([docked(pg), !!q(pg, ".hub-room-office"), pg.window.location.search.includes("view=office")]).toEqual([true, false, false]);
    } finally { restore(); }
  });
  it("desktop: no options row over the scene; the zoom stack's gear opens Display options, the Fleet office's dropdown (#4370, M-3556)", async () => {
    const { pg, restore } = await roomPage();
    try {
      fire(pg.root.querySelectorAll(".hub-room-tabs .seg-item")[1], "click"); await until(() => q(pg, ".hub-room-office .oo"));
      expect([q(pg, ".hub-room-office .oo > .oo-bar"), !!q(pg, ".hub-room-office .oo-zoom .oo-options")]).toEqual([null, true]);
      fire(q(pg, ".oo-zoom .oo-options"), "click"); await until(() => q(pg, ".oo-display-pop .oo-hide-asleep"));
      // The options and the key, in the dropdown beside the gear — no sheet, no office picker, actions or style.
      expect([!!q(pg, ".oo-zoom .oo-display-pop .oo-hide-asleep"), !!q(pg, ".oo-display-pop .oo-key-tick"), q(pg, ".oo-sheet"), q(pg, ".oo-display-pop .oo-style"),
        q(pg, ".oo-display-pop .oo-office"), q(pg, ".oo-edit"), q(pg, ".oo-share")]).toEqual([true, true, null, null, null, null, null]);
      expect(q(pg, ".oo-zoom .oo-options").getAttribute("aria-expanded")).toBe("true");
      expect(q(pg, ".oo-display-pop .oo-display-h").textContent.trim()).toBe(q(pg, ".oo-zoom .oo-options").getAttribute("aria-label"));   // labelled when open
      // The room page keeps the state: Escape (from a focused tick) closes it and hands focus back to the gear.
      q(pg, ".oo-display-pop .oo-dialogue input").focus();
      fire(pg.document as any, "keydown", { key: "Escape" }); await until(() => !q(pg, ".oo-display-pop"));
      expect(q(pg, ".oo-zoom .oo-options").getAttribute("aria-expanded")).toBe("false");
      expect(pg.document.activeElement).toBe(q(pg, ".oo-zoom .oo-options"));
    } finally { restore(); }
  });
  it("a draft in the box is still there after a look at the office", async () => {
    const { pg, restore } = await roomPage();
    try {
      const box = q(pg, ".hub-dock textarea"); box.value = "half a question"; box.selectionStart = box.value.length; fire(box, "input"); await settle(3);
      fire(pg.root.querySelectorAll(".hub-room-tabs .seg-item")[1], "click"); await until(() => q(pg, ".hub-room-office .oo"));
      expect(docked(pg)).toBe(false);
      fire(q(pg, ".hub-room-tabs .seg-item"), "click"); await until(() => docked(pg));
      expect(q(pg, ".hub-dock textarea").value).toBe("half a question");
    } finally { restore(); }
  });
  it("off, or a Hub that does not serve it: no tabs and no menu item; a view=office address shows the chat", async () => {
    const { pg, reads, restore } = await roomPage({ on: false });
    try {
      expect(q(pg, ".hub-room-tabs")).toBeNull();
      expect((await openMenu(pg)).map((b) => b.textContent.trim())).not.toContain("Office");
      expect([docked(pg), reads]).toEqual([true, []]);
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
      fire(q(pg, ".hub-room-tabs .seg-item"), "click"); await until(() => docked(pg));
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
      fire(q(pg, ".hub-back"), "click"); await until(() => docked(pg));
      expect([!!q(pg, ".hub-room-office"), q(pg, ".hub-chat-title .s").textContent.includes("辦公室")]).toEqual([false, false]);
    } finally { restore(); }
  });
});

describe("the zoom controls' names are words, never string keys (M-3695)", () => {
  // The Hub serves only the Office's own modules: the org chart canvas (fleet-canvas.js, the "orgc" words) is not one.
  const open = async (narrow: boolean, lang: string) => {
    const r = await roomPage({ narrow, lang });
    if (narrow) { const items = await openMenu(r.pg); fire(items[0], "click"); }
    else fire(r.pg.root.querySelectorAll(".hub-room-tabs .seg-item")[1], "click");
    await until(() => q(r.pg, ".hub-room-office .oo-zoom-in"));
    return r;
  };
  for (const [narrow, lang, words] of [
    [false, "en", ["View", "Zoom in", "Zoom out"]], [false, "zh-TW", ["檢視", "放大", "縮小"]],
    [true, "en", ["View", "Zoom in", "Zoom out"]], [true, "zh-TW", ["檢視", "放大", "縮小"]],
  ] as const) {
    it(`${narrow ? "a phone" : "desktop"} (${lang}): ${words.join(" / ")}`, async () => {
      const { pg, restore } = await open(narrow, lang);
      try {
        const zin = q(pg, ".hub-room-office .oo-zoom-in"), zout = q(pg, ".hub-room-office .oo-zoom-out");
        expect([q(pg, ".hub-room-office .oo-zoom").getAttribute("aria-label"), zin.getAttribute("aria-label"), zout.getAttribute("aria-label")]).toEqual(words);
        expect([zin.getAttribute("title"), zout.getAttribute("title")]).toEqual(words.slice(1));
        const named = [...pg.root.querySelectorAll(".hub-room-office [aria-label], .hub-room-office [title]")]
          .flatMap((e: any) => [e.getAttribute("aria-label"), e.getAttribute("title")]).filter(Boolean);
        expect(named.filter((v: string) => /^[a-z]+[A-Za-z]*\.[a-zA-Z_]+$/.test(v))).toEqual([]);   // no raw key anywhere in it
      } finally { restore(); }
    });
  }
});

describe("the office follows the room (Prism, #4355)", () => {
  it("an agent that joins is drawn and a renamed one keeps its place, without a remount", async () => {
    const p = page(); mounted.push(p); i18n.setLang("en", { store: false });
    let st: any = STATE(["e1", "e2"]);
    const roomOfficeState = async () => ({ ok: true, ...st });
    await p.mount(h(office.RoomOffice, { client: { roomOfficeState }, roomId: "room", members: [], pollMs: 15 }));
    const desks = () => [...p.root.querySelectorAll(".hub-room-office .oo-desk")].map((e: any) => e.textContent).sort();
    await until(() => desks().length === 3);
    const oo = q(p, ".hub-room-office .oo");
    st = { ...st, instances: [...st.instances, { name: "e3", display_name: "Planner", status: "running", execution_state: "idle", presence: "idle" }],
      offices: { ...st.offices, offices: [{ ...st.offices.offices[0], members: [...st.offices.offices[0].members, "e3"] }] } };
    await until(() => desks().includes("Planner"));
    expect(desks()).toContain("Planner");
    st = { ...st, instances: st.instances.map((i: any) => (i.name === "e3" ? { ...i, display_name: "Planner Two" } : i)) };
    await until(() => desks().includes("Planner Two"));
    expect([desks().includes("Planner Two"), desks().includes("Planner"), q(p, ".hub-room-office .oo") === oo]).toEqual([true, false, true]);
  });
  it("a drawing that fails to load says so with Try again even when the room's state reads fine; Try again loads it", async () => {
    const p = page(); mounted.push(p); i18n.setLang("en", { store: false });
    let tries = 0;
    const load = () => (++tries === 1 ? Promise.reject(new Error("offline")) : office.loadDrawing());
    await p.mount(h(office.RoomOffice, { client: { roomOfficeState: async () => ({ ok: true, ...STATE(["e1", "e2"]) }) }, roomId: "room", members: [], pollMs: 15, load }));
    await until(() => q(p, ".hub-room-office .error-state")); await settle(20);
    expect([!!q(p, ".hub-room-office .error-state"), !!q(p, ".skeleton")]).toEqual([true, false]);
    fire(q(p, ".hub-room-office .error-state button"), "click"); await until(() => q(p, ".hub-room-office .oo"));
    expect([tries, !!q(p, ".hub-room-office .oo")]).toEqual([2, true]);
  });
  it("names the drawing can key: long names (the Hub allows 256) and owner labels stay distinct, every one kept in the office", async () => {
    const { officesOk } = await import("/ui/js/fleet-office-model.js");
    i18n.setLang("en", { store: false });
    const long = "N".repeat(201), longer = "N".repeat(256);
    const st = { ...STATE(["a", "b"]), instances: [{ name: "a", display_name: long }, { name: "b", display_name: "Short" }, { name: "c", display_name: longer }, { name: "d", display_name: longer }, { name: "e", display_name: longer }] };
    st.offices = { ...st.offices, offices: [{ ...st.offices.offices[0], members: ["a", "b", "c", "d", "e"] }] };
    const members = [{ kind: "agent", id: "c", owner: { name: "O".repeat(120) } }, { kind: "agent", id: "d", owner: { name: "O".repeat(120) } }];
    const d = office.named(st, members);
    const keys = d.instances.map((i: any) => i.name);
    expect(new Set(keys).size).toBe(5);
    for (const k of keys) expect(k.length).toBeLessThanOrEqual(200);
    expect(officesOk(d.offices.offices)[0].members).toEqual(keys);
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

describe("the card's @ it sends to the member picked (#4355 review)", () => {
  const cardTitles: string[] = [];
  const askFrom = async (pg: AppPage, pick: (label: string) => boolean) => {
    fire(pg.root.querySelectorAll(".hub-room-tabs .seg-item")[1], "click"); await until(() => q(pg, ".hub-room-office .oo-desk"));
    const desk = [...pg.root.querySelectorAll(".hub-room-office .oo-desk")].find((e: any) => pick(e.textContent)) as any;
    fire(desk, "click"); await until(() => q(pg, ".oo-card-action"));
    cardTitles.push(q(pg, ".oo-card-name").textContent);
    const before = q(pg, ".hub-dock textarea")?.value ?? "";
    fire(q(pg, ".oo-card-action"), "click"); await until(() => docked(pg) && q(pg, ".hub-dock textarea")?.value !== before);
    return q(pg, ".hub-dock textarea");
  };
  const send = async (pg: AppPage, posts: any[], box: any) => { const n = posts.length; fire(box, "keydown", { key: "Enter" }); await until(() => posts.length > n); return posts.at(-1); };
  it("two agents of one name: only the one whose card it was", async () => {
    const { pg, room, posts, restore } = await roomPage({ sameName: true });
    try {
      const [a, b] = room.members.filter((m: any) => m.kind === "agent").slice(0, 2);
      // The office's state names both "Notes"; the first (a's figure) is labelled with its owner alone.
      const box = await askFrom(pg, (l) => l === `Notes (${a.owner.name})`);
      expect(box.value).toBe(`@${a.name} `);
      // The card says the agent's own name: the owner the scene's label adds is on the card's Owner row already (Lumen).
      expect(cardTitles.at(-1)).toBe("Notes");
      const post = await send(pg, posts, box);
      expect(post.mentions).toContain(a.id); expect(post.mentions).not.toContain(b.id);

      // Typed by hand (no card), the name still means both, as before: only a picked mention is bound.
      await settle(40);
      const again = q(pg, ".hub-dock textarea"); again.value = `@${a.name} again`; again.selectionStart = again.value.length; fire(again, "input"); await settle(2);
      const typed = await send(pg, posts, q(pg, ".hub-dock textarea"));
      expect([typed.text, typed.mentions.includes(a.id), typed.mentions.includes(b.id)]).toEqual([`@${a.name} again`, true, true]);
    } finally { restore(); }
  });
  it.each([["second"], ["first"], ["first, not its space"]])("two picked mentions of one name (A then B): deleting the %s sends only the other's member", async (which) => {
    const { pg, room, posts, restore } = await roomPage({ sameName: true });
    try {
      const [a, b] = room.members.filter((m: any) => m.kind === "agent").slice(0, 2);
      const labels = () => [...pg.root.querySelectorAll(".hub-room-office .oo-desk")].map((e: any) => e.textContent).filter((l: string) => /^Notes/.test(l));
      await askFrom(pg, (l) => l === `Notes (${a.owner.name})`);
      fire(pg.root.querySelectorAll(".hub-room-tabs .seg-item")[1], "click"); await until(() => labels().length === 2);
      let box = await askFrom(pg, (l) => l === labels().find((x) => x !== `Notes (${a.owner.name})`));
      expect(box.value).toBe(`@${a.name} @${b.name} `);
      const kept = which === "second" ? a : b, gone = which === "second" ? b : a, bare = which === "first, not its space";
      // The user selects one mention with its space and deletes it: the box's selection when the edit began, then the text.
      box = q(pg, ".hub-dock textarea");
      const len = a.name.length + 2, from = which === "second" ? len : 0, cut = bare ? len - 1 : len;
      box.selectionStart = from; box.selectionEnd = from + cut; fire(box, "beforeinput");
      box.value = bare ? ` @${a.name} ` : `@${a.name} `; box.selectionStart = box.selectionEnd = from; fire(box, "input"); await settle(3);
      const post = await send(pg, posts, box);
      expect([post.mentions.includes(kept.id), post.mentions.includes(gone.id)]).toEqual([true, false]);
    } finally { restore(); }
  });
  it.each([["beforeinput"], ["keydown only"], ["an IME"], ["a click, no key"]])("A then B, the caret moved before the edit (%s): only B's mention is touched, the untouched A is sent", async (how) => {
    const { pg, room, posts, restore } = await roomPage({ sameName: true });
    try {
      const [a, b] = room.members.filter((m: any) => m.kind === "agent").slice(0, 2);
      const labels = () => [...pg.root.querySelectorAll(".hub-room-office .oo-desk")].map((e: any) => e.textContent).filter((l: string) => /^Notes/.test(l));
      await askFrom(pg, (l) => l === `Notes (${a.owner.name})`);
      fire(pg.root.querySelectorAll(".hub-room-tabs .seg-item")[1], "click"); await until(() => labels().length === 2);
      let box = await askFrom(pg, (l) => l === labels().find((x) => x !== `Notes (${a.owner.name})`));
      const second = a.name.length + 2;
      // A click at 0, then arrows to B's @: navigation keys are not the edit.
      box.selectionStart = box.selectionEnd = 0; fire(box, "keydown", { key: "ArrowRight" });
      box.selectionStart = box.selectionEnd = second; fire(box, "keydown", { key: "ArrowRight" });
      if (how === "an IME") {
        // Composing over B's whole mention: the start is where the composition began, whatever the box says on the way.
        box.selectionStart = second; box.selectionEnd = box.value.length - 1; fire(box, "compositionstart");
        box.selectionStart = box.selectionEnd = second + 1; fire(box, "beforeinput");
        box.value = `@${a.name} 你好 `; box.selectionStart = box.selectionEnd = second + 2; fire(box, "compositionend"); fire(box, "input");
      } else if (how === "a click, no key") {
        // Arrows left the caret at 0; a click puts it at B's @ (no key) and a context-menu cut deletes that @: the edit's
        // own beforeinput is where it began, not the last key's.
        box.selectionStart = box.selectionEnd = 0; fire(box, "keydown", { key: "ArrowLeft" });
        box.selectionStart = second; box.selectionEnd = second + 1; fire(box, "beforeinput");
        box.value = `@${a.name} ${b.name} `; box.selectionStart = box.selectionEnd = second; fire(box, "input");
      } else {
        fire(box, "keydown", { key: "Delete" });
        if (how === "beforeinput") fire(box, "beforeinput");
        box.value = `@${a.name} ${b.name} `; box.selectionStart = box.selectionEnd = second; fire(box, "input");
      }
      await settle(3);
      const post = await send(pg, posts, q(pg, ".hub-dock textarea"));
      expect([post.mentions.includes(a.id), post.mentions.includes(b.id)]).toEqual([true, false]);
    } finally { restore(); }
  });
  it("a mention deleted or edited takes its binding with it: A, deleted, then B sends B only; A, deleted, retyped by hand is unbound", async () => {
    const { pg, room, posts, restore } = await roomPage({ sameName: true });
    try {
      const [a, b] = room.members.filter((m: any) => m.kind === "agent").slice(0, 2);
      const notes = (l: string) => /^Notes/.test(l);
      const labels = () => [...pg.root.querySelectorAll(".hub-room-office .oo-desk")].map((e: any) => e.textContent).filter(notes);
      const type = async (text: string) => { const box = q(pg, ".hub-dock textarea"); box.value = text; box.selectionStart = text.length; fire(box, "input"); await settle(3); return box; };
      // A (its card), deleted; then B (its card): only B.
      let box = await askFrom(pg, (l) => l === `Notes (${a.owner.name})`);
      await type("");
      fire(pg.root.querySelectorAll(".hub-room-tabs .seg-item")[1], "click"); await until(() => labels().length === 2);
      const other = labels().find((l) => l !== `Notes (${a.owner.name})`)!;
      box = await askFrom(pg, (l) => l === other);
      expect(box.value).toBe(`@${b.name} `);
      const onlyB = await send(pg, posts, box);
      expect([onlyB.mentions.includes(a.id), onlyB.mentions.includes(b.id)]).toEqual([false, true]);
      await settle(40);
      // A, edited away and retyped by hand: the ordinary reading (the name means both).
      box = await askFrom(pg, (l) => l === `Notes (${a.owner.name})`);
      await type(`@${a.name.slice(0, -1)} `);
      box = await type(`@${a.name} hello`);
      const unbound = await send(pg, posts, box);
      expect([unbound.text, unbound.mentions.includes(a.id), unbound.mentions.includes(b.id)]).toEqual([`@${a.name} hello`, true, true]);
    } finally { restore(); }
  });
  it("a binding follows its own mention through edits: either of two @Notes deleted leaves the other's member", async () => {
    const composer = await import("/ui/js/hub-room-composer.js");
    const detail = { me: { id: "me" }, members: [{ kind: "agent", id: "e1", name: "Notes" }, { kind: "agent", id: "e2", name: "Notes" }] };
    const text = "@Notes @Notes ", A = { name: "Notes", id: "e1", start: 0 }, B = { name: "Notes", id: "e2", start: 7 };
    expect(composer.boundMentions(text, detail, [A, B]).sort()).toEqual(["e1", "e2"]);
    const noB = "@Notes  ", left = composer.shiftBindings(text, noB, [A, B], composer.editRange(text, noB, { start: 7, end: 13 }, 7));
    expect([left, composer.boundMentions(noB, detail, left)]).toEqual([[A], ["e1"]]);
    const noA = " @Notes ", right = composer.shiftBindings(text, noA, [A, B], composer.editRange(text, noA, { start: 0, end: 6 }, 0));
    expect([right, composer.boundMentions(noA, detail, right)]).toEqual([[{ ...B, start: 1 }], ["e2"]]);
    // Edited inside the mention: gone; typed before it: moved; a hand-typed @Notes beside a bound one reads as typed.
    expect(composer.shiftBindings("@Notes hi", "@Note hi", [A], composer.editRange("@Notes hi", "@Note hi", { start: 6, end: 6 }, 5))).toEqual([]);
    expect(composer.shiftBindings("@Notes hi", "so @Notes hi", [A], composer.editRange("@Notes hi", "so @Notes hi", { start: 0, end: 0 }, 3))).toEqual([{ ...A, start: 3 }]);
    expect(composer.boundMentions("@Notes and @Notes", detail, [A]).sort()).toEqual(["e1", "e2"]);
    // A binding whose text no longer stands at its place binds nothing.
    expect(composer.intactBindings("hello @Notes", [A])).toEqual([]);
    // Two identical mentions, the first deleted with its space: the box's range says which (B stays, moved to 0); with
    // no range the text cannot say, so neither binding survives — no member is moved onto the other's mention.
    const r1 = composer.editRange(text, "@Notes ", { start: 0, end: 7 }, 0);
    expect(r1).toEqual({ a: 0, b: 7, c: 0 });
    expect(composer.shiftBindings(text, "@Notes ", [A, B], r1)).toEqual([{ ...B, start: 0 }]);
    expect(composer.shiftBindings(text, "@Notes ", [A, B], composer.editRange(text, "@Notes ", { start: 7, end: 14 }, 7))).toEqual([A]);
    expect(composer.shiftBindings(text, "@Notes ", [A, B])).toEqual([]);
    // Backspace, Delete and typing over a selection are ranges too; a range that does not explain the change is none.
    expect(composer.editRange("@Notes hi", "@Note hi", { start: 6, end: 6 }, 5)).toEqual({ a: 5, b: 6, c: 5 });
    expect(composer.editRange("@Notes hi", "@Notes i", { start: 7, end: 7 }, 7)).toEqual({ a: 7, b: 8, c: 7 });
    expect(composer.editRange("@Notes hi", "@Notes yo", { start: 7, end: 9 }, 9)).toEqual({ a: 7, b: 9, c: 9 });
    expect(composer.editRange("@Notes hi", "@Notes yo", { start: 0, end: 0 }, 0)).toBeNull();
  });
  it.each([["en", "@Room assistant"], ["zh-TW", "@房間助理"]])("the room assistant, by the box's own word for it (%s)", async (lang, word) => {
    const { pg, posts, restore } = await roomPage({ lang });
    try {
      const box = await askFrom(pg, (l) => l === (lang === "en" ? "Room assistant" : "房間助理"));
      expect(box.value).toBe(`${word} `);
      expect((await send(pg, posts, box)).mentions).toContain("assistant");
    } finally { restore(); }
  });
  it("a binding goes with its mention: edited away, it binds nothing", async () => {
    const composer = await import("/ui/js/hub-room-composer.js");
    const detail = { me: { id: "me" }, members: [{ kind: "agent", id: "e1", name: "Notes" }, { kind: "agent", id: "e2", name: "Notes" }, { kind: "agent", id: "e3", name: "Planner" }] };
    const bound = [{ name: "Notes", id: "e2", start: 0 }];
    expect(composer.boundMentions("@Notes hi", detail, bound)).toEqual(["e2"]);
    expect(composer.boundMentions("@Notes and @Planner", detail, bound).sort()).toEqual(["e2", "e3"]);
    expect(composer.boundMentions("@Note hi", detail, bound)).toEqual([]);
    expect(composer.boundMentions("@Planner", detail, bound)).toEqual(["e3"]);
    expect(composer.boundMentions("@Notes", detail, []).sort()).toEqual(["e1", "e2"]);
  });
});

// M-3565 (the user, 11-24): a room's agent card had no way into a one-to-one. The office card has the member card's
// 「和它一對一對話」 when this viewer may ask the agent (canAsk); with no chat yet it starts one from their grant (as 新對話).
describe("Chat with it one-to-one (M-3565)", () => {
  // The office's figures are the room's first two agents, in member order (STATE); the fixture has a one-to-one with the
  // first (room-helper) and none with the second.
  const card = async (pg: AppPage, nth: number) => {
    const desks = () => [...pg.root.querySelectorAll(".hub-room-office .oo-desk")] as any[];
    fire(pg.root.querySelectorAll(".hub-room-tabs .seg-item")[1], "click"); await until(() => desks().length);
    fire(desks()[nth], "click"); await until(() => q(pg, ".oo-card-action"));
    return [...pg.root.querySelectorAll(".oo-card-action")] as any[];
  };
  it("an agent I may ask with no chat yet: @ it, then Chat with it one-to-one — the chat started from my grant and opened", async () => {
    const { pg, room, asked, restore } = await roomPage({ canAsk: [0, 1] });
    try {
      const second = room.members.filter((m: any) => m.kind === "agent")[1];
      const acts = await card(pg, 1);
      expect(acts.map((b) => [b.textContent, b.classList.contains("btn-primary")])).toEqual([["@ it", true], ["Chat 1:1", false]]);
      expect(acts[1].getAttribute("aria-label"), "the whole words its name").toBe("Chat with it one-to-one");
      fire(acts[1], "click"); await until(() => pg.window.location.search.includes("room-direct-m3565"));
      expect(asked).toEqual([{ exposureId: second.id, grantId: `grant-${second.id}` }]);
      expect(pg.window.location.search).toBe("?room=room-direct-m3565");
    } finally { restore(); }
  });
  it("an agent I may ask that I already chat with: its chat opens, none started", async () => {
    const { pg, asked, restore } = await roomPage({ canAsk: [0] });
    try {
      const acts = await card(pg, 0);
      fire(acts[1], "click"); await until(() => pg.window.location.search.includes("room-helper"));
      expect([pg.window.location.search, asked]).toEqual(["?room=room-helper", []]);
    } finally { restore(); }
  });
  // M-3533 R2b: the card draws the agent's identity-card picture, by the room's own address and its hash; none without one.
  it("R2b: an agent with a portrait gets it on its card (the room's picture address); one without keeps its figure", async () => {
    const made: string[] = [], realImage = g.Image, hash = "c".repeat(64);
    // The scene loads its own pictures (the skin's) too: only the agents' picture addresses are counted.
    g.Image = class { onload: any = null; set src(v: string) { if (v.includes("/picture/")) made.push(v); } };
    const ids = (room: any) => room.members.filter((m: any) => m.kind === "agent").slice(0, 2).map((m: any) => m.id);
    let state: any = null;
    const { pg, room, restore } = await roomPage({ answer: () => ({ status: 200, body: state }) });
    try {
      state = STATE(ids(room)); state.instances[0].picture = { portrait: hash };
      await card(pg, 0);
      expect(made).toEqual([`/hub/v1/rooms/room-weekly/agents/${ids(room)[0]}/picture/portrait?v=${hash}`]);
      fire(q(pg, ".oo-card-close"), "click"); await settle(5);
      made.length = 0; await card(pg, 1);
      expect(made, "no portrait: no picture asked for").toEqual([]);
    } finally { g.Image = realImage; restore(); }
  });
  it("an agent I may not ask: only @ it", async () => {
    const { pg, restore } = await roomPage({ canAsk: [0] });
    try { expect((await card(pg, 1)).map((b) => b.textContent)).toEqual(["@ it"]); } finally { restore(); }
  });
});

describe("names the drawing reserves (#4355 review)", () => {
  it("an agent called team:… or __proto__ is drawn, in its own state, under its own name", () => {
    const st = { ...STATE(["a", "b"]), instances: [
      { name: "a", display_name: "team:core", status: "running", execution_state: "working", presence: "working" },
      { name: "b", display_name: "__proto__", status: "running", execution_state: "working", presence: "working" },
      { name: "c", display_name: "constructor", status: "running", execution_state: "idle", presence: "idle" }] };
    st.offices = { ...st.offices, offices: [{ ...st.offices.offices[0], members: ["a", "b", "c"] }] };
    const d = office.named(st), app = office.officeApp(d);
    const keys = d.instances.map((i: any) => i.name);
    for (const k of keys) expect([k, k.startsWith("team:") || Object.prototype.hasOwnProperty.call(Object.prototype, k)]).toEqual([k, false]);
    expect(keys.map((k: string) => k.replace(/\u2060/g, ""))).toEqual(["team:core", "__proto__", "constructor"]);
    expect(keys.map((k: string) => app.exec[k])).toEqual(["working", "working", "idle"]);
    expect(Object.getPrototypeOf(app.exec)).toBeNull();
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
