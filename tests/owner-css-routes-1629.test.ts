/**
 * #1629 r4 §3 / §7.4: owner CSS through a real listener (FleetManager's health server; nothing forks). A signed-in human
 * session only — never the CLI's header token, never a read-only session's write, never the public link (absent from
 * its manifest, and refused by the handler on its own); each person gets their own CSS only (another person's sha:
 * 404); the served text is the re-serialisation; the page names the version in force (data-owner-css) only where it
 * may be linked; keep-or-revert reverts on the host when nobody keeps it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => () => { throw new Error(`owner-css routes: no child process may start (${name})`); };
  return { ...real, spawn: refuse("spawn"), spawnSync: refuse("spawnSync"), exec: refuse("exec"), execSync: refuse("execSync"),
    execFile: refuse("execFile"), execFileSync: refuse("execFileSync"), fork: refuse("fork") };
});

const { FleetManager } = await import("../src/fleet-manager.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
const { isPublicWebRoute } = await import("../src/public-web-gateway.js");
const { handleWebRequest } = await import("../src/web-api.js");
const { bindGatewayRequest } = await import("../src/web-request-context.js");
const { OWNER_CSS_KEEP_MS } = await import("../src/web-owner-css-store.js");

const dirs: string[] = [];
beforeEach(() => { vi.stubGlobal("fetch", () => Promise.reject(new Error("no outbound fetch"))); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string | Buffer): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

async function fleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-owner-css-")); dirs.push(dir);
  const fm = new FleetManager(dir) as any;
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  fm.fleetConfig = { instances: { alpha: { working_directory: "/tmp" } }, defaults: {} };
  fm.initializeWebAuthTokens();
  fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const port = (fm.healthServer as Server).address() as { port: number };
  const origin = `http://127.0.0.1:${port.port}`;
  /** A browser session: a person (owner) or the operator (no owner), admin or read-only. */
  const session = (opts: { owner?: { adapterId: string; userId: string }; tier?: "admin" | "read" } = {}) => {
    const { sessionId } = fm.webSessions.create({ tier: opts.tier ?? "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(fm.webToken), ...(opts.owner ? { owner: opts.owner } : {}) });
    const cookie = `agend_session=${sessionId}`;
    const read = { cookie };
    const write = { cookie, origin, "x-agend-csrf": csrfTokenFor(sessionId) };
    return { read, write };
  };
  const stop = () => new Promise<void>(r => (fm.healthServer as Server).close(() => r()));
  return { fm, dir, port: port.port, origin, session, stop };
}
const JSON_H = { "content-type": "application/json" };
const A = { adapterId: "discord", userId: "111" }, B = { adapterId: "discord", userId: "222" };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 4, 0x74, 0x45, 0x58, 0x74, 0x47, 0x50, 0x53, 0x21, 0, 0, 0, 0,   // a tEXt chunk "GPS!"
  0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0]);

describe("who may use it", () => {
  it("anonymous: 401; the CLI's header token: 403 (no person — and the way an agent could reach it); a read-only session may read but not write", async () => {
    const f = await fleet();
    try {
      expect((await raw(f.port, "GET", "/ui/owner-css/state")).status).toBe(401);
      expect((await raw(f.port, "POST", "/ui/owner-css", { ...JSON_H, origin: f.origin }, JSON.stringify({ text: "a{}" }))).status).toBe(401);
      const token = { "x-agend-token": f.fm.getDashboardAccess().token };
      for (const [m, p] of [["GET", "/ui/owner-css/state"], ["GET", "/ui/owner-css.css"], ["POST", "/ui/owner-css"]] as const) {
        const r = await raw(f.port, m, p, { ...token, ...JSON_H }, m === "POST" ? JSON.stringify({ text: "a{}" }) : undefined);
        expect([r.status, JSON.parse(r.body).error], `${m} ${p}`).toEqual([403, "owner_css_needs_a_signed_in_person"]);
      }
      const ro = f.session({ tier: "read" });
      expect((await raw(f.port, "GET", "/ui/owner-css/state", ro.read)).status).toBe(200);
      const w = await raw(f.port, "POST", "/ui/owner-css", { ...ro.write, ...JSON_H }, JSON.stringify({ text: "a{}" }));
      expect([w.status, JSON.parse(w.body).error]).toEqual([403, "owner_css_read_only"]);
    } finally { await f.stop(); }
  }, 30_000);

  it("a session write needs Origin and the CSRF value, like every cookie write", async () => {
    const f = await fleet();
    try {
      const s = f.session({ owner: A });
      expect((await raw(f.port, "POST", "/ui/owner-css", { ...s.read, ...JSON_H }, JSON.stringify({ text: "a{}" }))).status).toBe(403);
      expect((await raw(f.port, "POST", "/ui/owner-css", { ...s.write, ...JSON_H }, JSON.stringify({ text: "a{}" }))).status).toBe(200);
    } finally { await f.stop(); }
  }, 30_000);

  it("the public link: absent from its manifest — every route, read or write — and refused by the handler on its own", async () => {
    for (const [m, p] of [["GET", "/ui/owner-css.css"], ["GET", "/ui/owner-css/state"], ["GET", `/ui/owner-css/asset/${"a".repeat(32)}`], ["POST", "/ui/owner-css"],
      ["POST", "/ui/owner-css/keep"], ["POST", "/ui/owner-css/revert"], ["POST", "/ui/owner-css/restore"], ["POST", "/ui/owner-css/asset"], ["DELETE", `/ui/owner-css/asset/${"a".repeat(32)}`]] as const) {
      expect(isPublicWebRoute(m, p), `${m} ${p}`).toBe(false);
    }
    const f = await fleet();
    try {
      const { sessionId } = f.fm.webSessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "t", tokenEpoch: tokenEpoch(f.fm.webToken) });
      const call = (method: string, path: string) => new Promise<number>(resolve => {
        let status = 0;
        const res: any = { headersSent: false, setHeader() {}, writeHead(c: number) { status = c; res.headersSent = true; return res; }, end() { resolve(status); } };
        const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "x.trycloudflare.com", cookie: `__Host-agend_session=${sessionId}`, origin: "https://x.trycloudflare.com", "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json" }, destroy() {}, resume() {} });
        bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://x.trycloudflare.com", isCurrent: () => true });
        expect(handleWebRequest(req as never, res, new URL(`https://x.trycloudflare.com${path}`), f.fm)).toBe(true);
      });
      expect([await call("GET", "/ui/owner-css.css"), await call("GET", "/ui/owner-css/state"), await call("POST", "/ui/owner-css"), await call("POST", "/ui/owner-css/restore")])
        .toEqual([404, 404, 403, 403]);
    } finally { await f.stop(); }
  }, 30_000);
});

describe("one person's CSS, served re-serialised", () => {
  it("save → served at ?v=<sha> (text/css, nosniff, immutable) as the re-serialisation; another person's sha is 404 for them", async () => {
    const f = await fleet();
    try {
      const a = f.session({ owner: A }), b = f.session({ owner: B });
      const saved = await raw(f.port, "POST", "/ui/owner-css", { ...a.write, ...JSON_H }, JSON.stringify({ text: "/* mine */ .x { color: red }" }));
      expect(saved.status).toBe(200);
      const { sha, previous } = JSON.parse(saved.body);
      expect([sha, previous]).toEqual([expect.stringMatching(/^[0-9a-f]{32}$/), null]);
      const css = await raw(f.port, "GET", `/ui/owner-css.css?v=${sha}`, a.read);
      expect([css.status, css.headers["content-type"], css.headers["x-content-type-options"], css.headers["cache-control"], css.body])
        .toEqual([200, "text/css; charset=utf-8", "nosniff", "private, max-age=31536000, immutable", " .x { color: red }"]);
      expect((await raw(f.port, "GET", `/ui/owner-css.css?v=${sha}`, b.read)).status, "B never gets A's").toBe(404);
      expect(JSON.parse((await raw(f.port, "GET", "/ui/owner-css/state", b.read)).body).active).toBeNull();
    } finally { await f.stop(); }
  }, 30_000);

  it("a refused text says why and changes nothing", async () => {
    const f = await fleet();
    try {
      const a = f.session({ owner: A });
      const r = await raw(f.port, "POST", "/ui/owner-css", { ...a.write, ...JSON_H }, JSON.stringify({ text: "@import 'http://x/y.css';" }));
      expect([r.status, JSON.parse(r.body)]).toEqual([400, { error: "at_rule", detail: "@import" }]);
      expect(JSON.parse((await raw(f.port, "GET", "/ui/owner-css/state", a.read)).body).versions).toEqual([]);
    } finally { await f.stop(); }
  }, 30_000);

  it("assets: metadata stripped, named by the hash of what is kept, served same-origin; url(\"asset:<id>\") rewritten", async () => {
    const f = await fleet();
    try {
      const a = f.session({ owner: A });
      const up = await raw(f.port, "POST", "/ui/owner-css/asset", { ...a.write, "content-type": "application/octet-stream" }, PNG);
      expect(up.status).toBe(200);
      const { id, kind } = JSON.parse(up.body);
      expect(kind).toBe("png");
      const got = await raw(f.port, "GET", `/ui/owner-css/asset/${id}`, a.read);
      expect([got.status, got.headers["content-type"], got.body.includes("GPS")]).toEqual([200, "image/png", false]);
      const saved = JSON.parse((await raw(f.port, "POST", "/ui/owner-css", { ...a.write, ...JSON_H }, JSON.stringify({ text: `a{background:url("asset:${id}")}` }))).body);
      expect((await raw(f.port, "GET", `/ui/owner-css.css?v=${saved.sha}`, a.read)).body).toBe(`a{background:url("/ui/owner-css/asset/${id}")}`);
      const inUse = await raw(f.port, "DELETE", `/ui/owner-css/asset/${id}`, a.write);
      expect([inUse.status, JSON.parse(inUse.body).error]).toEqual([409, "asset_in_use"]);
      const svg = await raw(f.port, "POST", "/ui/owner-css/asset", { ...a.write, "content-type": "image/svg+xml" }, "<svg xmlns='http://www.w3.org/2000/svg'/>");
      expect([svg.status, JSON.parse(svg.body).error]).toEqual([400, "asset_type"]);
    } finally { await f.stop(); }
  }, 30_000);
});

describe("css.active is the owner-CSS routes' alone", () => {
  it("/ui/prefs neither shows nor sets it", async () => {
    const f = await fleet();
    try {
      const s = f.session();
      const { sha } = JSON.parse((await raw(f.port, "POST", "/ui/owner-css", { ...s.write, ...JSON_H }, JSON.stringify({ text: ".x{}" }))).body);
      expect(sha).toMatch(/^[0-9a-f]{32}$/);
      const view = JSON.parse((await raw(f.port, "GET", "/ui/prefs", s.read)).body);
      expect(Object.keys(view.values)).not.toContain("css.active");
      const set = await raw(f.port, "POST", "/ui/prefs", { ...s.write, ...JSON_H }, JSON.stringify({ set: { "css.active": null } }));
      expect([set.status, JSON.parse(set.body).error]).toEqual([400, "unknown_pref: css.active"]);
    } finally { await f.stop(); }
  }, 30_000);
});

describe("keep or revert", () => {
  it("unkept by its deadline, a saved version reverts on the host to the one before; kept, it stays", async () => {
    const f = await fleet();
    try {
      const a = f.session({ owner: A });
      const one = JSON.parse((await raw(f.port, "POST", "/ui/owner-css", { ...a.write, ...JSON_H }, JSON.stringify({ text: ".one{}" }))).body);
      const first = one.sha;
      expect((await raw(f.port, "POST", "/ui/owner-css/keep", { ...a.write, ...JSON_H }, JSON.stringify({ trial: one.trial }))).status).toBe(200);
      const second = JSON.parse((await raw(f.port, "POST", "/ui/owner-css", { ...a.write, ...JSON_H }, JSON.stringify({ text: ".two{}" }))).body);
      expect(second.previous).toBe(first);
      let state = JSON.parse((await raw(f.port, "GET", "/ui/owner-css/state", a.read)).body);
      expect([state.active, state.pending?.sha, state.pending?.previous]).toEqual([second.sha, second.sha, first]);
      // Time passes past the deadline with no answer (the host's clock is what counts).
      const realNow = Date.now;
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + OWNER_CSS_KEEP_MS + 1_000);
      state = JSON.parse((await raw(f.port, "GET", "/ui/owner-css/state", a.read)).body);
      expect([state.active, state.pending]).toEqual([first, null]);
      const late = await raw(f.port, "POST", "/ui/owner-css/keep", { ...a.write, ...JSON_H }, JSON.stringify({ trial: second.trial }));
      expect([late.status, JSON.parse(late.body).error]).toEqual([409, "not_on_trial"]);
    } finally { await f.stop(); }
  }, 30_000);
});

describe("#1883 r1 (P2-2): a revert names its trial", () => {
  it("kept on one page, a stale page's timed revert of the same trial changes nothing (409); a pending one reverts", async () => {
    const f = await fleet();
    try {
      const a = f.session({ owner: A });
      const post = (path: string, body: unknown) => raw(f.port, "POST", path, { ...a.write, ...JSON_H }, JSON.stringify(body));
      const first = JSON.parse((await post("/ui/owner-css", { text: ".a{}" })).body);
      await post("/ui/owner-css/keep", { trial: first.trial });
      const second = JSON.parse((await post("/ui/owner-css", { text: ".b{}" })).body);
      expect((await post("/ui/owner-css/keep", { trial: second.trial })).status).toBe(200);
      const stale = await post("/ui/owner-css/revert", { trial: second.trial });
      expect([stale.status, JSON.parse(stale.body).error]).toEqual([409, "not_on_trial"]);
      expect(JSON.parse((await raw(f.port, "GET", "/ui/owner-css/state", a.read)).body).active).toBe(second.sha);
      const third = JSON.parse((await post("/ui/owner-css", { text: ".c{}" })).body);
      const back = await post("/ui/owner-css/revert", { trial: third.trial });
      expect([back.status, JSON.parse(back.body).active]).toEqual([200, second.sha]);
    } finally { await f.stop(); }
  }, 30_000);
});

describe("the page names the version in force only where it may be linked (data-owner-css)", () => {
  const bodyTag = (html: string) => /<body[^>]*>/.exec(html)![0];
  it("the signed-in person's full app: yes; the operator's session with none, the CLI token, the anonymous View reader: no", async () => {
    const f = await fleet();
    try {
      const a = f.session({ owner: A });
      const { sha } = JSON.parse((await raw(f.port, "POST", "/ui/owner-css", { ...a.write, ...JSON_H }, JSON.stringify({ text: ".x{}" }))).body);
      expect(bodyTag((await raw(f.port, "GET", "/ui/fleet", a.read)).body)).toContain(`data-owner-css="${sha}"`);
      expect(bodyTag((await raw(f.port, "GET", "/settings/appearance", a.read)).body), "the page carries it; the client never links it on Settings").toContain(`data-owner-css="${sha}"`);
      expect(bodyTag((await raw(f.port, "GET", "/ui/fleet", f.session().read)).body)).not.toContain(" data-owner-css=");
      expect(bodyTag((await raw(f.port, "GET", "/view", {})).body)).not.toContain(" data-owner-css=");
      expect(bodyTag((await raw(f.port, "GET", "/ui/fleet", a.read)).body)).toContain(' data-owner-css-state="on"');
      expect(bodyTag((await raw(f.port, "GET", "/ui/fleet", f.session().read)).body)).toContain(' data-owner-css-state="off"');
      expect(bodyTag((await raw(f.port, "GET", "/view", {})).body)).toContain(' data-owner-css-state="unknown"');
      const header = { "x-agend-token": f.fm.getDashboardAccess().token };
      const headerBody = bodyTag((await raw(f.port, "GET", "/ui/fleet", header)).body);
      expect(headerBody).not.toContain(" data-owner-css="); expect(headerBody).toContain(' data-owner-css-state="unknown"');
      expect(JSON.parse((await raw(f.port, "GET", "/ui/owner-css/state", a.read)).body)).toMatchObject({ active: sha, effectState: "on" });
    } finally { await f.stop(); }
  }, 30_000);
});

describe("no agent path reaches it", () => {
  it("no MCP tool and no agent-endpoint route names owner CSS", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const src = join(process.cwd(), "src");
    const hits: string[] = [];
    for (const f of readdirSync(src).filter(n => n.endsWith(".ts"))) {
      // The web routes, the store and its gate; the prefs key; the image module (shared, a comment); the asset list (the
      // static owner-css.js the page loads) — none is an agent's tool or route.
      // web-auth.ts: the passive-read classification of the page's own owner-CSS reads.
      // web-mod-*.ts (#1629 r4-5): the mod format, and a person's import and export of their own CSS — reached only by
      // the /ui/mods routes (a signed-in session; tested in web-mods-1629), never by a tool or the agent endpoint.
      if (["web-api.ts", "web-owner-css.ts", "web-owner-css-store.ts", "fleet-manager.ts", "web-prefs.ts", "web-image-meta.ts", "auth-api.ts", "web-auth.ts",
        "web-mod-bundle.ts", "web-mod-store.ts", "web-mod-export.ts",
        // web-mod-agent.ts (r4-5b): an agent's mod path names it only to refuse it (owner_css_not_from_agent), and its
        // export never carries it — both tested in web-mods-agent-1629.
        "web-mod-agent.ts",
        // #2026: file admission names the host CSS store only as a forbidden managed root (pinned below).
        "agent-file-read.ts",
        // web-settings-tools.ts (#2056): General's tools change the user's Settings → Web appearance — custom CSS through
        // the store's own save (checkOwnerCss and all), keep, revert and restore (pinned below).
        "web-settings-tools.ts",
        // Try checks the host-supplied CSS lifecycle enum for a closed diagnostic value.
        // It neither imports the CSS store nor exposes its management routes (pinned below).
        "web-effect-trials.ts"].includes(f)) continue;
      if (/owner[-_ ]?css/i.test(readFileSync(join(src, f), "utf8"))) hits.push(f);
    }
    expect(hits, "no tool, CLI or agent route names it").toEqual([]);
    // #2056: General's tools save on trial and keep exactly the trial in force; a version comes back only through the
    // store's restore (a sha its index holds); nothing writes the pointer or a version around the store.
    const files = readFileSync(join(src, "agent-file-read.ts"), "utf8");
    expect(files.match(/owner[-_ ]?css/gi)).toHaveLength(1);
    expect(files).toMatch(/const reservedStateRoots = new Set\(\[[^\]]*"web-owner-css"/);
    expect(files).toContain("reservedStateRoots.has(parts[0]!)");
    expect(files).not.toMatch(/from\s*["']\.\/web-owner-css|import\(\s*["']\.\/web-owner-css|\/ui\/owner-css|setOwnerCss|OwnerCssStore/);
    const tools = readFileSync(join(src, "web-settings-tools.ts"), "utf8");
    expect([...tools.matchAll(/store\.keep\(person, (.*?)\); return/g)].map(m => m[1])).toEqual(["store.state(person).pending?.id"]);
    expect([...tools.matchAll(/store\.restore\(person, ([^)]*)\)/g)].map(m => m[1])).toEqual(["null", "c.version"]);
    expect(tools).not.toMatch(/setOwnerCss|writeIndex|ownerCssActive/);
    expect([...tools.matchAll(/ownerCss\.restore\(person, ([^)]*)\)/g)].map(m => m[1])).toEqual(["null"]);
    const trials = readFileSync(join(src, "web-effect-trials.ts"), "utf8");
    expect(trials).toContain('["off", "on", "loading", "unknown"].includes(d.ownerCss as string)');
    expect(trials).not.toContain('d.ownerCss !== "off"');
    expect(trials).not.toMatch(/from\s*["']\.\/web-owner-css|\/ui\/owner-css|setOwnerCss/);
    const fm = readFileSync(join(src, "fleet-manager.ts"), "utf8");
    // Field, getter, construction — and (r4-5) handing it to the mod store, whose only door is the /ui/mods routes; and
    // (#2056) to General's web-settings tools, whose CSS door is a trial, its revert, or off (pinned above).
    expect(fm.match(/ownerCss/g)?.length, "fleet-manager only holds the store for the web context").toBe(7);
    expect(fm).toContain("prefs: this.webPrefs, ownerCss: this.ownerCss, mods: this.mods, effects: this.effectService,");
    expect(fm).toContain("ownerCss: this.ownerCss,");
  });
});
