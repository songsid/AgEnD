import { afterEach, beforeAll, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let clients: any, panel: any, words: any, chats: any;
const mounted: AppPage[] = [], id = "aaaaaaaa-1111-4222-8333-444444444444", roomId = "bbbbbbbb-1111-4222-8333-444444444444";
beforeAll(async () => {
  const p = page(); clients = await import("/ui/js/hub-client.js"); panel = await import("/ui/js/panel-hub.js");
  words = await import("/assets/app-i18n.js"); chats = await import("/ui/js/hub-chat-store.js"); p.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } clients.setHubClient(null); panel.resetHubSession(); words.setLang("en", { store: false }); });
const until = async (f: () => unknown) => { for (let n = 0; n < 100 && !f(); n++) await settle(5); expect(f()).toBeTruthy(); };
async function mount({ state = "published", mark = true, clientMark = true, lang = "en", asker = false } = {}) {
  let current = state, epoch = 4; const calls: any[] = [];
  const grant = { id: "grant-fixture", subjectName: "Alex Chen", subjectLogin: "alex", expiresAt: Date.now() + 86_400_000, revision: 1, subject: { kind: "person" } };
  const room = () => ({ id: roomId, state: "active", exposureName: "Research", exposureState: current, ownerName: "Olivia", features: [], grantExpiresAt: grant.expiresAt });
  const c = clients.createHubWebClient({ fetchImpl: async (path: string, options: any) => {
    const body = options.body ? JSON.parse(options.body) : undefined; calls.push({ path, method: options.method, body });
    if (path.endsWith("/sharing")) { current = body.paused ? "paused" : "published"; epoch++; }
    const data = path === "/hub/v1/session" ? { signedIn: true, admin: false, csrf: "owned-fixture", displayName: "Owner", login: "owner", features: mark ? ["sharing-pause-v1"] : [] }
      : path === "/hub/v1/exposures" ? { mine: [{ id, displayName: "Research", revision: 3, sharingEpoch: epoch, state: current, grants: [grant] }], askable: [] }
      : path === "/hub/v1/rooms" ? { rooms: [room()] } : path.includes("/messages") ? { entries: [], room: room() }
      : path.endsWith("/activity") ? { activity: [] } : { ok: true, pairings: [] };
    return { ok: true, status: 200, headers: new Headers(), json: async () => data };
  } }); c.sharingPauseV1 = clientMark; clients.setHubClient(c); panel.resetHubSession(); words.setLang(lang, { store: false });
  const p = page({ url: `https://hub.example.test/ui/hub${asker ? `?room=${roomId}` : `/exposures?agent=${id}`}`, storage: { agend_lang: lang, agend_tour_done: "1" } }); mounted.push(p);
  p.document.body.setAttribute("data-hub", "hub");
  await p.mount(h(panel.HubPanel, { route: { panel: "hub", tab: asker ? "ask" : "exposures" } }));
  await until(() => p.root.querySelector(asker ? ".hub-chat-main" : ".hub-owner .card"));
  return { p, c, calls };
}
const button = (p: AppPage, text: string) => [...p.root.querySelectorAll("button")].find(b => b.textContent === text) as any;
it.each(["en", "zh-TW"])("pause/resume is distinct from permanent Stop sharing and sends the exact shown epoch (%s)", async lang => {
  const { p, calls } = await mount({ lang });
  const pause = lang === "en" ? "Pause sharing" : "暫停分享", resume = lang === "en" ? "Resume sharing" : "繼續分享";
  expect(button(p, "Stop sharing…") || button(p, "停止分享…")).toBeTruthy();
  expect(p.root.textContent).toContain(lang === "en" ? "expiry dates keep running" : "到期時間照常計算");
  fire(button(p, pause), "click"); await until(() => button(p, resume));
  expect(p.root.textContent).toContain("Alex Chen"); expect(p.root.querySelector(".hub-danger")).not.toBeNull();
  fire(button(p, resume), "click"); await until(() => button(p, pause));
  expect(calls.filter(c => c.path.endsWith("/sharing")).map(c => c.body)).toEqual([
    { revision: 3, sharingEpoch: 4, paused: true }, { revision: 3, sharingEpoch: 5, paused: false },
  ]);
});
it.each([{ mark: false, clientMark: true }, { mark: true, clientMark: false }])("retained client/server controls never advertise a false resumable action (%j)", async options => {
  const { p } = await mount(options); expect(p.root.querySelector(".hub-sharing-control")).toBeNull();
  expect(p.root.querySelector(".hub-danger")).not.toBeNull();
});
it("permanently stopped agents have no Resume action", async () => {
  const { p } = await mount({ state: "frozen" }); expect(p.root.querySelector(".hub-sharing-control")).toBeNull();
  expect(p.root.textContent).toContain("Sharing stopped on the Hub");
});
it.each(["en", "zh-TW"])("a paused asker sees paused rather than denied, with no enabled Send (%s)", async lang => {
  const { p } = await mount({ state: "paused", asker: true, lang });
  expect(p.root.textContent).toContain(lang === "en" ? "The owner paused sharing Research" : "擁有者已暫停分享 Research");
  expect(p.root.textContent).not.toContain(lang === "en" ? "permission ended" : "權限已結束");
  const send = p.root.querySelector(`[aria-label="${words.t("hubChat.send")}"]`);
  expect(send?.hasAttribute("disabled")).toBe(true);
});
it("a stale-tab question refused by pause does not close the conversation or discard its draft", async () => {
  const timers = { setTimeout() { return 1; }, clearTimeout() {} };
  const c = { read: async () => ({ ok: true, entries: [] }), ask: async () => ({ ok: false, code: "sharing-paused" }) };
  const s = chats.createHubChatStore({ id: roomId, exposureState: "published", features: [] }, { client: c, timers, doc: null });
  try { expect((await s.send("kept by composer")).code).toBe("sharing-paused"); expect(s.closed()).toBe(false); expect(s.accessDenied()).toBe(false); expect(s.room().exposureState).toBe("paused"); }
  finally { s.stop(); }
});
