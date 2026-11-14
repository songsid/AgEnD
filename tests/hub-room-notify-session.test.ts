/**
 * M-3128 (Fable P2 wiring): the notifier's remembered person id follows the Hub session, through the real
 * panel — not just the store primitive. Sign in as A and open a room (its detail notes A's id through
 * HubRoomPage's onMe), then sign out and in as B on the same tab: the switch clears the id, so an @A row
 * no longer matches; B's own detail then notes B's id. (That a cleared id pings nothing is pinned by the
 * P2 scenario test in hub-room-notify.test.ts, which drives the notifier itself.)
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, type AppPage } from "./helpers/app-harness.js";
import { clearHubMeId, noteHubMeId, notifyKind, rememberedMeId } from "/ui/js/hub-room-notify.js";

let client: any, hubPanel: any, i18n: any, router: any;
const mounted: AppPage[] = [];
const until = async (fn: () => unknown, n = 200) => { for (let i = 0; i < n && !fn(); i++) await new Promise((r) => setTimeout(r, 5)); };

beforeAll(async () => {
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  router = await import("/assets/app-nav.js");
  i18n = await import("/assets/app-i18n.js");
  client = await import("/ui/js/hub-client.js");
  hubPanel = await import("/ui/js/panel-hub.js");
  clearHubMeId();
});

afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  client.setHubClient(null);
  i18n.setLang("en", { store: false });
  clearHubMeId();
});

const R1 = "room-weekly";
const session = (login: string, name: string) => ({
  signedIn: true, displayName: name, login, csrf: "c".repeat(64), hub: { name: "Team Hub" }, features: ["rooms-v1"],
});
function api(login: string, name: string, meId: string, detailGate?: Promise<unknown>) {
  const room = { id: R1, kind: "group", name: "研一主管週會", people: 3, agents: 1, online: 1, unread: 0, lastAt: 1, lastText: "", lastAuthor: "" };
  const routes: Record<string, () => unknown> = {
    "GET /hub/v1/session": () => [200, session(login, name)],
    "GET /hub/v1/rooms": () => [200, { ok: true, rooms: [room] }],
    [`GET /hub/v1/rooms/${R1}`]: () => detailGate ?? [200, { ok: true, room: { id: R1, kind: "group", name: room.name }, me: { id: meId, role: "member" }, members: [], settings: { allMention: true, historyForNew: "all" } }],
    [`GET /hub/v1/rooms/${R1}/messages`]: () => [200, { ok: true, messages: [], more: false }],
  };
  const fetchImpl = async (path: string, init: any = {}) => {
    const key = `${init.method || "GET"} ${String(path).split("?")[0]}`;
    const [status, json] = routes[key] ? (await routes[key]!() as [number, unknown]) : [404, { code: "not-found" }];
    return { ok: status >= 200 && status < 300, status, json: async () => json, headers: { get: () => null } };
  };
  client.setHubClient(client.createHubWebClient({ fetchImpl }));
}
async function openRoom(lang = "en") {
  i18n.setLang(lang, { store: false });
  const pg = page({ url: `http://127.0.0.1:19281/ui/hub?room=${R1}`, storage: { agend_tour_done: "1" } });
  pg.document.body.setAttribute("data-hub", "hub");
  pg.document.body.setAttribute("data-hub-name", "Team Hub");
  mounted.push(pg);
  router.startRouter(pg.window);
  await pg.mount(h(hubPanel.HubPanel, { route: { panel: "hub", tab: "ask" }, navKey: `hub:ask|notify-session:${lang}` }));
  return pg;
}

describe("remembered id follows the Hub session (Fable P2 wiring)", () => {
  it("notes A's id from the room detail, forgets it on a sign-in as B, then notes B's", async () => {
    api("wang", "王經理", "person-wang");
    const pg1 = await openRoom();
    await until(() => rememberedMeId() === "person-wang");
    expect(rememberedMeId()).toBe("person-wang");
    // One active page at a time (the harness's assumption); module state survives the unmount.
    await pg1.unmount(); pg1.restore();
    mounted.splice(mounted.indexOf(pg1), 1);

    // Sign out and in as B on the same tab, while B's room detail is still on its way: the switch clears
    // the id first, so nothing in between can match as A; B's detail then notes B's id.
    let releaseDetail!: (v: unknown) => void;
    const detailGate = new Promise<unknown>((r) => { releaseDetail = r; });
    hubPanel.resetHubSession();
    api("chen", "陳主任", "person-chen", detailGate);
    await openRoom();
    await until(() => rememberedMeId() === null);
    expect(rememberedMeId()).toBeNull();
    // With the id forgotten, an @A row matches nobody: no ping for A (me is null) nor for B (not mentioned).
    const atA = { type: "message.added", roomId: "room-weekly",
      message: { id: "m-9", roomId: "room-weekly", at: 1, author: { kind: "person", id: "person-chen", name: "陳主任" }, text: "hi @王經理", mentions: ["person-wang"] } };
    expect(notifyKind(atA, null)).toBeNull();
    noteHubMeId("person-chen");
    expect(notifyKind(atA, { id: "person-chen" })).toBeNull();
    clearHubMeId();
    releaseDetail([200, { ok: true, room: { id: R1, kind: "group", name: "研一主管週會" }, me: { id: "person-chen", role: "member" }, members: [], settings: { allMention: true, historyForNew: "all" } }]);
    await until(() => rememberedMeId() === "person-chen");
    expect(rememberedMeId()).toBe("person-chen");
  });
});
