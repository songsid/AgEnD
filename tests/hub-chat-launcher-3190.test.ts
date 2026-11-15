/**
 * M-3190 (Argon's chat-first review): 對話 opens the most recent room once per visit — replacing the history entry, so Back on it
 * doesn't loop into the room — and the launcher lists the agents the person can talk to: one row per shared agent (an agent they
 * already have a chat with is that chat's row, not a second one), the Hub assistant, and the other people's agents in their rooms
 * (never their own). On the real shell over the seam-1 fixture (tests/support/hub-rooms-fixture.ts).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { createHubRoomsFixture, FIXTURE_ME } from "./support/hub-rooms-fixture.js";

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
async function hubAt(path: string, { askable = [] as any[], myAgentIn = "", catalogFails = 0 } = {}) {
  const fx = createHubRoomsFixture(), realFetch = g.fetch;
  g.fetch = async (url: string, init?: any) => {
    const p = new URL(url, "http://127.0.0.1:19280").pathname;
    if (p === "/hub/v1/exposures" && catalogFails > 0) { catalogFails--; return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({ code: "unreachable" }), text: async () => "" }; }
    if (p === "/hub/v1/exposures") return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ mine: [], askable }), text: async () => "" };
    const res = await fx.fetch(url, init);
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
