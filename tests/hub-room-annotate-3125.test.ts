/**
 * M-3125 PR3: a Hub room's picture opens in the Fleet chat's own viewer (/assets/image-lightbox.js), and 「標註」 quotes the
 * marked-up copy in the room: it joins the composer's files (uploaded at once, like a chosen file) and the reply quotes the
 * message it came from. The viewer takes a Hub room picture only at its exact inline route; a room that takes no files offers
 * no 「標註」 target (the picture still opens).
 */
import { afterEach, beforeAll, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { createHubRoomsFixture } from "./support/hub-rooms-fixture.js";

let client: any, shell: any, store: any, router: any, i18n: any, hubPanel: any, lb: any;
const mounted: AppPage[] = [];
const g = globalThis as any;
const realFetch = g.fetch, realES = g.EventSource;
const until = async (fn: () => unknown, n = 200) => { for (let i = 0; i < n && !fn(); i++) await settle(5); };
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  store = await import("/assets/app-store.js"); router = await import("/assets/app-nav.js"); shell = await import("/assets/app-shell.js");
  i18n = await import("/assets/app-i18n.js"); client = await import("/ui/js/hub-client.js"); hubPanel = await import("/ui/js/panel-hub.js");
  lb = await import("/assets/image-lightbox.js");
  pg.restore();
});
afterEach(async () => { lb.closeLightbox(); for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); i18n.setLang("en", { store: false }); g.fetch = realFetch; g.EventSource = realES; });

const ROOM_UUID = "11111111-2222-4333-8444-555555555555", PIC = "aaaaaaaa-0000-4000-8000-0000000000a1", UPLOADED = "aaaaaaaa-0000-4000-8000-0000000000f1";
const PICTURE_POST = "bbbbbbbb-0000-4000-8000-0000000000b1";
async function roomPage({ features }: { features: boolean }) {
  const fx = createHubRoomsFixture(), posts: any[] = [], uploads: number[] = [];
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, headers: { get: () => "application/json" }, json: async () => body, text: async () => JSON.stringify(body) });
  g.fetch = async (url: string, init?: any) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (path === "/hub/v1/rooms/room-weekly/files" && init?.method === "POST") {
      uploads.push(1);
      return json(200, { file: { id: UPLOADED, name: "plan-annotated.png", size: 2048, mime: "image/png", url: `/hub/v1/rooms/room-weekly/files/${UPLOADED}` } });
    }
    if (path === "/hub/v1/rooms/room-weekly/messages" && init?.method === "POST") posts.push(JSON.parse(init.body));
    const res: any = await fx.fetch(url, init);
    if (path.startsWith("/hub/v1/rooms/room-weekly/messages") && (!init?.method || init.method === "GET")) {
      const body = await res.json();
      const picture = { id: PICTURE_POST, roomId: "room-weekly", at: Date.now(), author: { kind: "person", id: "p-chen", name: "陳主任" }, text: "The plan", mentions: [],
        files: [{ id: PIC, name: "plan.png", size: 1024, mime: "image/png", url: `/hub/v1/rooms/${ROOM_UUID}/files/${PIC}` }] };
      return json(res.status, { ...body, messages: [...(body.messages || []), picture] });
    }
    if (features && path === "/hub/v1/rooms/room-weekly" && (!init?.method || init.method === "GET")) {
      const body = await res.json(); return json(res.status, { ...body, room: { ...body.room, features: ["attachments-v1"] } });
    }
    return res;
  };
  g.EventSource = fx.EventSource;
  const pg = page({ url: "http://127.0.0.1:19280/ui/hub?room=room-weekly", storage: { agend_tour_done: "1" } });
  pg.document.body.setAttribute("data-hub", "hub"); pg.document.body.setAttribute("data-hub-name", "Team Hub"); mounted.push(pg);
  client.setHubClient(client.createHubWebClient()); hubPanel.resetHubSession(); router.startRouter(pg.window); store.applyStatus({ instances: [] });
  await pg.mount(h(shell.Shell, { panels: new Map([["hub", { Component: hubPanel.HubPanel || (() => null) }]]), onNewInstance() {} }));
  await until(() => pg.root.querySelector(".hub-room-page .thread a.att-img") && pg.root.querySelector(".hub-room-page #msgIn"));
  return { pg, posts, uploads };
}
const openPicture = async (pg: AppPage) => {
  const a = pg.root.querySelector(".hub-room-page .thread a.att-img") as any;
  expect(a.getAttribute("href")).toBe(`/hub/v1/rooms/${ROOM_UUID}/files/${PIC}/inline`);
  fire(a, "click"); await settle(10);
  return lb.lightboxStore.get().open;
};

it("a room picture opens in the viewer; 「標註」 quotes the marked-up copy here: uploaded, a chip, and the reply quotes its message", async () => {
  const { pg, posts, uploads } = await roomPage({ features: true });
  const open = await openPicture(pg);
  expect(open.items).toEqual([{ src: `/hub/v1/rooms/${ROOM_UUID}/files/${PIC}/inline`, name: "plan.png" }]);
  expect(open.annotate.targets.map((x: any) => x.label)).toEqual(["Quote in this room"]);
  expect(open.annotate.targets[0].quote(new File([new Uint8Array(2048)], "plan-annotated.png", { type: "image/png" }))).toBe(true);
  await until(() => pg.root.querySelector(".hub-room-page .hub-pending-files .file-chip[data-state=ready]"));
  expect(uploads).toHaveLength(1);
  lb.closeLightbox(); await settle(5);
  const box = pg.root.querySelector(".hub-room-page #msgIn") as any; box.value = "See my marks"; fire(box, "input"); await settle(5);
  fire(pg.root.querySelector(".hub-room-page #sendBtn")!, "click");
  await until(() => posts.length);
  expect(posts[0]).toMatchObject({ text: "See my marks", files: [UPLOADED], replyTo: PICTURE_POST });
});

it("zh-TW words; a quote after the page has gone does nothing", async () => {
  i18n.setLang("zh-TW", { store: false });
  const { pg, uploads } = await roomPage({ features: true });
  const open = await openPicture(pg);
  expect(open.annotate.targets[0].label).toBe("引用到這個房間");
  expect(open.annotate.targets[0].quote(new File([new Uint8Array(8)], "x.png", { type: "image/png" }), () => false)).toBe(false);
  await settle(20); expect(uploads).toHaveLength(0);
});

it("a room that takes no files: the picture still opens, with no 「標註」 target", async () => {
  const { pg } = await roomPage({ features: false });
  const open = await openPicture(pg);
  expect(open.items).toHaveLength(1);
  expect(open.annotate).toBeNull();
});

it("the viewer takes a Hub room picture only at its exact inline route", () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui/hub", storage: { agend_tour_done: "1" } }); mounted.push(pg);
  const link = (href: string) => { const a = pg.document.createElement("a"); a.setAttribute("href", href); return a; };
  const ok = (href: string) => { const a = link(href); const r = lb.openLightbox([a], a); lb.closeLightbox(); return r; };
  expect(ok(`/hub/v1/rooms/${ROOM_UUID}/files/${PIC}/inline`)).toBe(true);
  expect(ok("/ui/file/0123456789abcdef0123456789abcdef")).toBe(true);
  for (const bad of [`/hub/v1/rooms/${ROOM_UUID}/files/${PIC}`, `/hub/v1/rooms/${ROOM_UUID}/files/${PIC}/inline/x`, `/hub/v1/rooms/room-weekly/files/${PIC}/inline`,
    `https://evil.example/hub/v1/rooms/${ROOM_UUID}/files/${PIC}/inline`, `//evil.example/hub/v1/rooms/${ROOM_UUID}/files/${PIC}/inline`,
    `/hub/v1/rooms/${ROOM_UUID}/files/${PIC}/inline?x=1`, `/hub/v1/rooms/${ROOM_UUID}/files/${PIC.toUpperCase()}/inline`, `/x/hub/v1/rooms/${ROOM_UUID}/files/${PIC}/inline`])
    expect(ok(bad), bad).toBe(false);
});
