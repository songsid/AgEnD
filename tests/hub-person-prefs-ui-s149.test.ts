/** Real Hub web client + favourites source, held transports and the existing app DOM harness. */
import { afterEach, beforeAll, expect, it } from "vitest";
import { page, settle } from "./helpers/app-harness.js";
let fav: any, clientModule: any, pg: ReturnType<typeof page>;
const g = globalThis as any;
let oldAdd: any, oldRemove: any;
let handlers: Map<string, Set<() => void>>;
const key = "agend_hub_favorites.alex";
const known = new Set(["a", "b", "c"]);
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const until = async (test: () => boolean) => { for (let i = 0; i < 100 && !test(); i++) await settle(2); expect(test()).toBe(true); };
const defer = () => { let resolve!: (value?: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
beforeAll(async () => {
  pg = page();
  fav = await import("/ui/js/hub-room-favorites.js");
  clientModule = await import("/ui/js/hub-client.js");
  pg.restore();
});
afterEach(() => {
  fav.loadFavorites(null); fav.setFavoritesSource(null);
  g.addEventListener = oldAdd; g.removeEventListener = oldRemove;
  pg.restore();
});
async function world(seed?: { favorites: string[]; initialized: boolean; revision: number }, local = '["a"]') {
  pg = page({ storage: { [key]: local } });
  oldAdd = g.addEventListener; oldRemove = g.removeEventListener;
  handlers = new Map();
  g.addEventListener = (name: string, fn: () => void) => { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(fn); };
  g.removeEventListener = (name: string, fn: () => void) => handlers.get(name)?.delete(fn);
  let server = seed ?? { favorites: [], initialized: false, revision: 0 };
  const writes: any[] = [], requests: any[] = [];
  let readGate: ReturnType<typeof defer> | null = null, writeGate: ReturnType<typeof defer> | null = null, fail = false;
  const client = clientModule.createHubWebClient({ fetchImpl: async (url: string, init: any) => {
    requests.push({ url, ...init });
    if (url === "/hub/v1/session") return response({ signedIn: true, csrf: "alex-csrf", login: "alex", features: ["person-prefs-v1"] });
    if (fail) return response({ code: "unavailable" }, 503);
    if (init.method === "GET") { const value = { ...server }; if (readGate) await readGate.promise; return response(value); }
    const body = JSON.parse(init.body); writes.push(body);
    if (writeGate) { const held = writeGate; writeGate = null; await held.promise; }
    if (!body.onlyIfUnset || !server.initialized) server = { favorites: body.favorites, initialized: true, revision: server.revision + 1 };
    return response(server);
  } });
  const session = await client.session();
  const source = fav.createHubFavoritesSource(client, session);
  fav.setFavoritesSource(source); fav.loadFavorites("alex");
  return { client, session, source, writes, requests, get server() { return server; }, set server(s) { server = s; },
    holdRead: () => readGate = defer(), holdWrite: () => writeGate = defer(), fail: (v: boolean) => { fail = v; } };
}
const focus = () => { for (const fn of handlers.get("focus") ?? []) fn(); };

it("migrates a browser list once and a second browser follows the Hub's stored order", async () => {
  const w = await world(); await until(() => w.source.ready());
  expect(w.writes).toEqual([{ favorites: ["a"], onlyIfUnset: true }]);
  expect(w.requests.find((r: any) => r.method === "PUT").headers["X-AgEnD-Hub-CSRF"]).toBe("alex-csrf");
  expect(fav.favoritesStore.get().ids).toEqual(["a"]);
  fav.toggleFavorite("b", known); await until(() => w.server.revision === 2);
  fav.loadFavorites(null); g.localStorage.setItem(key, '["c"]');
  const next = fav.createHubFavoritesSource(w.client, w.session); fav.setFavoritesSource(next); fav.loadFavorites("alex");
  await until(() => next.ready());
  expect([fav.favoritesStore.get().ids, w.writes.length]).toEqual([["a", "b"], 2]);
});

it("never resurrects browser favourites over an initialized empty Hub list", async () => {
  const w = await world({ favorites: [], initialized: true, revision: 4 }); await until(() => w.source.ready());
  expect([fav.favoritesStore.get().ids, w.writes]).toEqual([[], []]);
});

it("refreshes another device's changes on focus and keeps the existing star/move rules", async () => {
  const w = await world({ favorites: ["b", "a"], initialized: true, revision: 2 }); await until(() => w.source.ready());
  w.server = { favorites: ["c", "a"], initialized: true, revision: 3 }; focus();
  await until(() => fav.favoritesStore.get().ids[0] === "c");
  fav.moveFavorite("a", -1, known); await until(() => w.server.revision === 4);
  expect(w.server.favorites).toEqual(["a", "c"]);
});

it("serializes held writes and keeps the latest edit instead of applying the older response", async () => {
  const w = await world({ favorites: ["a"], initialized: true, revision: 1 }); await until(() => w.source.ready());
  const held = w.holdWrite();
  fav.toggleFavorite("b", known); fav.toggleFavorite("c", known);
  expect(fav.favoritesStore.get().ids).toEqual(["a", "b", "c"]);
  held.resolve(); await until(() => w.server.revision === 3);
  expect([w.server.favorites, fav.favoritesStore.get().ids]).toEqual([["a", "b", "c"], ["a", "b", "c"]]);
});

it("ignores a held read after this person signs out and refuses queued writes with the old session", async () => {
  const w = await world({ favorites: ["a"], initialized: true, revision: 1 }); await until(() => w.source.ready());
  const held = w.holdRead(); focus(); await settle(4);
  fav.loadFavorites(null); await w.client.signOut(); held.resolve(); await settle(5);
  expect(fav.favoritesStore.get()).toEqual({ login: null, ids: [] });
  expect((await w.client.savePersonPrefs(w.session.csrf, ["c"])).ok).toBe(false);
  expect(w.server.favorites).toEqual(["a"]);
});

it("retries a failed save on focus without replacing the pending local edit", async () => {
  const w = await world({ favorites: ["a"], initialized: true, revision: 1 }); await until(() => w.source.ready());
  w.fail(true); fav.toggleFavorite("b", known); await settle(5);
  expect(fav.favoritesStore.get().ids).toEqual(["a", "b"]);
  w.fail(false); focus(); await until(() => w.server.revision === 2);
  expect(w.server.favorites).toEqual(["a", "b"]);
});

it("uses server favourites when local storage is blocked", async () => {
  const w = await world({ favorites: ["c"], initialized: true, revision: 1 });
  const real = Object.getOwnPropertyDescriptor(g, "localStorage")!;
  Object.defineProperty(g, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
  try {
    await until(() => w.source.ready());
    expect(fav.favoritesStore.get().ids).toEqual(["c"]);
    fav.toggleFavorite("a", known); await until(() => w.server.revision === 2);
    expect(w.server.favorites).toEqual(["c", "a"]);
  } finally { Object.defineProperty(g, "localStorage", real); }
});

it("configures the Hub source at the session seam and falls back for an older Hub", async () => {
  const w = await world({ favorites: ["b"], initialized: true, revision: 1 });
  fav.configureHubFavorites(w.client, w.session);
  await until(() => fav.favoritesStore.get().ids[0] === "b");
  fav.configureHubFavorites(w.client, null);
  expect(fav.favoritesStore.get()).toEqual({ login: null, ids: [] });
  g.localStorage.setItem("agend_hub_favorites.sam", '["c"]');
  fav.configureHubFavorites({}, { login: "sam" });
  expect(fav.favoritesStore.get()).toEqual({ login: "sam", ids: ["c"] });
});
