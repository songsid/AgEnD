/**
 * #2636: Office share links — the store (tokens kept hashed, lifetime, limits, revoke), what a share shows (only its
 * office's people, only the fields the picture needs, hidden instances never, an agent's line only when shared), and
 * the share gateway (its own Host, GET only, an ended link says so, 429 over the limit, no cookie).
 */
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ALL_OFFICES, ENDED_PAGE, NOBODY, OFFICE_SHARE_LIMITS, OfficeShareLimiter, OfficeShareView, OfficeShares, createOfficeShareGateway, hashShareToken, shareMaxMinutes,
  type OfficeShareGateway, type OfficeShareSource } from "../src/office-share.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { validateFleetConfig } from "../src/config-validator.js";
import type { Office } from "../src/web-office-store.js";

const MIN = 60_000;
function clock() {
  let t = 1_000;
  return { now: () => t, wall: () => 1_700_000_000_000 + t, tick: (ms: number) => { t += ms; } };
}
const noTimer = { setTimer: () => null, clearTimer: () => {} };

describe("OfficeShares (#2636)", () => {
  it("makes a share of 1 h by default, keeps only the token's hash, and finds it by the token", () => {
    const c = clock(), seen: number[] = [];
    const shares = new OfficeShares({ ...c, ...noTimer, changed: l => seen.push(l.length) });
    const r = shares.create({ office: ALL_OFFICES, owner: "discord:1" });
    if (!r.ok) throw new Error(r.error);
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.share).toMatchObject({ office: "all", text: false, owner: "discord:1", expiresAt: r.share.createdAt + 60 * MIN });
    expect(shares.find(r.token)?.id).toBe(r.share.id);
    expect(JSON.stringify([...(shares as unknown as { byHash: Map<string, unknown> }).byHash])).not.toContain(r.token);
    expect([...(shares as unknown as { byHash: Map<string, unknown> }).byHash.keys()]).toEqual([hashShareToken(r.token)]);
    expect(shares.find(r.token.slice(0, -1) + (r.token.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(shares.find("short")).toBeNull();
    expect(seen).toEqual([1]);
  });

  it("refuses a lifetime under 15 min or over the cap, an office it does not know, and an 11th link", () => {
    const shares = new OfficeShares({ ...clock(), ...noTimer });
    expect(shares.create({ office: "all", owner: "o", minutes: 14 })).toEqual({ ok: false, error: "duration" });
    expect(shares.create({ office: "all", owner: "o", minutes: 24 * 60 + 1 })).toEqual({ ok: false, error: "duration" });
    expect(shares.create({ office: "all", owner: "o", minutes: 3 * 60, maxMinutes: 2 * 60 })).toEqual({ ok: false, error: "duration" });
    expect(shares.create({ office: "all", owner: "o", minutes: 24 * 60 }).ok).toBe(true);
    expect(shares.create({ office: "a1", owner: "o", exists: id => id === "a2" })).toEqual({ ok: false, error: "office" });
    expect(shares.create({ office: "a2", owner: "o", exists: id => id === "a2" }).ok).toBe(true);
    for (let i = 2; i < OFFICE_SHARE_LIMITS.links; i++) expect(shares.create({ office: "all", owner: "o" }).ok).toBe(true);
    expect(shares.create({ office: "all", owner: "o" })).toEqual({ ok: false, error: "too_many" });
  });

  it("caps the default to a lower max_hours, and reads max_hours", () => {
    expect(shareMaxMinutes(undefined)).toBe(24 * 60);
    expect(shareMaxMinutes(2)).toBe(120);
    expect(shareMaxMinutes(25)).toBe(24 * 60);
    expect(shareMaxMinutes(1.5)).toBe(24 * 60);
  });

  it("ends a share at its deadline (monotonic), whatever its timer did, and tells the listener", () => {
    const c = clock(), seen: number[] = [];
    const shares = new OfficeShares({ ...c, ...noTimer, changed: l => seen.push(l.length) });
    const r = shares.create({ office: "all", owner: "o", minutes: 15 });
    if (!r.ok) throw new Error(r.error);
    c.tick(15 * MIN - 1);
    expect(shares.find(r.token)).not.toBeNull();
    c.tick(1);
    expect(shares.find(r.token)).toBeNull();
    expect(shares.list()).toEqual([]);
    expect(seen).toEqual([1, 0]);
  });

  it("its timer ends it too, so the tunnel can stop with nobody asking", () => {
    const c = clock(), seen: number[] = [];
    let fire: (() => void) | null = null, after = 0;
    const shares = new OfficeShares({ ...c, changed: l => seen.push(l.length), setTimer: (fn, ms) => { fire = fn; after = ms; return null; }, clearTimer: () => {} });
    expect(shares.create({ office: "all", owner: "o", minutes: 30 }).ok).toBe(true);
    expect(after).toBeGreaterThanOrEqual(30 * MIN);
    c.tick(30 * MIN);
    fire!();
    expect(seen).toEqual([1, 0]);
  });

  it("revokes one, then all, and ends the shares a test picks", () => {
    const shares = new OfficeShares({ ...clock(), ...noTimer });
    const a = shares.create({ office: "all", owner: "x" }), b = shares.create({ office: "all", owner: "y" }), c = shares.create({ office: "all", owner: "y" });
    if (!a.ok || !b.ok || !c.ok) throw new Error("create");
    expect(shares.revoke(a.share.id)).toBe(1);
    expect(shares.find(a.token)).toBeNull();
    expect(shares.revoke("nope")).toBe(0);
    expect(shares.endWhere(s => s.owner === "y" && s.id === b.share.id)).toBe(1);
    expect(shares.list().map(s => s.id)).toEqual([c.share.id]);
    expect(shares.revoke("all")).toBe(1);
    expect(shares.list()).toEqual([]);
  });
});

describe("OfficeShareLimiter (#2636)", () => {
  it("lets 120 requests a minute through per share, and counts the bytes answered", () => {
    const c = clock(), lim = new OfficeShareLimiter(c.now);
    for (let i = 0; i < OFFICE_SHARE_LIMITS.requestsPerMinute; i++) expect(lim.admit("a")).toBe(true);
    expect(lim.admit("a")).toBe(false);
    expect(lim.admit("b")).toBe(true);   // another share is its own
    c.tick(MIN);
    expect(lim.admit("a")).toBe(true);
    lim.sent("a", OFFICE_SHARE_LIMITS.bytesPerMinute);
    expect(lim.admit("a")).toBe(false);
    c.tick(MIN);
    expect(lim.admit("a")).toBe(true);
  });
});

const OFFICES: Office[] = [
  { id: "eng", name: "Engineering", skin: "studio", members: ["team:dev"] },
  { id: "ops", name: "Ops", skin: "pack1", members: ["ops-bot"] },
];
function source(over: Partial<OfficeShareSource> = {}): OfficeShareSource {
  const person = (name: string, extra: Record<string, unknown> = {}) => ({
    name, display_name: name.toUpperCase(), color: "teal", color_show: ["name"], backend: "claude-code", status: "running", execution_state: "working", state: "working",
    model: "opus", cost: 3.2, context_pct: 40, last_reply: "the secret plan", interaction_summary: "Allow rm -rf?", description: "x", ...extra,
  });
  return {
    status: () => ({ instances: [person("dev-a", { state: "awaiting_input" }), person("dev-b"), person("ops-bot"), person("ghost")], uptime: 9, publicLink: { url: "https://x" } }),
    org: () => ({ general: ["ops-bot", "ghost"], teams: [{ name: "dev", description: "secret team", members: ["dev-a", "dev-b", "ghost"] }, { name: "ops", members: ["ops-bot"] }], instances: { "dev-a": { description: "d", thread: { url: "https://discord.com/x" } } } }),
    offices: () => ({ rev: 7, offices: OFFICES }),
    acts: () => [
      { instance: "dev-a", office: "eng", say: "shipping it", pose: "working", since: 1, until: 2, state: "idle" },
      { instance: "dev-b", office: "ops", say: "elsewhere", since: 1, until: 2, state: "idle" },
      { instance: "ops-bot", office: "ops", say: "hi", since: 1, until: 2, state: "idle" },
    ],
    traffic: () => ({ now: "t", items: [{ id: "1", from: "dev-a", to: "dev-b", kind: "task" }, { id: "2", from: "dev-a", to: "ops-bot", kind: "send" }, { id: "3", from: "dev-b", to: "ghost", kind: "send" }],
      delegations: [{ id: "d1", from: "dev-b", to: "dev-a" }, { id: "d2", from: "ops-bot", to: "dev-a" }] }),
    needs: () => ["dev-a", "ops-bot", "dev-a"],
    hidden: name => name === "ghost",
    skins: {
      list: () => ({ max: 16, packs: [{ id: "pack1", name: "P1" }, { id: "pack2", name: "P2" }] }),
      get: id => (id === "pack1" || id === "pack2" ? { id, sha: `sha-${id}` } : null),
      picture: (id, sha) => (sha === "0".repeat(32) ? Buffer.from(`png-${id}`) : null),
    },
    ...over,
  };
}

describe("OfficeShareView (#2636)", () => {
  it("one office: only its people (a team resolved, a hidden one left out), only the picture's fields", () => {
    const v = new OfficeShareView({ office: "eng", text: false }, source());
    expect([...v.scope]).toEqual(["dev-a", "dev-b"]);
    const s = v.state() as { instances: Array<Record<string, unknown>>; org: Record<string, unknown>; needs: unknown[]; traffic: { items: unknown[]; delegations: unknown[] }; text: boolean };
    expect(s.instances).toEqual([
      { name: "dev-a", display_name: "DEV-A", color: "teal", color_show: ["name"], backend: "claude-code", status: "running", execution_state: "working", state: "awaiting_input" },
      { name: "dev-b", display_name: "DEV-B", color: "teal", color_show: ["name"], backend: "claude-code", status: "running", execution_state: "working" },
    ]);
    const text = JSON.stringify(s);
    for (const leak of ["secret", "Allow rm", "opus", "discord.com", "ghost", "ops-bot", "publicLink", "description"]) expect(text).not.toContain(leak);
    expect(s.org).toEqual({ general: [], teams: [{ name: "dev", members: ["dev-a", "dev-b"] }], instances: {} });
    expect(s.needs).toEqual([{ instance: "dev-a" }, { instance: "dev-a" }]);
    expect(s.traffic.items).toEqual([{ id: "1", from: "dev-a", to: "dev-b", kind: "task" }]);
    expect(s.traffic.delegations).toEqual([{ id: "d1", from: "dev-b", to: "dev-a" }]);
    expect(s.text).toBe(false);
    expect(v.officeList()).toEqual({ rev: 7, offices: [OFFICES[0]], readable: true });
  });

  it("an agent's own line only when the share includes it, and only acts in a shown office by its people", () => {
    expect(new OfficeShareView({ office: "eng", text: false }, source()).acts().acts).toEqual([{ instance: "dev-a", office: "eng", pose: "working", since: 1, until: 2, state: "idle" }]);
    expect(new OfficeShareView({ office: "eng", text: true }, source()).acts().acts).toEqual([{ instance: "dev-a", office: "eng", say: "shipping it", pose: "working", since: 1, until: 2, state: "idle" }]);
  });

  it("All offices: every stored office and everyone but the hidden; a deleted office shows nothing", () => {
    const all = new OfficeShareView({ office: ALL_OFFICES, text: false }, source());
    expect([...all.scope]).toEqual(["dev-a", "dev-b", "ops-bot"]);
    expect(all.officeList().offices).toEqual(OFFICES);
    expect([...all.skinIds()]).toEqual(["studio", "pack1"]);
    expect(all.acts().acts.map(a => a.instance)).toEqual(["dev-a", "dev-b", "ops-bot"]);
    const gone = new OfficeShareView({ office: "deleted", text: false }, source());
    expect(gone.offices).toBeNull();
    expect(gone.scope.size).toBe(0);
  });
});

describe("instance names outside the share stay out (#2637 review)", () => {
  const office: Office = { id: "mix", name: "Mix", skin: "pack1", members: ["dev-a", "ghost", "ops-bot", "team:dev", "team:ops"],
    layout: { seats: [{ id: "s1", x: 1, y: 2, instance: "ghost" }, { id: "s2", x: 3, y: 4, instance: "dev-a" }, { id: "s3", x: 5, y: 6 }], waypoints: [], edges: [] } };
  const mixed = (over: Partial<OfficeShareSource> = {}) => source({ offices: () => ({ rev: 1, offices: [office, { id: "solo", name: "Solo", skin: "pixel", members: ["ghost"] }] }), ...over });

  it("an office's members and seats name only who is shown; the stored office is unchanged", () => {
    const before = JSON.stringify(office);
    const v = new OfficeShareView({ office: "mix", text: false }, mixed());
    const [o] = v.officeList().offices;
    expect(o!.members).toEqual(["dev-a", "ops-bot", "team:dev", "team:ops"]);
    expect(o!.layout!.seats).toEqual([{ id: "s1", x: 1, y: 2 }, { id: "s2", x: 3, y: 4, instance: "dev-a" }, { id: "s3", x: 5, y: 6 }]);
    expect(JSON.stringify(v.officeList())).not.toContain("ghost");
    expect(JSON.stringify(office)).toBe(before);
  });

  it("a team with nobody shown is not named, and an office left with nobody finds nobody (never everyone)", () => {
    const v = new OfficeShareView({ office: ALL_OFFICES, text: false }, mixed({ hidden: n => n === "ghost" || n === "ops-bot" }));
    const [mix, solo] = v.officeList().offices;
    expect(mix!.members).toEqual(["dev-a", "team:dev"]);
    expect(solo!.members).toEqual([NOBODY]);
  });

  it("an act walking to someone not shown keeps going, without the name", () => {
    const acts = () => [{ instance: "dev-a", office: "mix", person: "ghost", pose: "working" as const, since: 1, until: 2, state: "idle" },
      { instance: "dev-b", office: "mix", person: "dev-a", since: 1, until: 2, state: "idle" }];
    const v = new OfficeShareView({ office: "mix", text: true }, mixed({ acts }));
    expect(v.acts().acts).toEqual([{ instance: "dev-a", office: "mix", pose: "working", since: 1, until: 2, state: "idle" },
      { instance: "dev-b", office: "mix", person: "dev-a", since: 1, until: 2, state: "idle" }]);
  });

  it("a pack's byInstance and activeFor name only who is shown (none left: [], which watches nobody); the kept pack is unchanged", () => {
    const kept = { id: "pack1", sha: "s", manifest: { id: "pack1", byInstance: { "dev-a": "fox", ghost: "cat", "ops-bot": "owl" },
      furniture: [{ id: "f1", activeFor: "ghost" }, { id: "f2", activeFor: ["dev-a", "ghost"] }, { id: "f3" }] }, files: {} };
    const before = JSON.stringify(kept);
    const v = new OfficeShareView({ office: "eng", text: false }, source());
    const out = v.pack(kept) as { manifest: Record<string, unknown> };
    expect(out.manifest.byInstance).toEqual({ "dev-a": "fox" });
    expect(out.manifest.furniture).toEqual([{ id: "f1", activeFor: [] }, { id: "f2", activeFor: ["dev-a"] }, { id: "f3" }]);
    expect(JSON.stringify(kept)).toBe(before);
  });

  it("through the gateway too: /offices, /office-acts and a pack carry no outside name", async () => {
    const shares = new OfficeShares({ ...clock(), ...noTimer });
    const skins = { list: () => ({ packs: [{ id: "pack1" }] }), picture: () => null,
      get: () => ({ id: "pack1", sha: "s", manifest: { id: "pack1", byInstance: { "dev-a": "fox", ghost: "cat", "ops-bot": "owl" } }, files: {} }) };
    const acts = () => [{ instance: "dev-a", office: "mix", person: "ghost", since: 1, until: 2, state: "idle" }];
    const gw = createOfficeShareGateway({ shares, source: mixed({ skins, acts, offices: () => ({ rev: 1, offices: [{ ...office, members: ["team:dev"] }] }) }) });
    try {
      const base = await gw.listen();
      gw.setHost("abc.trycloudflare.com");
      const r = shares.create({ office: "mix", owner: "o", exists: () => true });
      if (!r.ok) throw new Error(r.error);
      for (const path of ["offices", "office-acts", "office-skins/pack1"]) {
        const body = await new Promise<string>((resolve, reject) => {
          const req = request(new URL(`/o/${r.token}/${path}`, base), { headers: { host: "abc.trycloudflare.com" } }, res => {
            const c: Buffer[] = []; res.on("data", d => c.push(d)); res.on("end", () => resolve(Buffer.concat(c).toString()));
          });
          req.on("error", reject); req.end();
        });
        expect(body, path).toContain("dev-a");
        expect(body, path).not.toContain("ghost");
        expect(body, path).not.toContain("ops-bot");
      }
    } finally { gw.close(); }
  });
});

describe("the share gateway (#2636)", () => {
  const HOST = "abc-def.trycloudflare.com";
  let gw: OfficeShareGateway | null = null;
  afterEach(() => { gw?.close(); gw = null; });
  async function rig(over: Partial<Parameters<typeof createOfficeShareGateway>[0]> = {}) {
    const c = clock();
    const shares = new OfficeShares({ ...c, ...noTimer });
    const limiter = new OfficeShareLimiter(c.now);
    gw = createOfficeShareGateway({ shares, source: source(), limiter, marker: "agend-office-share-test", ...over });
    const base = await gw.listen();
    gw.setHost(HOST);
    const get = (path: string, o: { method?: string; host?: string } = {}) => new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request(new URL(path, base), { method: o.method ?? "GET", headers: { host: o.host ?? HOST } }, res => {
        const chunks: Buffer[] = [];
        res.on("data", d => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on("error", reject);
      req.end();
    });
    return { shares, limiter, get, c };
  }
  const open = (shares: OfficeShares, office = "eng", text = false) => {
    const r = shares.create({ office, owner: "o", text, exists: () => true });
    if (!r.ok) throw new Error(r.error);
    return r;
  };

  it("answers only its own Host, only GET and HEAD, and the readiness probe", async () => {
    const { get } = await rig();
    expect((await get("/ready", { host: "other.trycloudflare.com" })).status).toBe(403);
    expect((await get("/ready", { method: "POST" })).status).toBe(405);
    const ready = await get("/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toContain("agend-office-share-test");
    expect(() => gw!.setHost("evil.example.com")).toThrow();
  });

  it("serves a share's reads with no cookie and no-store, cut to its office", async () => {
    const { shares, get } = await rig();
    const r = open(shares);
    const state = await get(`/o/${r.token}/state`);
    expect(state.status).toBe(200);
    expect(state.headers["set-cookie"]).toBeUndefined();
    expect(state.headers["cache-control"]).toBe("no-store");
    expect(state.headers["referrer-policy"]).toBe("no-referrer");
    expect(state.headers["x-robots-tag"]).toContain("noindex");
    expect(JSON.parse(state.body).instances.map((i: { name: string }) => i.name)).toEqual(["dev-a", "dev-b"]);
    expect(JSON.parse((await get(`/o/${r.token}/offices`)).body).offices.map((o: Office) => o.id)).toEqual(["eng"]);
    expect(JSON.parse((await get(`/o/${r.token}/office-acts`)).body).acts[0].say).toBeUndefined();
    // Its office's style only: "studio" is built in, so no pack is offered, and pack1's picture is not served.
    expect(JSON.parse((await get(`/o/${r.token}/office-skins`)).body).packs).toEqual([]);
    expect((await get(`/o/${r.token}/office-skins/pack1/img/${"0".repeat(32)}.png`)).status).toBe(404);
    expect((await get(`/o/${r.token}/nope`)).status).toBe(404);
  });

  it("serves the pictures of the packs its offices use, immutable", async () => {
    const { shares, get } = await rig();
    const r = open(shares, ALL_OFFICES);
    expect(JSON.parse((await get(`/o/${r.token}/office-skins`)).body).packs).toEqual([{ id: "pack1", name: "P1" }]);
    const pic = await get(`/o/${r.token}/office-skins/pack1/img/${"0".repeat(32)}.png`);
    expect(pic.status).toBe(200);
    expect(pic.headers["content-type"]).toBe("image/png");
    expect(pic.headers["cache-control"]).toContain("immutable");
    expect(pic.body).toBe("png-pack1");
    expect((await get(`/o/${r.token}/office-skins/pack2`)).status).toBe(404);
    expect((await get(`/o/${r.token}/office-skins/pack1?v=sha-pack1`)).headers["cache-control"]).toBe("no-store");
  });

  it("an unknown, revoked or expired link: its page says it ended, its reads are empty 404s", async () => {
    const { shares, get, c } = await rig();
    const r = open(shares);
    expect((await get(`/o/${r.token}/state`)).status).toBe(200);
    shares.revoke(r.share.id);
    const page = await get(`/o/${r.token}`);
    expect(page.status).toBe(404);
    expect(page.body).toBe(ENDED_PAGE);
    const read = await get(`/o/${r.token}/state`);
    expect(read.status).toBe(404);
    expect(read.body).toBe("");
    const later = open(shares);
    c.tick(60 * MIN);
    expect((await get(`/o/${later.token}/state`)).status).toBe(404);
  });

  it("a share whose office was deleted shows nothing", async () => {
    const { shares, get } = await rig({ source: source({ offices: () => ({ rev: 8, offices: [] }) }) });
    const r = open(shares);
    expect((await get(`/o/${r.token}/state`)).status).toBe(404);
  });

  it("answers 429 over the share's minute of requests", async () => {
    const { shares, get } = await rig();
    const r = open(shares);
    for (let i = 0; i < OFFICE_SHARE_LIMITS.requestsPerMinute; i++) expect((await get(`/o/${r.token}/offices`)).status).toBe(200);
    const over = await get(`/o/${r.token}/offices`);
    expect(over.status).toBe(429);
    expect(over.headers["retry-after"]).toBe("60");
  });

  it("the page and its modules come from the caller (404 while there are none)", async () => {
    const { shares, get } = await rig({ page: (s, t) => ({ body: `<p>${s.office}:${t.length}</p>`, csp: "default-src 'self'" }), script: f => (f === "share.js" ? "export {}" : null) });
    const r = open(shares);
    const page = await get(`/o/${r.token}`);
    expect(page.status).toBe(200);
    expect(page.body).toBe("<p>eng:43</p>");
    expect(page.headers["content-security-policy"]).toBe("default-src 'self'");
    expect((await get(`/o/${r.token}/js/share.js`)).body).toBe("export {}");
    expect((await get(`/o/${r.token}/js/other.js`)).status).toBe(404);
  });

  it("the dashboard's public gateway never routes a share", () => {
    expect(isPublicWebRoute("GET", "/o/" + "a".repeat(43))).toBe(false);
    expect(isPublicWebRoute("GET", "/o/" + "a".repeat(43) + "/state")).toBe(false);
  });
});

describe("web.office_share config (#2636)", () => {
  const base = { instances: { a: { working_directory: "/tmp" } } };
  const issues = (office_share: unknown) => {
    const r = validateFleetConfig({ ...base, web: { office_share } } as never);
    return [...r.errors, ...r.warnings].filter(i => i.path.startsWith("web.office_share")).map(i => i.path);
  };
  it("takes enabled (boolean) and max_hours (1–24)", () => {
    expect(issues({ enabled: false, max_hours: 24 })).toEqual([]);
    expect(issues({ enabled: "no" })).toEqual(["web.office_share.enabled"]);
    expect(issues({ max_hours: 0 })).toEqual(["web.office_share.max_hours"]);
    expect(issues({ max_hours: 25 })).toEqual(["web.office_share.max_hours"]);
    expect(issues({ max_hours: 1.5 })).toEqual(["web.office_share.max_hours"]);
    expect(issues({ other: 1 })).toEqual(["web.office_share.other"]);
    expect(issues("yes")).toEqual(["web.office_share"]);
  });
});
