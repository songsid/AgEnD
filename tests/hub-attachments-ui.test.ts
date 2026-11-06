/**
 * #3226 D2: files in the Hub chat (a mini DOM, the real HubPanel over a scripted Hub API).
 * - a room whose fleet link took attachments-v1 shows Attach; one without it shows no Attach, only a line saying files
 *   can't be sent yet (never a dead control);
 * - choosing files uploads each at once (raw body, its name percent-encoded, the CSRF token) and lists it under the
 *   composer; Send names the uploaded ids; a refused file says why and is not listed; the answer's files show in the thread;
 * - review r1: a tab whose Hub client or room store predates D2 offers no Attach (a reload line), never a question that
 *   loses its files; chosen files stay listed and hold Send while the room can't take them; a sent question clears only
 *   its own files; overlapping choices never hold more than ten, and a removed or left-behind file is never uploaded.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let att: any;

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
  att = await import("/ui/js/hub-attachments.js");
  pg.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); i18n.setLang("en", { store: false }); });

const R1 = "11111111-2222-4333-8444-555555555555", FILE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SIGNED = { signedIn: true, displayName: "Alex", login: "alex", admin: false, csrf: "c".repeat(64), hub: { name: "Team Hub" } };
type Reply = [number, unknown] | Promise<[number, unknown]>;
function hubApi(features: string[], upload: (init: any) => Reply = () => [200, { file: { id: FILE, name: "chart 1.png", size: 3, mime: "image/png", url: `/hub/v1/rooms/${R1}/files/${FILE}` } }],
  entries: unknown[] = [], { ask }: { ask?: () => Reply } = {}) {
  const calls: { method: string; path: string; body: any; headers: any }[] = [];
  const room = { id: R1, exposureId: "e1", grantId: "g1", state: "active", exposureName: "Sales numbers", ownerName: "Olivia", exposureState: "published", grantExpiresAt: 2_000_000_000_000, lastAt: 1, waiting: false, features };
  const routes: Record<string, (body: any, init: any) => Reply> = {
    "GET /hub/v1/session": () => [200, SIGNED],
    "GET /hub/v1/exposures": () => [200, { mine: [], askable: [] }],
    "GET /hub/v1/rooms": () => [200, { rooms: [room] }],
    [`GET /hub/v1/rooms/${R1}/messages`]: () => [200, { entries, room }],
    [`POST /hub/v1/rooms/${R1}/messages`]: () => (ask ? ask() : [200, { receipt: { messageId: "m1", contentDigest: "d", stage: "queued", sequence: 0, at: 1 } }]),
    [`POST /hub/v1/rooms/${R1}/files`]: (_b, init) => upload(init),
  };
  const fetchImpl = async (path: string, init: any = {}) => {
    const method = init.method || "GET", body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, path, body, headers: init.headers ?? {} });
    const key = `${method} ${path.split("?")[0]}`;
    const [status, json] = routes[key] ? await routes[key]!(body, init) : [404, { code: "not-found" }];
    return { ok: status >= 200 && status < 300, status, json: async () => json, headers: { get: () => null } };
  };
  client.setHubClient(client.createHubWebClient({ fetchImpl }));
  hubPanel.resetHubSession();
  return { calls, room };
}
const fileReply = (id: string, name: string): [number, unknown] => [200, { file: { id, name, size: 1, mime: "text/plain", url: `/hub/v1/rooms/${R1}/files/${id}` } }];
const uuidOf = (n: number) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, "0")}`;
const held = <T,>() => { let release!: (v: T) => void; const p = new Promise<T>((r) => { release = r; }); return { p, release }; };
const type = async (pg: AppPage, text: string) => { const box = pg.root.querySelector("#msgIn") as any; box.value = text; fire(box, "input"); await settle(5); };
const asks = (calls: { method: string; path: string }[]) => calls.filter(c => c.method === "POST" && c.path.endsWith("/messages"));
const chips = (pg: AppPage) => [...pg.root.querySelectorAll(".hub-pending-files .file-chip")].map((c: any) => `${c.querySelector(".nm").textContent}:${c.getAttribute("data-state")}`);
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

  it("a tab whose Hub client predates D2 (no upload; its ask drops extras) offers no Attach and asks for a reload", async () => {
    const { calls } = hubApi(["attachments-v1"]);
    const fresh = client.hubClient();
    // The D1 client exactly as far as D2 depends on it: no files mark, no upload, an ask of three arguments.
    const { filesV1: _m, upload: _u, ...d1 } = fresh;
    client.setHubClient({ ...d1, ask: (roomId: string, key: string, text: string) => fresh.ask(roomId, key, text) });
    const pg = await openRoom();
    expect(pg.root.querySelector("#attachBtn")).toBeNull();
    expect(pg.root.querySelector(".hub-files-off")!.textContent).toBe("Reload the page to attach files.");
    await type(pg, "See the chart"); (pg.root.querySelector("#sendBtn") as any).click();
    await until(() => asks(calls).length);
    expect(asks(calls)[0]!.body).toEqual({ idempotencyKey: expect.any(String), text: "See the chart" });   // text only: nothing was ever attached
  });

  it("the files mark needs both the client and the room store (an older store passes nothing it doesn't know)", () => {
    const c = client.createHubWebClient({ fetchImpl: async () => ({}) });
    expect([att.pageCarriesFiles(c, { filesV1: true }), att.pageCarriesFiles(c, {}), att.pageCarriesFiles({ ...c, upload: undefined }, { filesV1: true }),
      att.pageCarriesFiles({ ...c, filesV1: undefined }, { filesV1: true }), att.pageCarriesFiles(null, { filesV1: true })]).toEqual([true, false, false, false, false]);
  });

  it("losing attachments-v1 keeps the chosen files listed and holds Send; nothing goes as text only until they are removed", async () => {
    const { calls, room } = hubApi(["attachments-v1"]);
    const pg = await openRoom();
    await choose(pg, [new File(["x"], "chart.png", { type: "image/png" })]);
    await until(() => pg.root.querySelector(".hub-pending-files .file-chip[data-state=ready]"));
    room.features = [];                                             // the next read: the link no longer takes files
    fire(pg.document, "visibilitychange");
    await until(() => pg.root.querySelector(".hub-files-off"));
    expect(pg.root.querySelector("#attachBtn")).toBeNull();
    expect(chips(pg)).toEqual(["chart 1.png:ready"]);
    await type(pg, "See the chart"); (pg.root.querySelector("#sendBtn") as any).click(); await settle(20);
    expect(asks(calls)).toHaveLength(0);
    expect(pg.root.querySelector(".hub-chat-main [role=alert]")!.textContent).toContain("remove the files to send only the text");
    (pg.root.querySelector(".hub-pending-files .chip-x") as any).click(); await settle(10);
    (pg.root.querySelector("#sendBtn") as any).click();
    await until(() => asks(calls).length);
    expect(asks(calls)[0]!.body).toEqual({ idempotencyKey: expect.any(String), text: "See the chart" });
  });

  it("a sent question clears only its own files: one chosen while it was on its way stays; a refused send keeps them all", async () => {
    let n = 0; const answers: ReturnType<typeof held<[number, unknown]>>[] = [];
    const { calls } = hubApi(["attachments-v1"], () => { n++; return fileReply(uuidOf(n), n === 1 ? "first.txt" : "second.txt"); }, [],
      { ask: () => { const h = held<[number, unknown]>(); answers.push(h); return h.p; } });
    const pg = await openRoom();
    await choose(pg, [new File(["1"], "first.txt")]);
    await until(() => chips(pg).join() === "first.txt:ready");
    await type(pg, "One"); (pg.root.querySelector("#sendBtn") as any).click();
    await until(() => answers.length === 1);
    await choose(pg, [new File(["2"], "second.txt")]);
    await until(() => chips(pg).join() === "first.txt:ready,second.txt:ready");
    answers[0]!.release([200, { receipt: { messageId: "m1", contentDigest: "d", stage: "queued", sequence: 0, at: 1 } }]);
    await until(() => chips(pg).join() === "second.txt:ready");
    expect(asks(calls)[0]!.body.files).toEqual([uuidOf(1)]);
    expect(chips(pg)).toEqual(["second.txt:ready"]);
    // Refused: everything stays for another try.
    await type(pg, "Two"); (pg.root.querySelector("#sendBtn") as any).click();
    await until(() => answers.length === 2);
    answers[1]!.release([409, { code: "incompatible" }]);
    await until(() => pg.root.querySelector(".hub-chat-main [role=alert]"));
    expect(asks(calls)[1]!.body.files).toEqual([uuidOf(2)]);
    expect(chips(pg)).toEqual(["second.txt:ready"]);
  });
});

describe("uploadChosen bounds (D2 review r1)", () => {
  const owner = () => { let list: any[] = []; return { current: () => list, set: (next: any[]) => { list = next; } }; };
  const files = (k: number, tag: string) => Array.from({ length: k }, (_, i) => new File(["x"], `${tag}${i}.txt`));
  it("two overlapping ten-file choices hold ten in all; the second is refused at once", async () => {
    const o = owner(), gates: ReturnType<typeof held<any>>[] = [];
    const up = { upload: () => { const h = held<any>(); gates.push(h); return h.p; } };
    const a = att.uploadChosen(up, R1, files(10, "a"), o), b = att.uploadChosen(up, R1, files(10, "b"), o);
    expect(o.current()).toHaveLength(10);
    expect(await b).toEqual(["At most 10 files per question."]);
    for (let i = 0; i < 10; i++) { await until(() => gates.length > i, 50); gates[i]!.release({ ok: true, ...(fileReply(uuidOf(i + 1), `a${i}.txt`)[1] as object) }); }
    await a;
    expect(o.current().map((f: any) => f.state)).toEqual(Array(10).fill("ready"));
    expect(gates).toHaveLength(10);
  });
  it("a file removed before its turn is not uploaded; one removed during its upload does not come back", async () => {
    const o = owner(), gates: ReturnType<typeof held<any>>[] = [], sent: string[] = [];
    const up = { upload: (_r: string, f: File) => { sent.push(f.name); const h = held<any>(); gates.push(h); return h.p; } };
    const run = att.uploadChosen(up, R1, files(3, "f"), o);
    await until(() => gates.length === 1, 50);
    o.set(o.current().filter((f: any) => f.name !== "f0.txt" && f.name !== "f1.txt"));   // f0 uploading, f1 queued
    gates[0]!.release({ ok: true, ...(fileReply(uuidOf(1), "f0.txt")[1] as object) });
    await until(() => gates.length === 2, 50);
    gates[1]!.release({ ok: true, ...(fileReply(uuidOf(3), "f2.txt")[1] as object) });
    await run;
    expect(sent).toEqual(["f0.txt", "f2.txt"]);
    expect(o.current().map((f: any) => `${f.name}:${f.state}`)).toEqual(["f2.txt:ready"]);
  });
  it("once the room is left, no queued upload starts and nothing is written back", async () => {
    const o = owner(), gates: ReturnType<typeof held<any>>[] = []; let alive = true;
    const up = { upload: () => { const h = held<any>(); gates.push(h); return h.p; } };
    const run = att.uploadChosen(up, R1, files(3, "g"), { ...o, alive: () => alive });
    await until(() => gates.length === 1, 50);
    const before = o.current();
    alive = false; gates[0]!.release({ ok: true, ...(fileReply(uuidOf(1), "g0.txt")[1] as object) });
    await run;
    expect(gates).toHaveLength(1);
    expect(o.current()).toBe(before);
  });
  it("left before its first turn (or between turns), nothing is uploaded", async () => {
    const o = owner(); let n = 0;
    await att.uploadChosen({ upload: async () => { n++; return { ok: false, status: 0 }; } }, R1, files(2, "h"), { ...o, alive: () => false });
    expect(n).toBe(0);
  });
});
