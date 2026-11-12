/**
 * M-2988: Fleet-side Hub flow gaps from Lumen's user-story board (docs/evidence/hub-ux-stories-m2986), wording and
 * state-dependent hints only — no new product behaviour.
 *  #1  "Shared agents" says ClassicBot rooms can't be shared yet (the empty list no longer stops at "no agents").
 *  #6  「暫停提問」 is 「停止分享」, and its confirm says sharing again needs the Fleet to share it again and everyone to be
 *      allowed again (there is no resume on the Hub, and the grants do not come back).
 *  #8  after a Share switch, the hint names General only when a General holds the card; otherwise the confirm card.
 *      (#9, the company-join wait, is pinned in hub-company-join-wait.test.ts with the same helper.)
 *  #11 a directory that can't list groups no longer tells the Hub administrator to ask the Hub administrator.
 *  #12 an approval the Hub refuses because of the owner (not eligible / blocked) names the owner, not "you".
 *  #13 the non-host Hub setup says how: agend web on the AgEnD computer.
 *  #16 revoking a Fleet names the Fleet as the list does.
 *  #17 the ask page's note says what the asker cares about.
 * (#7, the sign-in lead, is pinned in signin-copy-1854 / signin-outside-3008.)
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let i18n: any, place: any, store: any, client: any, card: any, panel: any;
const mounted: AppPage[] = [];
const until = async (fn: () => unknown, n = 200) => { for (let i = 0; i < n && !fn(); i++) await settle(5); return fn(); };
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  i18n = await import("/assets/app-i18n.js");
  store = await import("/assets/app-store.js");
  place = await import("/ui/js/hub-confirm-place.js");
  client = await import("/ui/js/hub-client.js");
  card = await import("/ui/js/settings-hub.js");
  panel = await import("/ui/js/panel-hub.js");
  await import("/ui/js/hub-owner-strings.js"); await import("/ui/js/hub-join-steps.js"); await import("/ui/js/settings-hub-setup-strings.js");
  await import("/ui/js/hub-agent-copy.js");
  pg.restore();
});
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  client.setHubClient(null); panel.resetHubSession?.(); store.appStore.set({ pendingChanges: [], hubJoinChanges: [] });
  i18n.setLang("en", { store: false }); vi.restoreAllMocks(); (globalThis as any).confirm = undefined;
});
const T = (lang: string, key: string, ...args: unknown[]) => { i18n.setLang(lang, { store: false }); return i18n.t(key, ...args); };

describe("#8 / #9: where a waiting Hub step is confirmed", () => {
  const chat = (where: unknown) => ({ id: "p", confirmation: { kind: "chat", code: "p", where } });
  it("a card in General names its chat app (and a connection of its own); anything else is the confirm card", () => {
    expect(place.confirmChat(chat([{ platform: "discord", connection: "discord" }]))).toBe("Discord");
    expect(place.confirmChat(chat([{ platform: "discord", connection: "team-b" }, { platform: "telegram", connection: "telegram" }]))).toBe("Discord (team-b) / Telegram");
    for (const v of [null, {}, { confirmation: { kind: "posting" } }, { confirmation: { kind: "host_cli", reason: "no_chat" } }, { confirmation: { kind: "web" } }, chat([])])
      expect(place.confirmChat(v)).toBeNull();
    i18n.setLang("en", { store: false });
    expect(place.confirmPlace("share", chat([{ platform: "telegram", connection: "telegram" }]))).toBe("Sent for confirmation: press Confirm on the card in General on Telegram to share it.");
    expect(place.confirmPlace("share", { confirmation: { kind: "host_cli", reason: "no_chat" } })).toBe("Sent for confirmation: finish it on the confirm card at the top of this page to share it.");
    i18n.setLang("zh-TW", { store: false });
    expect(place.confirmPlace("share", { confirmation: { kind: "posting" } })).toBe("已送出確認：請在上方的確認卡完成，才會分享。");
    expect(place.confirmPlace("join", chat([{ platform: "discord", connection: "discord" }]))).toContain("請先到 Discord 的 General");
  });
  it("pendingView finds the live view in either shell list", () => {
    expect(place.pendingView({ pendingChanges: [{ id: "a" }], hubJoinChanges: [{ id: "b", x: 1 }] }, "b")).toEqual({ id: "b", x: 1 });
    expect(place.pendingView({ pendingChanges: [{ id: "a" }] }, "z")).toBeNull();
    expect(place.pendingView({}, null)).toBeNull();
  });

  const ROW = { agent: "atlas", display: "Atlas", exposureId: null, revision: 0, state: "withdrawn", policy: null, enforceable: true,
    choices: { dataViews: [{ id: "agent", label: "Atlas" }], tools: [] }, pending: null };
  async function shareOn(lang: string) {
    i18n.setLang(lang, { store: false });
    const setExposed = vi.fn(async () => ({ ok: true, pending: { id: "q".repeat(32), expiresAt: 9 }, view: { ...ROW, pending: { expiresAt: 9 } }, settled: new Promise(() => {}) }));
    client.setHubClient({ stub: false, subscribe: () => () => {}, exposures: async () => [ROW], setExposed,
      pairing: async () => ({ state: "paired", hub: { hubId: "h", name: "Team", memberOrigin: "https://hub.test", webOrigin: "https://hub.test", fingerprint: { kind: "hub-key", digest: "a".repeat(64) } }, link: "online" }) });
    const pg = page({ url: "http://127.0.0.1:19280/settings/access", storage: { agend_tour_done: "1", agend_lang: lang } }); mounted.push(pg);
    pg.document.body.setAttribute("data-hub", "member");
    await pg.mount(h(card.HubConnectCard, {}));
    await until(() => pg.root.querySelector(".hub-exposure input"));
    const box = pg.root.querySelector(".hub-exposure input") as any; box.checked = true; fire(box, "change");
    await until(() => pg.root.querySelector(".hub-exposures [role=status]"));
    return pg;
  }
  const status = (pg: AppPage) => pg.root.querySelector(".hub-exposures [role=status]")!.textContent;
  it.each(["en", "zh-TW"])("a web-only Fleet's Share is never sent to General; the hint follows the request's card (%s)", async (lang) => {
    const pg = await shareOn(lang);
    store.appStore.set({ pendingChanges: [{ id: "q".repeat(32), state: "pending", confirmation: { kind: "host_cli", code: "q", reason: "no_chat" } }] });
    await settle(10);
    expect(status(pg)).toBe(lang === "en" ? "Sent for confirmation: finish it on the confirm card at the top of this page to share it." : "已送出確認：請在上方的確認卡完成，才會分享。");
    expect(status(pg)).not.toContain("General");
    store.appStore.set({ pendingChanges: [{ id: "q".repeat(32), state: "pending", confirmation: { kind: "chat", code: "q", where: [{ platform: "discord", connection: "discord" }] } }] });
    await settle(10);
    expect(status(pg)).toBe(lang === "en" ? "Sent for confirmation: press Confirm on the card in General on Discord to share it." : "已送出確認：請到 Discord 的 General，在確認卡上按「確認」，才會分享。");
  });
});

describe("#12 / #16: the Hub administrator's approve and revoke", () => {
  async function admin(over: Record<string, unknown> = {}, lang = "en") {
    const pg = page({ url: "https://hub.example.test/ui/hub/admin", storage: { agend_lang: lang } }); mounted.push(pg); i18n.setLang(lang, { store: false });
    const session = { ok: true, signedIn: true, displayName: "Ada Admin", login: "ada", admin: true, csrf: "c".repeat(64), features: [] };
    const c: any = { stub: false, web: true, onSignedOut: () => () => {}, session: vi.fn(async () => session), rooms: async () => ({ ok: true, rooms: [] }), catalog: async () => ({ ok: true, askable: [] }),
      adminOverview: vi.fn(async () => ({ ok: true,
        pairings: [{ id: "p1", owner: { name: "Carol" }, ownerConfirmed: true, adminApproved: false, fingerprint: "f".repeat(64) }],
        fleets: [{ id: "a1", label: "build-box", status: "active", owner: { name: "Dave", login: "dave" } }, { id: "a2", status: "active", owner: { name: "Erin", login: "erin" } }] })),
      approvePairing: vi.fn(async () => ({ ok: false, code: "denied" })), revokeFleet: vi.fn(async () => ({ ok: true })), ...over };
    client.setHubClient(c);
    await pg.mount(h(panel.HubPanel, { route: { panel: "hub", tab: "admin" } }));
    expect(await until(() => pg.root.querySelector("[data-fleet]")), pg.root.textContent!.slice(0, 400)).toBeTruthy();
    return { pg, c };
  }
  const button = (pg: AppPage, text: string) => [...pg.root.querySelectorAll("button")].find((b: any) => b.textContent === text) as any;
  // The harness answers each question the app asks with globalThis.confirm (tests/helpers/app-harness.ts): yes, recorded.
  const asked = () => { const f = vi.fn((_m: string) => true); (globalThis as any).confirm = f; return f; };
  it.each([["en", "Approve…", "Carol can't connect a Fleet right now: they aren't in the allowed groups, or they've been blocked from connecting."],
    ["zh-TW", "核准…", "Carol 目前不能連接 Fleet（不在允許的範圍，或已被禁止連接）。"]])("a refusal because of the owner names the owner (%s)", async (lang, go, words) => {
    const { pg, c } = await admin({}, lang); asked();
    fire(button(pg, go), "click");
    await until(() => c.approvePairing.mock.calls.length && pg.root.textContent!.includes("Carol "));
    expect(pg.root.textContent).toContain(words);
    expect(pg.root.textContent).not.toContain(lang === "en" ? "You're not allowed" : "你沒有權限");
  });
  it("any other refusal keeps its own words", async () => {
    const { pg, c } = await admin({ approvePairing: vi.fn(async () => ({ ok: false, code: "revoked" })) }); asked();
    fire(button(pg, "Approve…"), "click");
    await until(() => c.approvePairing.mock.calls.length && pg.root.textContent!.includes("You're not allowed"));
    expect(pg.root.textContent).not.toContain("can't connect a Fleet right now");
  });
  it.each([["a1", "Revoke Dave's fleet “build-box”? It disconnects and everything it shares is withdrawn."],
    ["a2", "Revoke Erin's fleet? It disconnects and everything it shares is withdrawn."]])("revoking %s names the Fleet as its row does", async (fleet, words) => {
    const { pg, c } = await admin(); const said = asked();
    fire(pg.root.querySelector(`[data-fleet="${fleet}"] button[aria-haspopup=menu]`) as any, "click");
    await until(() => pg.root.querySelector(`[data-fleet="${fleet}"] [role=menuitem]`));
    fire(pg.root.querySelector(`[data-fleet="${fleet}"] [role=menuitem]`) as any, "click");
    await until(() => c.revokeFleet.mock.calls.length);
    expect(said.mock.calls.map(x => x[0])).toEqual([words]);
    expect(c.revokeFleet).toHaveBeenCalledExactlyOnceWith(fleet);
  });
});

describe("#1 / #6 / #11 / #13 / #17: the words", () => {
  it("#6: stop sharing, and the confirm says the Fleet shares it again and everyone is allowed again", () => {
    expect([T("en", "hub.freeze"), T("en", "hubOwner.pauseTitle"), T("en", "hubOwner.pauseGo")]).toEqual(["Stop sharing", "Stop sharing", "Stop sharing…"]);
    expect([T("zh-TW", "hub.freeze"), T("zh-TW", "hubOwner.pauseTitle"), T("zh-TW", "hubOwner.pauseGo")]).toEqual(["停止分享", "停止分享", "停止分享…"]);
    for (const lang of ["en", "zh-TW"]) for (const key of ["hub.freezeAsk", "hubOwner.pauseLead"]) {
      const s = T(lang, key, "Atlas");
      expect(s).toMatch(lang === "en" ? /shared again from its fleet/ : /回到它的 Fleet 重新分享/);
      expect(s).toMatch(lang === "en" ? /everyone has to be allowed to ask again/ : /每個人都要重新允許/);
    }
    for (const lang of ["en", "zh-TW"]) for (const key of ["hub.freeze", "hub.freezeAsk", "hub.frozen", "hub.state_frozen", "hubOwner.pauseGo", "hubOwner.pauseTitle", "hubOwner.pauseLead", "hubOwner.statePaused"])
      expect(T(lang, key, "Atlas")).not.toMatch(/暫停|凍結|Pause|Frozen|Stop all asking|停止所有提問/);
  });
  it("#1: shared agents say ClassicBot rooms can't be shared yet", () => {
    expect(T("en", "hub.agentLead")).toContain("ClassicBot rooms can't be shared yet");
    expect(T("zh-TW", "hub.agentLead")).toContain("ClassicBot 房間還不能分享");
  });
  it("#11: the administrator is told why and what to do, not to ask the administrator", () => {
    for (const lang of ["en", "zh-TW"]) {
      const s = T(lang, "hubJoinSteps.unsupported");
      expect(s).not.toMatch(/Ask your Hub administrator|請找 Hub 管理員/);
      expect(s).toContain("LDAPS");
      expect(s).toMatch(lang === "en" ? /Edit AD connection.*individual invitations/ : /編輯 AD 連線.*個別邀請/);
    }
  });
  it("#13: a setup the server refuses to a session that is not the host's says how to get to the host's own page", async () => {
    const { setupError } = await import("/ui/js/settings-hub-setup-strings.js");
    for (const code of ["denied", "host_session_required"]) {
      i18n.setLang("en", { store: false });
      expect(setupError(code)).toBe("Only this computer's own sign-in can set up a Hub. On the computer running AgEnD, run agend web in a terminal and set it up on the page it opens.");
      i18n.setLang("zh-TW", { store: false });
      expect(setupError(code)).toBe("只有這台電腦自己的登入能設定 Hub。請到執行 AgEnD 的那台電腦，在終端機執行 agend web，再用它開啟的頁面設定。");
    }
  });
  it("#17: the ask page says the owner sees who asked and the agent answers within the owner's allowance", () => {
    expect(T("en", "hub.roomNote")).toBe("You're asking as yourself: the owner sees that you asked. The agent answers within what its owner allows.");
    expect(T("zh-TW", "hub.roomNote")).toBe("你是以自己的身分提問：對方會看到是你問的；Agent 用擁有者允許的範圍回答。");
  });
});
