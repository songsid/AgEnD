/**
 * #2662: an Office share link on All offices with fleet-sized picture packs. A pack's pictures (immutable) have their own
 * minute per share, sized by the packs it shows — never the 120 requests of the page's reads; a 429 says when to come
 * back (Retry-After from the limiter's own minute) and the share page waits it out and asks again; the share's pack
 * carries only the character sets someone shown wears. Through the real gateway and the real loader (loadPackSkin with
 * the share page's picture reader), with a stub tunnel host: no cloudflared, no network.
 */
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ALL_OFFICES, OFFICE_SHARE_LIMITS, OfficeShareLimiter, OfficeShareView, OfficeShares, createOfficeShareGateway, sharePictureRate,
  type OfficeShareGateway, type OfficeShareSource } from "../src/office-share.js";
import type { Office } from "../src/web-office-store.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const MIN = 60_000, KiB = 1024, MiB = 1024 * KiB;
const HOST = "abc-def.trycloudflare.com";
const BASE_MANIFEST = JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "office-skin-clinic", "manifest.json"), "utf8"));
const POSES = ["idle", "working", "paused", "needs", "walk"];
const strip = (src: string) => ({ src, frames: 4, w: 32, h: 48, fps: 4, ax: 16, ay: 44 });

/**
 * A full pack (SKIN_LIMITS.files = 160): a background, `default` with 4 poses and 31 sets of 5, each picture `size`
 * bytes; `byInstance` maps the fleet's people (and some who are not in it) to the sets.
 */
function fullPack(id: string, wearers: string[], size: number) {
  const characters: Record<string, Record<string, unknown>> = { default: Object.fromEntries(POSES.slice(0, 4).map(p => [p, strip(`default_${p}.png`)])) };
  for (let s = 0; s < 31; s++) characters[`set${s}`] = Object.fromEntries(POSES.map(p => [p, strip(`set${s}/${p}.png`)]));
  const byInstance: Record<string, string> = {};
  wearers.forEach((n, i) => { byInstance[n] = `set${i % 31}`; });
  const manifest = { ...BASE_MANIFEST, id, background: `${id}_bg.png`, characters, byInstance };
  const srcs = [manifest.background, ...Object.values(characters).flatMap(set => Object.values(set).map(st => (st as { src: string }).src))];
  const tag = id.charCodeAt(id.length - 1).toString(16).padStart(2, "0");
  const files = Object.fromEntries(srcs.map((src, i) => [src, `${tag}${i.toString(16).padStart(30, "0")}`]));
  return { id, name: id, sha: `${tag}${"5".repeat(30)}`, manifest, files, bytes: srcs.length * size, size };
}

function rig(packs: ReturnType<typeof fullPack>[], people: string[], over: { pictureLimiter?: OfficeShareLimiter; limiter?: OfficeShareLimiter } = {}) {
  const offices: Office[] = packs.map((p, i) => ({ id: `o${i}`, name: `Office ${i}`, skin: p.id, members: people }));
  const picture = Buffer.alloc(Math.max(...packs.map(p => p.size)), 7);
  const source: OfficeShareSource = {
    status: () => ({ instances: people.map(name => ({ name, status: "running" })) }),
    org: () => ({ general: people, teams: [] }),
    offices: () => ({ rev: 1, offices }),
    acts: () => [], traffic: () => ({ now: "t", items: [] }), needs: () => [], hidden: () => false,
    skins: {
      list: () => ({ packs: packs.map(p => ({ id: p.id, name: p.name, sha: p.sha, bytes: p.bytes, files: Object.keys(p.files).length })) }),
      get: id => { const p = packs.find(x => x.id === id); return p ? { id: p.id, name: p.name, sha: p.sha, manifest: JSON.parse(JSON.stringify(p.manifest)), files: { ...p.files } } : null; },
      picture: (id, sha) => { const p = packs.find(x => x.id === id); return p && Object.values(p.files).includes(sha) ? picture.subarray(0, p.size) : null; },
    },
  };
  let t = 1_000;
  const clock = { now: () => t, wall: () => 1_700_000_000_000 + t, tick: (ms: number) => { t += ms; } };
  const shares = new OfficeShares({ ...clock, setTimer: () => null, clearTimer: () => {} });
  const gw = createOfficeShareGateway({ shares, source, limiter: over.limiter ?? new OfficeShareLimiter(clock.now),
    pictureLimiter: over.pictureLimiter ?? new OfficeShareLimiter(clock.now), marker: "agend-office-share-2662" });
  return { gw, shares, clock, source };
}

/** fetch over the gateway's loopback port with the tunnel's Host (what cloudflared does), recording every answer. */
function shareFetch(base: URL, seen: Array<{ path: string; status: number }>) {
  return (path: string) => new Promise<{ ok: boolean; status: number; headers: { get(k: string): string | null }; json(): Promise<unknown>; blob(): Promise<Blob> }>((resolve, reject) => {
    const req = request(new URL(path, base), { method: "GET", headers: { host: HOST } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => {
        const body = Buffer.concat(chunks), status = res.statusCode ?? 0;
        seen.push({ path, status });
        resolve({ ok: status >= 200 && status < 300, status, headers: { get: k => { const v = res.headers[k.toLowerCase()]; return typeof v === "string" ? v : null; } },
          json: async () => JSON.parse(body.toString()), blob: async () => new Blob([body]) });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

let p: AppPage, SK: any, PK: any, S: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/" });
  SK = await import("/ui/js/fleet-office-skin.js");
  PK = await import("/ui/js/fleet-office-pack.js");
  S = await import("/ui/js/office-share-page.js");
});
afterAll(() => p.restore());
let gw: OfficeShareGateway | null = null;
afterEach(() => { gw?.close(); gw = null; });

/** The share page's Office loading every tile's pack: loadPackSkin, at the share's addresses, with the share's picture reader. */
async function loadAll(base: URL, token: string, packs: Array<{ id: string; sha: string }>, timers: { setTimeout(fn: () => void, ms: number): unknown }) {
  const seen: Array<{ path: string; status: number }> = [], decoded: string[] = [];
  const at = `/o/${token}`, get = shareFetch(base, seen);
  const url = (path: string) => S.shareUrl(at, path) ?? path;
  const image = (u: string) => S.shareImage(u, { fetch: get, timers, decode: async (b: Blob) => { decoded.push(u); return { size: b.size }; } });
  const skins = await Promise.all(packs.map(({ id, sha }) => SK.loadPackSkin(id, sha, { fetch: (path: string) => get(url(path)), url, image })));
  return { skins, seen, decoded };
}

describe("an All-offices share of fleet-sized packs (#2662)", () => {
  it("6 full packs (160 pictures, 15 MiB each), everyone wearing a set: every picture loads, no 429", async () => {
    const people = Array.from({ length: 31 }, (_, i) => `agent-${i}`);
    const packs = Array.from({ length: 6 }, (_, i) => fullPack(`pk2662a${i}`, people, 96 * KiB));
    const r = rig(packs, people);
    gw = r.gw;
    const base = await gw.listen();
    gw.setHost(HOST);
    const made = r.shares.create({ office: ALL_OFFICES, owner: "o", exists: () => true });
    if (!made.ok) throw new Error(made.error);
    const pictures = 6 * 160;
    // What the old limits could never carry: 960 pictures and 90 MiB in a minute, against 120 requests and 16 MiB.
    expect(pictures).toBeGreaterThan(OFFICE_SHARE_LIMITS.requestsPerMinute);
    expect(packs.reduce((n, pk) => n + pk.bytes, 0)).toBeGreaterThan(5 * OFFICE_SHARE_LIMITS.bytesPerMinute);
    const timers = { setTimeout: () => { throw new Error("no picture should wait"); } };
    const { skins, seen, decoded } = await loadAll(base, made.token, packs, timers);
    expect(seen.filter(s => s.status !== 200)).toEqual([]);
    expect(skins.every(Boolean)).toBe(true);
    expect(decoded).toHaveLength(pictures);
    for (const pk of packs) expect(decoded, pk.id).toContain(`/o/${made.token}/office-skins/${pk.id}/img/${pk.files[pk.manifest.background]}.png`);
    for (const sk of skins) expect(sk.backdrop).toBeTruthy();                      // every room's background is in
    // A second viewer in the same minute too (the share's minute is pictureLoads × what it shows).
    const second = shareFetch(base, []);
    for (const pk of packs) for (const fid of Object.values(pk.files)) expect((await second(`/o/${made.token}/office-skins/${pk.id}/img/${fid}.png`)).status).toBe(200);
    // …and the page's own reads keep their 120: pictures took none of it.
    const reads = seen.filter(s => !s.path.includes("/img/")).length;
    for (let i = reads; i < OFFICE_SHARE_LIMITS.requestsPerMinute; i++) expect((await second(`/o/${made.token}/offices`)).status).toBe(200);
    expect((await second(`/o/${made.token}/offices`)).status).toBe(429);
  });

  it("a share shows only the sets its people wear: the rest of a pack is never fetched", async () => {
    const people = ["atlas", "quill", "sage"];
    const pack = fullPack("pk2662b", [...people, "ghost-1", "ghost-2"], 1 * KiB);   // two wearers not in the fleet
    const r = rig([pack], people);
    gw = r.gw;
    const base = await gw.listen();
    gw.setHost(HOST);
    const made = r.shares.create({ office: ALL_OFFICES, owner: "o", exists: () => true });
    if (!made.ok) throw new Error(made.error);
    const { skins, decoded, seen } = await loadAll(base, made.token, [pack], { setTimeout: () => { throw new Error("no wait"); } });
    expect(skins[0]).toBeTruthy();
    expect(seen.filter(s => s.status !== 200)).toEqual([]);
    // background + default's 4 + the 3 sets worn × 5
    expect(decoded).toHaveLength(1 + 4 + 3 * 5);
    const answer = JSON.parse(JSON.stringify(new OfficeShareView({ office: ALL_OFFICES, text: false }, r.source).pack(r.source.skins!.get(pack.id))));
    expect(Object.keys(answer.manifest.characters).sort()).toEqual(["default", "set0", "set1", "set2"]);
    expect(answer.manifest.byInstance).toEqual({ atlas: "set0", quill: "set1", sage: "set2" });
    expect(Object.keys(answer.files)).toHaveLength(1 + 4 + 3 * 5);
    expect(Object.keys(answer.files).some((src: string) => src.startsWith("set3/"))).toBe(false);
    expect(PK.checkSkinPack(answer.manifest, { kept: true }).ok).toBe(true);     // still a pack the page takes
  });

  it("a picture refused for the share's minute fills in after its Retry-After", async () => {
    const people = ["atlas"];
    const pack = fullPack("pk2662c", people, 1 * KiB);
    let t = 1_000;
    const now = () => t;
    const pictureLimiter = new OfficeShareLimiter(now);
    const r = rig([pack], people, { pictureLimiter, limiter: new OfficeShareLimiter(now) });
    gw = r.gw;
    const base = await gw.listen();
    gw.setHost(HOST);
    const made = r.shares.create({ office: ALL_OFFICES, owner: "o", exists: () => true });
    if (!made.ok) throw new Error(made.error);
    // Someone else used the share's minute of pictures 45 s ago (another viewer, say).
    const rate = sharePictureRate(made.share, r.source.offices().offices, r.source.skins!.list().packs);
    t -= 45_000;
    for (let i = 0; i < rate.requests; i++) expect(pictureLimiter.admit(made.share.id, rate)).toBe(true);
    t += 45_000;
    // The clock moves once every picture has been refused and is waiting (all ten are asked for at once).
    const waits: number[] = [], waiting: Array<() => void> = [];
    const timers = { setTimeout: (fn: () => void, ms: number) => {
      waits.push(ms); waiting.push(fn);
      if (waiting.length === 1 + 4 + 5) { t += ms; for (const go of waiting.splice(0)) go(); }
      return 0;
    } };
    const { skins, seen, decoded } = await loadAll(base, made.token, [pack], timers);
    expect(skins[0]?.backdrop).toBeTruthy();
    expect(decoded).toHaveLength(1 + 4 + 5);                                          // every picture, after the wait
    const refused = seen.filter(s => s.status === 429);
    expect(refused.length).toBe(1 + 4 + 5);                                          // each was refused once…
    expect(new Set(waits)).toEqual(new Set([15_000]));                                // …told the 15 s left of that minute
  });
});

describe("the share page's picture reader (#2662)", () => {
  const reply = (status: number, retry?: string) => ({ ok: status === 200, status, headers: { get: (k: string) => (k === "Retry-After" ? retry ?? null : null) }, blob: async () => new Blob(["png"]) });
  it("waits out a 429's Retry-After (1–60 s) and asks again, at most IMAGE_ATTEMPTS times in all", async () => {
    const waits: number[] = [];
    const timers = { setTimeout: (fn: () => void, ms: number) => { waits.push(ms); fn(); } };
    const decode = async () => "img";
    let n = 0;
    expect(await S.shareImage("/x.png", { fetch: async () => (++n < 3 ? reply(429, n === 1 ? "7" : "999") : reply(200)), timers, decode })).toBe("img");
    expect(waits).toEqual([7_000, 60_000]);
    waits.length = 0; n = 0;
    expect(await S.shareImage("/x.png", { fetch: async () => { n++; return reply(429); }, timers, decode })).toBeNull();
    expect(n).toBe(S.IMAGE_ATTEMPTS);
    expect(waits).toEqual(Array(S.IMAGE_ATTEMPTS - 1).fill(60_000));            // no Retry-After: a minute
    n = 0;
    expect(await S.shareImage("/x.png", { fetch: async () => { n++; return reply(404); }, timers, decode })).toBeNull();
    expect(n).toBe(1);                                                              // only a 429 is asked again
    expect(await S.shareImage("/x.png", { fetch: async () => { throw new Error("offline"); }, timers, decode })).toBeNull();
  });

  it("reads IMAGE_PARALLEL at a time (the gateway keeps 32 connections for everyone watching)", async () => {
    let now = 0, most = 0;
    const held: Array<() => void> = [];
    const fetch = () => { now++; most = Math.max(most, now); return new Promise(go => held.push(() => { now--; go(reply(200)); })); };
    const all = Promise.all(Array.from({ length: 40 }, (_, i) => S.shareImage(`/p${i}.png`, { fetch, timers: globalThis, decode: async () => i })));
    let done = false;
    void all.then(() => { done = true; });
    while (!done) { await new Promise(r => setImmediate(r)); held.splice(0).forEach(go => go()); }
    expect((await all).length).toBe(40);
    expect(most).toBe(S.IMAGE_PARALLEL);
  });

  it("the share page's Office reads a pack's pictures with it, at the share's address", async () => {
    const BASE = `/o/${"B".repeat(43)}`, asked: string[] = [];
    const pack = fullPack("pk2662d", ["dev-a"], 16);
    const reply = (status: number, body: unknown) => ({ ok: status === 200, status, headers: { get: () => null }, json: async () => body, blob: async () => new Blob(["png"]) });
    const timers = { ...globalThis, fetch: async (u: string) => {
      asked.push(u);
      if (u === `${BASE}/state`) return reply(200, { instances: [{ name: "dev-a", status: "running" }], org: { general: ["dev-a"], teams: [], instances: {} }, needs: [], office: "hq" });
      if (u === `${BASE}/offices`) return reply(200, { rev: 1, offices: [{ id: "hq", name: "HQ", skin: pack.id, members: [] }], readable: true });
      if (u === `${BASE}/office-acts`) return reply(200, { acts: [], now: Date.now() });
      if (u === `${BASE}/office-skins`) return reply(200, { rev: "r", packs: [{ id: pack.id, name: pack.name, sha: pack.sha }] });
      if (u.startsWith(`${BASE}/office-skins/${pack.id}?`)) return reply(200, { id: pack.id, sha: pack.sha, manifest: pack.manifest, files: pack.files });
      if (u.startsWith(`${BASE}/office-skins/${pack.id}/img/`)) return reply(200, {});
      return reply(404, {});
    } };
    await p.mount(h(S.SharePage, { base: BASE, timers, pollMs: 60_000 }));
    for (let i = 0; i < 20 && !asked.some(u => u.includes("/img/")); i++) { await settle(); await new Promise(r => setTimeout(r, 10)); }
    expect(asked).toContain(`${BASE}/office-skins/${pack.id}/img/${pack.files[pack.manifest.background]}.png`);
    await p.unmount();
  });
});

describe("the limiter's minute and Retry-After (#2662)", () => {
  it("takes a key's own limits, and says when enough of the minute has gone — by requests or by bytes", () => {
    let t = 0;
    const lim = new OfficeShareLimiter(() => t);
    const rate = { requests: 3, bytes: 10 * MiB };
    for (const at of [0, 10_000, 20_000]) { t = at; expect(lim.admit("a", rate)).toBe(true); }
    t = 30_000;
    expect(lim.admit("a", rate)).toBe(false);
    expect(lim.retryAfter("a", rate)).toBe(30);                                    // the first leaves at 60 s
    expect(lim.admit("a")).toBe(true);                                              // the default limits are another budget
    const bytes = new OfficeShareLimiter(() => t);
    t = 0; bytes.admit("b", rate); bytes.sent("b", 6 * MiB);
    t = 5_000; bytes.admit("b", rate); bytes.sent("b", 6 * MiB);
    t = 6_000;
    expect(bytes.admit("b", rate)).toBe(false);
    expect(bytes.retryAfter("b", rate)).toBe(54);                                   // 12 MiB ≥ 10: the first must leave
    t = 59_999.5;
    expect(bytes.retryAfter("b", rate)).toBe(1);                                    // never 0
  });

  it("a share's minute of pictures: pictureLoads × the files and bytes of the packs it shows, at least the floors", () => {
    const offices: Office[] = [{ id: "a", name: "A", skin: "p1", members: [] }, { id: "b", name: "B", skin: "p2", members: [] }];
    const packs = [{ id: "p1", files: 160, bytes: 20 * MiB }, { id: "p2", files: 100, bytes: 10 * MiB }, { id: "p3", files: 160, bytes: 20 * MiB }];
    const L = OFFICE_SHARE_LIMITS;
    expect(sharePictureRate({ office: ALL_OFFICES }, offices, packs)).toEqual({ requests: L.pictureLoads * 260, bytes: L.pictureLoads * 30 * MiB });
    expect(sharePictureRate({ office: "b" }, offices, packs)).toEqual({ requests: Math.max(L.pictureRequestsFloor, L.pictureLoads * 100), bytes: L.pictureLoads * 10 * MiB });
    expect(sharePictureRate({ office: "a" }, offices, [{ id: "p1", files: Number.NaN, bytes: -1 } as never])).toEqual({ requests: L.pictureRequestsFloor, bytes: L.pictureBytesFloor });
    expect(sharePictureRate({ office: "gone" }, offices, packs)).toEqual({ requests: L.pictureRequestsFloor, bytes: L.pictureBytesFloor });
  });
});
