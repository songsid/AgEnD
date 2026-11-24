/**
 * M-3190 (Argon's chat-first review): 對話 opens the most recent room once per visit — replacing the history entry, so Back on it
 * doesn't loop into the room — and the launcher lists the agents the person can talk to: one row per shared agent (an agent they
 * already have a chat with is that chat's row, not a second one), the Hub assistant, and the other people's agents in their rooms
 * (never their own). On the real shell over the seam-1 fixture (tests/support/hub-rooms-fixture.ts).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { createHubRoomsFixture, FIXTURE_ME } from "./support/hub-rooms-fixture.js";
import { fire } from "./helpers/mini-dom.js";

const g = globalThis as any;
let client: any, shell: any, store: any, router: any, i18n: any, hubPanel: any;
const mounted: AppPage[] = [];
const realES = g.EventSource;
const until = async (fn: () => unknown, n = 400) => { for (let i = 0; i < n && !fn(); i++) await settle(5); };
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui/hub", storage: { agend_tour_done: "1" } });
  store = await import("/assets/app-store.js"); router = await import("/assets/app-nav.js"); shell = await import("/assets/app-shell.js");
  i18n = await import("/assets/app-i18n.js"); client = await import("/ui/js/hub-client.js"); hubPanel = await import("/ui/js/panel-hub.js");
  pg.restore();
});
afterEach(async () => { for (const p of mounted.splice(0).reverse()) { await p.unmount(); p.restore(); } client.setHubClient(null); i18n.setLang("en", { store: false }); g.EventSource = realES; });

/** The Hub app at `path` on the fixture; `askable` answers the catalog; `myAgentIn`: the room whose members also list one of mine. */
/** `list`: reshapes the room list's answer (GET /hub/v1/rooms) — which rooms this person has, and when each last moved. */
async function hubAt(path: string, { askable = [] as any[], myAgentIn = "", catalogFails = 0, list = null as null | ((rooms: any[]) => any[]) } = {}) {
  const fx = createHubRoomsFixture(), realFetch = g.fetch;
  g.fetch = async (url: string, init?: any) => {
    const p = new URL(url, "http://127.0.0.1:19280").pathname;
    if (p === "/hub/v1/exposures" && catalogFails > 0) { catalogFails--; return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({ code: "unreachable" }), text: async () => "" }; }
    if (p === "/hub/v1/exposures") return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ mine: [], askable }), text: async () => "" };
    const res = await fx.fetch(url, init);
    if (list && p === "/hub/v1/rooms" && (!init || !init.method || init.method === "GET")) {
      const body = await res.json();
      return { ...res, ok: true, status: 200, json: async () => ({ ...body, rooms: list(body.rooms) }) };
    }
    if (myAgentIn && p === `/hub/v1/rooms/${myAgentIn}` && (!init || !init.method || init.method === "GET")) {
      const body = await res.json();
      body.members = [...body.members, { kind: "agent", id: "exp-mine-1", name: "my-notes", owner: { name: FIXTURE_ME.name }, mine: true }];
      return { ...res, ok: true, status: 200, json: async () => body };
    }
    return res;
  };
  g.EventSource = fx.EventSource;
  const pg = page({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1" } });
  pg.document.body.setAttribute("data-hub", "hub"); mounted.push(pg);
  // What the router writes to the history (pushState: a new entry; replaceState: this one replaced).
  const writes: Array<[string, string]> = [];
  for (const kind of ["pushState", "replaceState"] as const) {
    const real = pg.window.history[kind].bind(pg.window.history);
    pg.window.history[kind] = (state: unknown, title: string, url: string) => { writes.push([kind, String(url)]); return real(state, title, url); };
  }
  client.setHubClient(client.createHubWebClient()); hubPanel.resetHubSession(); router.startRouter(pg.window); store.applyStatus({ instances: [] });
  await pg.mount(h(shell.Shell, { panels: new Map([["hub", { Component: hubPanel.HubPanel }]]), onNewInstance() {} }));
  return { pg, writes, restore: () => { g.fetch = realFetch; } };
}
const rows = (pg: AppPage) => [...pg.root.querySelectorAll(".hub-launch-row")].map((r: any) => [r.querySelector("strong").textContent, r.querySelector("small").textContent]);

describe("M-3190: 對話 opens the most recent room once, without a history entry to come back into", () => {
  it("the first visit replaces /ui/hub with the room (no new entry); 對話 again shows the launcher, not the room", async () => {
    const { pg, writes, restore } = await hubAt("/ui/hub");
    try {
      await until(() => pg.window.location.search.startsWith("?room="));
      const opened = pg.window.location.search;
      expect(writes.filter(([, url]) => url.includes("?room="))).toEqual([["replaceState", `/ui/hub${opened}`]]);
      router.navigate("/ui/hub"); await settle(30);
      await until(() => pg.root.querySelector(".hub-launch-title"));
      expect([pg.window.location.search, !!pg.root.querySelector(".hub-launch-title")]).toEqual(["", true]);
    } finally { restore(); }
  });
});

/**
 * M-3204: the room list as the real Hub sends it — a 1:1 chat has no preview text (src/hub/rooms/direct-view.ts), and the Hub
 * assistant's chat is made for everyone when the list is read, so an unused one is the newest thing there.
 */
const asTheHubSends = (rooms: any[]) => rooms.map((r) => r.kind === "direct" && !r.assistant ? { ...r, lastText: "", lastAuthor: "" }
  : r.assistant && !r.lastText ? { ...r, lastAt: Date.now() } : r);
const opensFirst = async (list: (rooms: any[]) => any[]) => {
  const { pg, writes, restore } = await hubAt("/ui/hub", { list: (rooms) => list(asTheHubSends(rooms)) });
  try {
    await until(() => pg.window.location.search.startsWith("?room=") || pg.root.querySelector(".hub-launch-title"));
    await settle(30);
    return { search: pg.window.location.search, launcher: !!pg.root.querySelector(".hub-launch-title"), writes: writes.filter(([, u]) => u.includes("?room=")) };
  } finally { restore(); }
};
const at = (rooms: any[], id: string, lastAt: number) => rooms.map((r) => (r.id === id ? { ...r, lastAt } : r));
const latest = (rooms: any[]) => Math.max(...rooms.filter((r) => !r.assistant).map((r) => r.lastAt));

describe("M-3204: 對話 opens the most recent room or 1:1 chat by when it last moved, not by its preview text", () => {
  it("a member with only 1:1 chats gets the most recent one (the unused Hub assistant chat is not one)", async () => {
    const got = await opensFirst((rooms) => rooms.filter((r) => r.kind === "direct"));
    expect(got).toEqual({ search: "?room=room-helper", launcher: false, writes: [["replaceState", "/ui/hub?room=room-helper"]] });
  });
  it("with rooms and 1:1 chats, the newest of either opens", async () => {
    expect((await opensFirst((rooms) => at(rooms, "room-report", latest(rooms) + 60_000))).search).toBe("?room=room-report");
    expect((await opensFirst((rooms) => at(rooms, "room-weekly", latest(rooms) + 60_000))).search).toBe("?room=room-weekly");
  });
  it("only an unused Hub assistant chat: the launcher, not the assistant", async () => {
    const got = await opensFirst((rooms) => rooms.filter((r) => r.assistant));
    expect([got.search, got.launcher, got.writes]).toEqual(["", true, []]);
  });
  it("a Hub assistant chat that was used counts like any other chat", async () => {
    const got = await opensFirst((rooms) => rooms.filter((r) => r.assistant).map((r) => ({ ...r, lastText: "幫我整理今天的待辦", lastAt: Date.now() })));
    expect(got.search).toBe("?room=room-assistant");
  });
});

describe("M-3190: the launcher's rows", () => {
  it("the agents in my rooms are the other people's — never my own agent there", async () => {
    const { pg, restore } = await hubAt("/ui/hub?view=new", { myAgentIn: "room-weekly" });
    try {
      await until(() => rows(pg).some(([, sub]) => sub === "In #每週主管會議"));
      const inWeekly = rows(pg).filter(([, sub]) => sub === "In #每週主管會議").map(([name]) => name);
      expect(inWeekly).toContain("spec-writer");
      expect(rows(pg).map(([name]) => name)).not.toContain("my-notes");
    } finally { restore(); }
  });
  it("an agent shared with me that I already have a chat with is that chat's row — not a second row; one I haven't asked is its own row", async () => {
    const askable = [
      { exposure: { id: "exp-01", displayName: "project-helper", revision: 1 }, grant: { id: "g-01", expiresAt: 2_000_000_000_000 }, ownerName: "林小華" },   // room-helper's agent
      { exposure: { id: "exp-77", displayName: "fresh-agent", revision: 1 }, grant: { id: "g-77", expiresAt: 2_000_000_000_000 }, ownerName: "吳小安" },
    ];
    const { pg, restore } = await hubAt("/ui/hub?view=new", { askable });
    try {
      await until(() => rows(pg).some(([name]) => name === "fresh-agent"));
      const owned = rows(pg).filter(([, sub]) => sub.startsWith("Owner: "));
      expect(owned.filter(([name]) => name === "project-helper")).toHaveLength(1);
      expect(owned.filter(([name]) => name === "fresh-agent")).toEqual([["fresh-agent", "Owner: 吳小安"]]);
      // The chat's row opens that chat (its own address); the new one asks the Hub to open a chat.
      const helper = [...pg.root.querySelectorAll(".hub-launch-row")].find((r: any) => r.querySelector("strong").textContent === "project-helper") as any;
      expect(helper.getAttribute("href")).toBe("/ui/hub?room=room-helper");
    } finally { restore(); }
  });
});

describe("M-3190: the launcher's catalog read", () => {
  // M-3567 (dev-claude2's diagnosis, 11-24): a grant given while the page was away (a Team's) showed only after a reload —
  // the 30 s poll pauses while the page is hidden. Coming back (shown again, or its window focused) reads the list again.
  it("a grant given while the page was away is listed on return; hidden reads nothing; one return, one read", async () => {
    const askable: any[] = [];
    const { pg, restore } = await hubAt("/ui/hub?view=new", { askable });
    const realFetch = g.fetch; let reads = 0, roomReads = 0;
    g.fetch = async (url: string, init?: any) => { const p = new URL(url, "http://127.0.0.1:19280").pathname;
      if (p === "/hub/v1/exposures") reads++; if (p === "/hub/v1/rooms" && (!init?.method || init.method === "GET")) roomReads++; return realFetch(url, init); };
    try {
      await until(() => pg.root.querySelector(".hub-launch"));
      await settle(10);
      expect(rows(pg).map(([name]) => name)).not.toContain("team-agent");
      // While away, the agent is shared with the person's Team.
      askable.push({ exposure: { id: "exp-88", displayName: "team-agent", revision: 1 }, grant: { id: "g-88", expiresAt: 2_000_000_000_000 }, ownerName: "吳小安" });
      const doc = globalThis.document as any, setHidden = (v: boolean) => Object.defineProperty(doc, "hidden", { configurable: true, get: () => v });
      setHidden(true); fire(doc, "visibilitychange"); await settle(10);
      expect([reads, rows(pg).some(([name]) => name === "team-agent")], "hidden: nothing read").toEqual([0, false]);
      setHidden(false); fire(doc, "visibilitychange"); await until(() => rows(pg).some(([name]) => name === "team-agent"));
      expect(reads, "back: read once").toBe(1);
      expect(roomReads, "the room list too, once").toBe(1);
      fire(globalThis.window as any, "focus"); await settle(10);
      expect(reads, "the focus that comes with the same return: no second read").toBe(1);
    } finally { delete (globalThis.document as any).hidden; g.fetch = realFetch; restore(); }
  });

  it("a failed read says so with Retry; Retry reads again and the rows come", async () => {
    const askable = [{ exposure: { id: "exp-77", displayName: "fresh-agent", revision: 1 }, grant: { id: "g-77", expiresAt: 2_000_000_000_000 }, ownerName: "吳小安" }];
    const { pg, restore } = await hubAt("/ui/hub?view=new", { askable, catalogFails: 1 });
    try {
      await until(() => pg.root.querySelector(".hub-launch .error-state button"));
      expect(rows(pg).map(([name]) => name)).not.toContain("fresh-agent");
      (pg.root.querySelector(".hub-launch .error-state button") as any).click();
      await until(() => rows(pg).some(([name]) => name === "fresh-agent"));
      expect(pg.root.querySelector(".hub-launch .error-state")).toBe(null);
    } finally { restore(); }
  });
});
