/**
 * #3226 D2: files in the Hub chat (a mini DOM, the real HubPanel over a scripted Hub API).
 * - a room whose fleet link took attachments-v1 shows Attach; one without it shows no Attach, only a line saying files
 *   can't be sent yet (never a dead control);
 * - choosing files uploads each at once (raw body, its name percent-encoded, the CSRF token) and lists it under the
 *   composer; Send names the uploaded ids; a refused file says why and is not listed; the answer's files show in the thread.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let client: any, hubPanel: any, i18n: any, router: any;
const mounted: AppPage[] = [];
const until = async (fn: () => unknown, n = 200) => { for (let i = 0; i < n && !fn(); i++) await settle(5); };
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19281/ui", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  router = await import("/assets/app-nav.js");
  i18n = await import("/assets/app-i18n.js");
  client = await import("/ui/js/hub-client.js");
  hubPanel = await import("/ui/js/panel-hub.js");
  pg.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); i18n.setLang("en", { store: false }); });

const R1 = "11111111-2222-4333-8444-555555555555", FILE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SIGNED = { signedIn: true, displayName: "Alex", login: "alex", admin: false, csrf: "c".repeat(64), hub: { name: "Team Hub" } };
function hubApi(features: string[], upload: (init: any) => [number, unknown] = () => [200, { file: { id: FILE, name: "chart 1.png", size: 3, mime: "image/png", url: `/hub/v1/rooms/${R1}/files/${FILE}` } }],
  entries: unknown[] = []) {
  const calls: { method: string; path: string; body: any; headers: any }[] = [];
  const room = { id: R1, exposureId: "e1", grantId: "g1", state: "active", exposureName: "Sales numbers", ownerName: "Olivia", exposureState: "published", grantExpiresAt: 2_000_000_000_000, lastAt: 1, waiting: false, features };
  const routes: Record<string, (body: any, init: any) => [number, unknown]> = {
    "GET /hub/v1/session": () => [200, SIGNED],
    "GET /hub/v1/exposures": () => [200, { mine: [], askable: [] }],
    "GET /hub/v1/rooms": () => [200, { rooms: [room] }],
    [`GET /hub/v1/rooms/${R1}/messages`]: () => [200, { entries, room }],
    [`POST /hub/v1/rooms/${R1}/messages`]: () => [200, { receipt: { messageId: "m1", contentDigest: "d", stage: "queued", sequence: 0, at: 1 } }],
    [`POST /hub/v1/rooms/${R1}/files`]: (_b, init) => upload(init),
  };
  const fetchImpl = async (path: string, init: any = {}) => {
    const method = init.method || "GET", body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, path, body, headers: init.headers ?? {} });
    const key = `${method} ${path.split("?")[0]}`;
    const [status, json] = routes[key] ? routes[key]!(body, init) : [404, { code: "not-found" }];
    return { ok: status >= 200 && status < 300, status, json: async () => json, headers: { get: () => null } };
  };
  client.setHubClient(client.createHubWebClient({ fetchImpl }));
  hubPanel.resetHubSession();
  return { calls };
}
async function openRoom(lang = "en") {
  i18n.setLang(lang, { store: false });
  const pg = page({ url: `http://127.0.0.1:19281/ui/hub?room=${R1}`, storage: { agend_tour_done: "1" } });
  pg.document.body.setAttribute("data-hub", "hub"); pg.document.body.setAttribute("data-hub-name", "Team Hub"); mounted.push(pg);
  router.startRouter(pg.window);
  await pg.mount(h(hubPanel.HubPanel, { route: { panel: "hub", tab: "ask" }, navKey: `hub:ask|1|${lang}` }));
  await until(() => pg.root.querySelector(".hub-chat-main #msgIn"));
  return pg;
}
const choose = async (pg: AppPage, files: File[]) => {
  const input = pg.root.querySelector('.hub-chat-main input[type="file"]') as any;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fire(input, "change"); await settle(20);
};

describe("Hub chat attachments (D2)", () => {
  it("a room whose link takes files: Attach uploads at once, lists the file, and Send names its id", async () => {
    const { calls } = hubApi(["attachments-v1", "quota-band-v1"]);
    const pg = await openRoom();
    expect(pg.root.querySelector("#attachBtn")!.getAttribute("aria-label")).toBe("Attach files");
    expect(pg.root.querySelector(".hub-files-off")).toBeNull();
    await choose(pg, [new File([new Uint8Array([1, 2, 3])], "chart 1.png", { type: "image/png" })]);
    await until(() => pg.root.querySelector(".hub-pending-files .file-chip[data-state=ready]"));
    const up = calls.find(c => c.method === "POST" && c.path.endsWith("/files"))!;
    expect(up.headers["X-File-Name"]).toBe("chart%201.png"); expect(up.headers["X-AgEnD-Hub-CSRF"]).toBe("c".repeat(64)); expect(up.body).toBeInstanceOf(Blob);
    expect(pg.root.querySelector(".hub-pending-files .nm")!.textContent).toBe("chart 1.png");
    const box = pg.root.querySelector("#msgIn") as any; box.value = "See the chart"; fire(box, "input"); await settle(5);
    (pg.root.querySelector("#sendBtn") as any).click();
    await until(() => calls.some(c => c.method === "POST" && c.path.endsWith("/messages")));
    expect(calls.find(c => c.method === "POST" && c.path.endsWith("/messages"))!.body).toMatchObject({ text: "See the chart", files: [FILE] });
    await until(() => !pg.root.querySelector(".hub-pending-files"));
    expect(pg.root.querySelector(".hub-pending-files")).toBeNull();
  });

  it("a refused file says why and is not listed; nothing is sent with it", async () => {
    const { calls } = hubApi(["attachments-v1"], () => [415, { code: "type-not-allowed" }]);
    const pg = await openRoom();
    await choose(pg, [new File(["<svg/>"], "logo.svg")]);
    await until(() => pg.root.querySelector(".hub-chat-main [role=alert]"));
    expect(pg.root.querySelector(".hub-chat-main [role=alert]")!.textContent).toContain("logo.svg wasn't attached: this type isn't allowed");
    expect(pg.root.querySelector(".hub-pending-files")).toBeNull();
    expect(calls.filter(c => c.method === "POST" && c.path.endsWith("/messages"))).toHaveLength(0);
  });

  it.each(["en", "zh-TW"])("a room whose link does not take files (%s): no Attach, a line saying so", async (lang) => {
    hubApi([]);
    const pg = await openRoom(lang);
    expect(pg.root.querySelector("#attachBtn")).toBeNull();
    expect(pg.root.querySelector(".hub-files-off")!.textContent).toBe(lang === "en" ? "This agent can't receive files yet." : "這個代理目前還不能接收檔案。");
  });

  it("an answer's file shows in the thread from its room URL", async () => {
    const url = `/hub/v1/rooms/${R1}/files/${FILE}`;
    hubApi(["attachments-v1"], undefined, [{ messageId: "m1", sequence: 1, askedAt: 1, receipt: { stage: "answered", at: 2 }, question: "Q?", answer: "Here.",
      answerFiles: [{ id: FILE, name: "q3.csv", size: 120, mime: "text/csv", url }] }]);
    const pg = await openRoom();
    await until(() => pg.root.querySelector(".msg.agent"));
    await until(() => pg.root.innerHTML.includes(url), 100);
    expect(pg.root.innerHTML).toContain(url); expect(pg.root.textContent).toContain("q3.csv");
  });
});
