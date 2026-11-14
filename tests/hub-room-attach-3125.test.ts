/**
 * M-3125 PR1b: the Attach button in a group room (src/ui/hub-room-thread.js → RoomComposer's `attach`/`pending`, #3923), on the
 * whole Hub page against tests/support/hub-rooms-fixture.ts. A room whose detail says `attachments-v1` shows the Fleet's Attach;
 * a chosen file uploads at once to the room's file route and shows as a chip; Send names the ready file ids and clears the chips.
 * A room without the feature (an older Hub) shows no Attach, and Send waits while a file is still uploading.
 */
import { afterEach, beforeAll, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { createHubRoomsFixture } from "./support/hub-rooms-fixture.js";

let client: any, shell: any, store: any, router: any, i18n: any, hubPanel: any;
const mounted: AppPage[] = [];
const g = globalThis as any;
const realFetch = g.fetch, realES = g.EventSource;
const until = async (fn: () => unknown, n = 200) => { for (let i = 0; i < n && !fn(); i++) await settle(5); };
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  store = await import("/assets/app-store.js"); router = await import("/assets/app-nav.js"); shell = await import("/assets/app-shell.js");
  i18n = await import("/assets/app-i18n.js"); client = await import("/ui/js/hub-client.js"); hubPanel = await import("/ui/js/panel-hub.js");
  pg.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); i18n.setLang("en", { store: false }); g.fetch = realFetch; g.EventSource = realES; });

const FILE_ID = "aaaaaaaa-0000-4000-8000-0000000000f1";
async function roomPage({ features, hold = false }: { features: boolean; hold?: boolean }) {
  const fx = createHubRoomsFixture(), posts: any[] = [], uploads: string[] = [];
  let release = () => {};
  const held = new Promise<void>(r => { release = r; });
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, headers: { get: () => "application/json" }, json: async () => body, text: async () => JSON.stringify(body) });
  g.fetch = async (url: string, init?: any) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (path === "/hub/v1/rooms/room-weekly/files" && init?.method === "POST") {
      uploads.push(init.headers?.["X-File-Name"] ?? init.headers?.get?.("X-File-Name") ?? "");
      if (hold) await held;
      return json(200, { file: { id: FILE_ID, name: "plan.png", size: 1024, mime: "image/png", url: `/hub/v1/rooms/room-weekly/files/${FILE_ID}` } });
    }
    if (path === "/hub/v1/rooms/room-weekly/messages" && init?.method === "POST") posts.push(JSON.parse(init.body));
    const res: any = await fx.fetch(url, init);
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
  await until(() => pg.root.querySelectorAll(".hub-room-page .thread .msg").length > 5 && pg.root.querySelector(".hub-room-page #msgIn"));
  return { pg, posts, uploads, release };
}
const choose = async (pg: AppPage) => {
  const input = pg.root.querySelector('.hub-room-page input[type="file"]') as any;
  Object.defineProperty(input, "files", { value: [new File([new Uint8Array(1024)], "plan.png", { type: "image/png" })], configurable: true });
  fire(input, "change"); await settle(20);
};
const chips = (pg: AppPage) => [...pg.root.querySelectorAll(".hub-room-page .hub-pending-files .file-chip")].map((c: any) => c.getAttribute("data-state"));
const send = async (pg: AppPage, text: string) => {
  const box = pg.root.querySelector(".hub-room-page #msgIn") as any; box.value = text; fire(box, "input"); await settle(5);
  fire(pg.root.querySelector(".hub-room-page #sendBtn")!, "click"); await settle(20);
};

it("a room that takes files: Attach uploads at once, shows the chip, and Send names the file id and clears it", async () => {
  const { pg, posts, uploads } = await roomPage({ features: true });
  expect(pg.root.querySelector(".hub-room-page #attachBtn")).toBeTruthy();
  await choose(pg);
  await until(() => chips(pg).includes("ready"));
  expect(uploads).toHaveLength(1); expect(chips(pg)).toEqual(["ready"]);
  await send(pg, "See the plan");
  await until(() => posts.length);
  expect(posts[0]).toMatchObject({ text: "See the plan", files: [FILE_ID] });
  await until(() => !chips(pg).length);
  expect(chips(pg)).toEqual([]);
});

it("files alone: Send is on with ready files and an empty box, and posts the files with no text", async () => {
  const { pg, posts } = await roomPage({ features: true });
  const sendBtn = () => pg.root.querySelector(".hub-room-page #sendBtn") as any;
  expect(sendBtn().disabled).toBe(true);
  await choose(pg); await until(() => chips(pg).includes("ready"));
  expect(sendBtn().disabled).toBe(false);
  fire(sendBtn(), "click"); await until(() => posts.length);
  expect(posts[0]).toMatchObject({ text: "", files: [FILE_ID] });
});

it("Send waits while a file is still uploading, and says so", async () => {
  const { pg, posts, release } = await roomPage({ features: true, hold: true });
  await choose(pg);
  expect(chips(pg)).toEqual(["uploading"]);
  await send(pg, "Too soon");
  expect(posts).toEqual([]);
  expect(pg.root.querySelector(".hub-room-page [role=alert]")?.textContent).toBe("Wait until the files are uploaded.");
  release(); await until(() => chips(pg).includes("ready"));
});

it("a room without the files feature (an older Hub) shows no Attach, and Send carries no files", async () => {
  const { pg, posts } = await roomPage({ features: false });
  expect(pg.root.querySelector(".hub-room-page #attachBtn")).toBeNull();
  await send(pg, "Plain text");
  await until(() => posts.length);
  expect(posts[0]).not.toHaveProperty("files");
});
