/**
 * M-3591: an agent's HTML page in a Hub group room. The room page (hub-room-thread.js HubRoomPage) set up no previews and
 * had no side panel: its card said "Previews are not available here." while a one-to-one chat (panel-hub.js HubRoomView)
 * ran the page. Now the group room is the one-to-one chat's:
 * - the page's previews follow the Hub shell's data (here: not offered, in the Hub's words) — never the unset fallback;
 * - Open in panel opens the room's panel where the members rail was; the members button closes the page and brings the
 *   rail back; "Reply about this page" puts its line in the room's box, once; leaving for the office closes the page;
 * - this browser's opt-in (the card's menu) asks in the Hub's words, as in a one-to-one chat;
 * - #4407 review: an agent's name (its member card) with a page shown closes the page, as the members button does.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { createHubRoomsFixture } from "./support/hub-rooms-fixture.js";

let client: any, shell: any, store: any, router: any, i18n: any, hubPanel: any, pp: any;
const mounted: AppPage[] = [];
const g = globalThis as any;
const until = async (fn: () => unknown, n = 300) => { for (let i = 0; i < n && !fn(); i++) await settle(5); expect(fn(), "waited for").toBeTruthy(); };
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  store = await import("/assets/app-store.js"); router = await import("/assets/app-nav.js"); shell = await import("/assets/app-shell.js");
  i18n = await import("/assets/app-i18n.js"); client = await import("/ui/js/hub-client.js"); hubPanel = await import("/ui/js/panel-hub.js");
  pp = await import("/assets/preview-panel.js");
  pg.restore();
});
const realES = g.EventSource, realMM = g.matchMedia, realFetch = g.fetch;
afterEach(async () => {
  g.confirm = undefined;
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  client.setHubClient(null); pp.closePanel(); i18n.setLang("en", { store: false });
  g.EventSource = realES; g.matchMedia = realMM; g.fetch = realFetch;
});

const PAGE = "<!doctype html><title>Q3 report</title><h1>Q3</h1>";
const NOT_OFFERED = { "data-preview-reason-code": "notOffered", "data-preview-reason": "" };

/** The weekly group room, its last message an agent's answer carrying an HTML page; a desktop (the members rail shows). */
async function groupRoom({ lang = "en", dataset = NOT_OFFERED as Record<string, string>, office = false } = {}) {
  const fx = createHubRoomsFixture(), room = fx.rooms.find((r: any) => r.id === "room-weekly")! as any;
  if (office) room.settings.office = { enabled: true, style: "studio" };
  const agent = room.members.find((m: any) => m.kind === "agent" && m.presence === "idle");
  room.messages.push({ id: "msg-9001", roomId: room.id, at: Date.now(), author: { kind: "agent", id: agent.id, name: agent.name, owner: agent.owner },
    text: `Here it is.\n\n\`\`\`html\n${PAGE}\n\`\`\``, mentions: [], stage: "answered" });
  g.fetch = async (url: string, init?: any) => {
    if (/\/hub\/v1\/rooms\/room-weekly\/office\/state$/.test(String(url))) {
      const body = { instances: [], org: { general: [], teams: [], instances: {} }, needs: [], traffic: { now: new Date().toISOString(), items: [], delegations: [] }, text: false,
        office: "room", offices: { rev: 0, readable: true, offices: [{ id: "room", name: "Weekly", skin: "studio", members: [] }] } };
      return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => body, text: async () => JSON.stringify(body) };
    }
    return fx.fetch(url, init);
  };
  g.EventSource = fx.EventSource;
  const pg = page({ url: "http://127.0.0.1:19280/ui/hub?room=room-weekly", storage: { agend_tour_done: "1" } });
  g.matchMedia = (q: string) => ({ matches: /min-width/.test(q), addEventListener() {}, removeEventListener() {} });
  pg.document.body.setAttribute("data-hub", "hub"); pg.document.body.setAttribute("data-hub-name", "Team Hub");
  for (const [k, v] of Object.entries(dataset)) pg.document.body.setAttribute(k, v);
  mounted.push(pg);
  i18n.setLang(lang, { store: false });
  client.setHubClient(client.createHubWebClient()); hubPanel.resetHubSession(); router.startRouter(pg.window); store.applyStatus({ instances: [] });
  await pg.mount(h(shell.Shell, { panels: new Map([["hub", { Component: hubPanel.HubPanel || (() => null) }]]), onNewInstance() {} }));
  await until(() => pg.root.querySelector(".hub-room-page .msg.agent .pv-open"));
  return pg;
}
const $ = (pg: AppPage, sel: string) => pg.root.querySelector(sel) as any;
/** A card's button: chat-thread sets its onclick (the mini DOM's click() runs listeners only). */
const press = async (el: any) => { if (typeof el.onclick === "function") el.onclick(); else el.click(); await settle(10); };

describe("a group room's HTML page (M-3591)", () => {
  it("the card follows the Hub's previews; Open in panel replaces the members rail; Reply about this page fills the box once; members brings the rail back", async () => {
    const pg = await groupRoom();
    // The page's previews are set up from the Hub shell's data: not offered, in the Hub's words — never "not available here".
    const P = g.AgendPreview;
    expect([P.availability().ok, P.availability().reason]).toEqual([false, "Previews are not offered on this Hub. You can still download the page."]);
    await until(() => $(pg, ".hub-room-page > .u-rail"));
    await press($(pg, ".hub-room-page .msg.agent .pv-open"));
    await until(() => $(pg, ".hub-room-page > .pv-panel"));
    expect([$(pg, ".hub-room-page > .u-rail"), $(pg, ".hub-room-page").classList.contains("with-rail")]).toEqual([null, false]);
    expect(pp.panelStore.get().open.instance).toBe("hub-room:room-weekly");
    expect(pg.root.querySelectorAll(".pv-fb-share, .pv-fb-shared")).toHaveLength(0);
    expect($(pg, ".pv-panel").textContent).toContain("Previews are not offered on this Hub.");
    expect($(pg, ".pv-panel").textContent).not.toContain("Previews are not available here.");
    expect(pg.root.querySelectorAll("iframe")).toHaveLength(0);
    $(pg, ".pv-fb-reply").click(); await settle(10);
    $(pg, ".pv-fb-reply").click(); await settle(10);
    expect($(pg, ".hub-room-page #msgIn").value).toBe(i18n.t("chat.pvFbAboutNamed", "Q3 report"));
    const members = $(pg, ".hub-room-rail-toggle");
    expect(members.getAttribute("aria-pressed")).toBe("false");
    members.click();
    await until(() => $(pg, ".hub-room-page > .u-rail"));
    expect([$(pg, ".pv-panel"), pp.shownKey(), members.getAttribute("aria-pressed")]).toEqual([null, null, "true"]);
  });

  it("#4407 review: an agent's name with a page shown closes the page and opens its card in the members rail", async () => {
    const pg = await groupRoom();
    await press($(pg, ".hub-room-page .msg.agent .pv-open"));
    await until(() => $(pg, ".hub-room-page > .pv-panel"));
    expect($(pg, ".hub-room-page > .u-rail")).toBeNull();
    const answer = [...pg.root.querySelectorAll(".hub-room-page .msg.agent")].find((m: any) => m.querySelector(".pv-open")) as any;
    fire(answer.querySelector(".hub-source-trigger"), "click"); await settle(10);
    await until(() => $(pg, ".hub-room-page > .u-rail .hub-member-card"));
    expect([$(pg, ".hub-room-page > .pv-panel"), pp.shownKey(), $(pg, ".hub-room-page").classList.contains("with-rail")]).toEqual([null, null, true]);
    expect($(pg, ".hub-room-page > .u-rail .hub-member-card").textContent).toContain(answer.querySelector(".hub-source-trigger").textContent.split(" · ")[0]);
  });

  it("leaving the room closes its page and lets go of the box", async () => {
    const pg = await groupRoom();
    await press($(pg, ".msg.agent .pv-open"));
    await until(() => $(pg, ".pv-panel"));
    await pg.unmount();
    expect(pp.shownKey()).toBe(null);
    const actions = await import("/assets/preview-panel-actions.js");
    expect(actions.replyAboutPage({ key: "k", instance: "hub-room:room-weekly", msgKey: "hub-2", code: PAGE })).toBe(false);
  });

  it("the office has no page beside it: going there closes the page", async () => {
    const pg = await groupRoom({ office: true });
    await press($(pg, ".msg.agent .pv-open"));
    await until(() => $(pg, ".pv-panel"));
    router.navigate("/ui/hub?room=room-weekly&view=office");
    await until(() => !$(pg, ".hub-room-page .thread"));
    expect([$(pg, ".pv-panel"), pp.shownKey()]).toEqual([null, null]);
  });

  it("this browser's opt-in asks in the Hub's words, from the group room's card", async () => {
    const pg = await groupRoom({ dataset: { "data-preview-origin": "https://127.0.0.1:19281", "data-preview-boot": "a".repeat(32), "data-dashboard-origin": "http://127.0.0.1:19280" } });
    const P = g.AgendPreview;
    expect([P.availability().ok, P.availability().why]).toEqual([false, "optin"]);
    const asked: string[] = [];
    g.confirm = (m: string) => { asked.push(m); return true; };
    await press($(pg, ".msg.agent .pv-opt")); await settle(10);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("This applies to this Hub in this browser only.");
    expect([P.optedIn(), P.availability().ok]).toEqual([true, true]);
    P.setOptIn(false);
  });

  it("zh-TW: not offered, in the Hub's words", async () => {
    const pg = await groupRoom({ lang: "zh-TW" });
    await press($(pg, ".msg.agent .pv-open"));
    await until(() => $(pg, ".pv-panel"));
    expect($(pg, ".pv-panel").textContent).toContain("這個 Hub 不提供預覽。");
  });
});
