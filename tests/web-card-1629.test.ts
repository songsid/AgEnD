/**
 * #1629 r4 §1 + r4.1 (Q2, Q3 (b)): the identity card, host side.
 * - theme.card: closed schema; a one-line tagline of 1..60, a bio of 1..280 with at most 3 line breaks; nothing
 *   invisible or directional; portrait/banner name this instance's pictures for that slot.
 * - web.appearance: r4's numbers are the defaults; each bound is clamped at floor − 1 and ceiling + 1 and said so; a
 *   limit applies to new uploads only (one byte or pixel over is refused, exactly at it is kept); a lowered quota
 *   blocks without deleting.
 * - Pictures larger than one message go up in parts: in order, one upload, a minute between parts, the declared
 *   bytes and sha256; the switch, the lock and the limit are asked at the start and again before the picture is
 *   stored; only a stored picture counts. Both doors (the daemon, agend-agent) send parts.
 * - A person's card (View's Edit profile) wins field by field; Clear card clears only theirs; a person's Reset clears
 *   the agent's; the card's routes are on the public link (r4.1 Q2) while theme reset/lock stay off it.
 * - The status frame carries card_v, which moves with what is drawn.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkTheme } from "../src/web-theme.js";
import { APPEARANCE_BOUNDS, APPEARANCE_DEFAULTS, effectiveAppearanceLimits } from "../src/web-appearance-limits.js";
import { ThemeStore } from "../src/web-theme-store.js";
import { WebAppearance, ASSET_UPLOAD_IDLE_MS } from "../src/web-appearance.js";
import { AppearanceLimiter } from "../src/web-appearance-policy.js";
import { ASSET_PART_BYTES, sendAssetInParts } from "../src/web-asset-parts.js";
import { cardVersion, HumanCardStore, resolveCard } from "../src/web-card.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { isPassiveWebRead } from "../src/web-auth.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
/** A PNG whose header says w×h, with a tEXt chunk (GPS) to strip, and `extra` filler bytes of image data. */
const png = (w = 4, h = 4, extra = 0, seed = 7) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ...be32(13), ...Buffer.from("IHDR"), ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0,
  ...be32(7), ...Buffer.from("tEXtGPS:1,2"), 0, 0, 0, 0]),
  Buffer.from([...be32(1 + extra), ...Buffer.from("IDAT")]), Buffer.alloc(1 + extra, seed), Buffer.from([0, 0, 0, 0, ...be32(0), ...Buffer.from("IEND"), 0, 0, 0, 0])]);
/** The stripped size of png(w, h, extra): the tEXt chunk (19 bytes) goes. */
const kept = (extra: number) => png(4, 4, extra).length - 19;
const GIF = Buffer.from("GIF89a\x04\x00\x04\x00\x00\x00\x00;", "latin1");
const ID = /^[0-9a-f]{32}$/;

describe("theme.card (r4 §1)", () => {
  const P = "a".repeat(32), Bn = "b".repeat(32), BG = "c".repeat(32);
  const slots: Record<string, string> = { [P]: "portrait", [Bn]: "banner", [BG]: "background" };
  const ctx = { assets: new Set([P, Bn, BG]), slotOf: (id: string) => slots[id] };
  const problems = (card: unknown) => { const r = checkTheme({ card }, ctx); return r.ok ? [] : r.errors.map(e => e.path); };
  it("a closed schema; each field to its rule; pictures of this instance, for that slot", () => {
    expect(checkTheme({ card: { portrait: P, banner: Bn, tagline: "Reviews your PRs", bio: "Line one\nLine two 👨‍👩‍👧" } }, ctx))
      .toEqual({ ok: true, theme: { v: 1, card: { portrait: P, banner: Bn, tagline: "Reviews your PRs", bio: "Line one\nLine two 👨‍👩‍👧" } } });
    expect(problems({ motto: "x" })).toEqual(["card.motto"]);
    expect(problems({ portrait: BG })).toEqual(["card.portrait"]);                       // a background is not a portrait
    expect(problems({ banner: P })).toEqual(["card.banner"]);
    expect(problems({ portrait: "d".repeat(32) })).toEqual(["card.portrait"]);           // not this instance's
    expect(problems({ portrait: "https://x/y.png" })).toEqual(["card.portrait"]);
    expect(problems("text")).toEqual(["card"]);
  });
  it("tagline: one line of 1..60; bio: 1..280 with at most 3 line breaks; nothing invisible or directional", () => {
    expect(problems({ tagline: "x".repeat(60) })).toEqual([]);
    expect(problems({ tagline: "x".repeat(61) })).toEqual(["card.tagline"]);
    expect(problems({ tagline: "two\nlines" })).toEqual(["card.tagline"]);
    expect(problems({ bio: "x".repeat(280) })).toEqual([]);
    expect(problems({ bio: "x".repeat(281) })).toEqual(["card.bio"]);
    expect(problems({ bio: "a\nb\nc\nd" })).toEqual([]);
    expect(problems({ bio: "a\nb\nc\nd\ne" })).toEqual(["card.bio"]);                 // four line breaks
    expect(problems({ bio: "a\r\nb" })).toEqual(["card.bio"]);                        // only "\n" (the person's side normalises)
    expect(problems({ bio: "Think‮ing" })).toEqual(["card.bio"]);                 // a bidi override
    expect(problems({ bio: "bell\u0007" })).toEqual(["card.bio"]);
    expect(problems({ bio: "‍" })).toEqual(["card.bio"]);                         // draws nothing
    expect(problems({ bio: " padded" })).toEqual(["card.bio"]);
  });
});

describe("web.appearance limits (r4.1 Q3 (b))", () => {
  it("the defaults are r4's numbers", () => {
    expect(APPEARANCE_DEFAULTS).toEqual({ portrait: { max_width: 1024, max_height: 1536, max_kib: 1536 }, banner: { max_width: 1600, max_height: 600, max_kib: 768 }, instance_quota: { files: 8, mib: 4 } });
    expect(effectiveAppearanceLimits(undefined)).toEqual({ warnings: [], limits: {
      portrait: { maxWidth: 1024, maxHeight: 1536, maxBytes: 1536 * 1024 }, banner: { maxWidth: 1600, maxHeight: 600, maxBytes: 768 * 1024 }, quota: { files: 8, bytes: 4 * 1024 * 1024 } } });
  });
  it("each bound: floor − 1 and ceiling + 1 are clamped, and said so; the bounds themselves are kept", () => {
    for (const [group, keys] of Object.entries(APPEARANCE_BOUNDS)) {
      for (const [key, [floor, ceiling]] of Object.entries(keys as Record<string, readonly [number, number]>)) {
        const at = (v: number) => effectiveAppearanceLimits({ [group]: { [key]: v } });
        const low = at(floor - 1), high = at(ceiling + 1), atFloor = at(floor), atCeiling = at(ceiling);
        expect(low.warnings, `${group}.${key} low`).toEqual([{ path: `web.appearance.${group}.${key}`, message: `${floor - 1} is below the floor ${floor} — ${floor} is used` }]);
        expect(high.warnings, `${group}.${key} high`).toEqual([{ path: `web.appearance.${group}.${key}`, message: `${ceiling + 1} is above the ceiling ${ceiling} — ${ceiling} is used` }]);
        expect([atFloor.warnings, atCeiling.warnings]).toEqual([[], []]);
        expect(JSON.stringify(low.limits)).toBe(JSON.stringify(atFloor.limits));
        expect(JSON.stringify(high.limits)).toBe(JSON.stringify(atCeiling.limits));
      }
    }
  });
  it("wrong types and unknown keys: the default, with a warning — never an error in the config validator", () => {
    const r = effectiveAppearanceLimits({ portrait: { max_kib: "big", max_width: 10.5, depth: 3 }, sticker: {}, banner: 5 });
    expect(r.warnings.map(w => w.path)).toEqual(["web.appearance.sticker", "web.appearance.portrait.depth", "web.appearance.portrait.max_width", "web.appearance.portrait.max_kib", "web.appearance.banner"]);
    expect(r.limits.portrait).toEqual({ maxWidth: 1024, maxHeight: 1536, maxBytes: 1536 * 1024 });
    const v = validateFleetConfig({ instances: {}, web: { appearance: { portrait: { max_kib: 99999 } } } });
    expect([v.errors, v.warnings.map(w => w.path).filter(p => p.startsWith("web."))]).toEqual([[], ["web.appearance.portrait.max_kib"]]);
  });
});

describe("the store under the limits in force", () => {
  const storeWith = (cfg: () => unknown) => new ThemeStore(tmp("agend-card-"), { limits: () => effectiveAppearanceLimits(cfg()).limits });
  it("one pixel or one byte over is refused; exactly at the limit is kept", () => {
    let cfg: Record<string, unknown> = { portrait: { max_width: 100, max_height: 200, max_kib: 32 } };
    const s = storeWith(() => ({ ...cfg }));
    expect(s.addAsset("a", "portrait", png(101, 200))).toMatchObject({ ok: false, error: "asset_dimensions" });
    expect(s.addAsset("a", "portrait", png(100, 201))).toMatchObject({ ok: false, error: "asset_dimensions" });
    expect(s.addAsset("a", "portrait", png(100, 200))).toMatchObject({ ok: true, id: expect.stringMatching(ID) });
    const exact = png(4, 4, 32 * 1024 - png(4, 4, 0).length);
    expect(exact.length).toBe(32 * 1024);
    expect(s.addAsset("a", "portrait", exact)).toMatchObject({ ok: true });
    expect(s.addAsset("a", "portrait", png(4, 4, 32 * 1024 - png(4, 4, 0).length + 1))).toMatchObject({ ok: false, error: "asset_too_large" });
    expect(s.addAsset("a", "banner", GIF)).toMatchObject({ ok: false, error: "asset_type" });            // a card picture is a still
    cfg = {};
    expect(s.addAsset("a", "portrait", png(1024, 1536, 0, 9))).toMatchObject({ ok: true });            // the defaults again
  });
  it("raising or lowering a limit never touches a stored picture; a lowered quota blocks without deleting", () => {
    let cfg: Record<string, unknown> = {};
    const s = storeWith(() => cfg);
    const ids = [1, 2, 3].map(k => (s.addAsset("a", "avatar", png(4, 4, k)) as { id: string }).id);
    const p = (s.addAsset("a", "portrait", png(600, 900)) as { id: string }).id;
    const files = () => readdirSync(join((s as unknown as { assetDir(n: string): string }).assetDir("a"))).sort();
    const before = files();
    cfg = { instance_quota: { files: 2 }, portrait: { max_width: 64, max_height: 64 } };
    expect(s.addAsset("a", "avatar", png(4, 4, 9))).toMatchObject({ ok: false, error: "asset_quota" });
    expect([files(), s.get("a").assets.map(a => a.id)]).toEqual([before, [...ids, p]]);
    expect(s.asset("a", p)).not.toBeNull();
    expect(s.addAsset("a", "avatar", png(4, 4, 1))).toMatchObject({ ok: true, id: ids[0] });           // already held: the same id
    cfg = { instance_quota: { files: 16 } };
    expect(s.addAsset("a", "avatar", png(4, 4, 9))).toMatchObject({ ok: true });
  });
  it("an asset holds one slot: the same picture for another slot is refused, so a card names only its own", () => {
    const s = storeWith(() => ({}));
    expect(s.addAsset("a", "avatar", png())).toMatchObject({ ok: true });
    expect(s.addAsset("a", "portrait", png())).toMatchObject({ ok: false, status: 409, error: "asset_other_slot" });
  });
});

describe("pictures in parts (r4 §1: larger than one message)", () => {
  const service = (opts: { clock?: () => number; cfg?: () => unknown } = {}) => {
    const store = new ThemeStore(tmp("agend-card-"), { limits: () => effectiveAppearanceLimits(opts.cfg?.() ?? {}).limits });
    let t = 0;
    const limiter = new AppearanceLimiter(() => (opts.clock ?? (() => t))());
    const svc = new WebAppearance(store, () => null, () => {}, limiter, opts.clock ?? (() => t));
    return { store, svc, limiter, at: (ms: number) => { t = ms; } };
  };
  const big = png(800, 1200, 1_000_000);   // ~1 MB: three parts
  it("in order, then stored once — the id is the stripped picture's; the upload counts once, at the end", async () => {
    const { svc, store, limiter } = service();
    const sent: Array<Record<string, unknown>> = [];
    const answer = await sendAssetInParts("portrait", big, async (args) => { sent.push(args); return svc.handleTool("w", "set_web_theme_asset", args); });
    expect(sent.length).toBe(Math.ceil(big.length / ASSET_PART_BYTES));
    expect(answer).toEqual({ id: expect.stringMatching(ID) });
    expect(store.get("w").assets).toEqual([{ id: (answer as { id: string }).id, slot: "portrait", kind: "png", bytes: big.length - 19 }]);
    expect(store.asset("w", (answer as { id: string }).id)!.bytes.includes(Buffer.from("GPS:1,2"))).toBe(false);
    expect(limiter.remaining("w").uploads).toBe(2);
  });
  it("refused: a part out of order, another upload's id, a gap over a minute, bytes that do not add up — none counts", () => {
    const { svc, limiter, at } = service();
    const chunks = [0, 1, 2].map(k => big.subarray(k * ASSET_PART_BYTES, (k + 1) * ASSET_PART_BYTES));
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const meta = { count: 3, bytes: big.length, sha256: createHash("sha256").update(big).digest("hex") };
    const part = (k: number, upload?: string, data = chunks[k]!) => svc.handleTool("w", "set_web_theme_asset", { slot: "portrait", data_b64: data.toString("base64"), part: { index: k, ...meta, ...(upload ? { upload } : {}) } });
    const start = () => part(0).upload as string;
    let up = start();
    expect(part(2, up)).toMatchObject({ error: "part" });                       // skipped part 1
    expect(part(1, up)).toMatchObject({ error: "upload" });                     // that upload was dropped
    up = start();
    expect(part(1, "f".repeat(16))).toMatchObject({ error: "upload" });         // not this upload
    up = start(); at(ASSET_UPLOAD_IDLE_MS + 1);
    expect(part(1, up)).toMatchObject({ error: "upload" });                     // waited too long
    at(0); up = start();
    expect(part(1, up)).toMatchObject({ upload: up });
    expect(part(2, up, Buffer.alloc(chunks[2]!.length, 1))).toMatchObject({ error: "part", message: expect.stringContaining("do not add up") });
    expect(svc.handleTool("w", "set_web_theme_asset", { slot: "portrait", data_b64: chunks[0]!.toString("base64"), part: { index: 0, count: 2, bytes: big.length, sha256: meta.sha256 } })).toMatchObject({ error: "part" });
    expect(svc.handleTool("w", "set_web_theme_asset", { slot: "portrait", data_b64: chunks[0]!.toString("base64"), part: { index: 0, count: 9, bytes: 9 * 1024 * 1024, sha256: meta.sha256 } })).toMatchObject({ error: "asset_too_large" });
    expect(limiter.remaining("w").uploads).toBe(3);
  });
  it("a lock set during the upload refuses it at the end (nothing stored, nothing counted)", async () => {
    const { svc, store, limiter } = service();
    let n = 0;
    const answer = await sendAssetInParts("portrait", big, async (args) => { if (n++ === 1) store.setLocked("w", true); return svc.handleTool("w", "set_web_theme_asset", args); });
    expect([answer, store.get("w").assets, limiter.remaining("w").uploads]).toEqual([expect.objectContaining({ error: "locked" }), [], 3]);
  });
  it("the daemon reads a large picture and sends it in parts, each answered before the next", async () => {
    const ws = tmp("agend-card-ws-");
    writeFileSync(join(ws, "me.png"), big);
    const { svc, store } = service();
    const { Daemon } = await import("../src/daemon.js");
    const daemon = new Daemon("worker", { working_directory: ws, log_level: "error", restart_policy: { max_retries: 1, backoff: "exponential", reset_after: 300 },
      context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 } } as never, join(ws, ".instance"), true, undefined, undefined, pino({ level: "silent" }) as never) as any;
    const send = vi.fn((_socket: unknown, _msg: unknown) => true);
    const sizes: number[] = [];
    const broadcast = vi.fn((msg: { payload: Record<string, unknown>; fleetRequestId: string; meta: { instance_name: string } }) => {
      sizes.push(JSON.stringify(msg).length);
      expect(Object.keys(msg.payload).sort()).toEqual(["data_b64", "part", "slot"]);
      const result = svc.handleTool(msg.meta.instance_name, "set_web_theme_asset", msg.payload);
      setImmediate(() => daemon.pendingIpcRequests.get(msg.fleetRequestId)?.({ result }));
    });
    daemon.ipcServer = { send, broadcast };
    daemon.handleToolCall({ tool: "set_web_theme_asset", args: { slot: "portrait", file: "me.png" }, requestId: 3 }, {} as never);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send.mock.calls[0]![1]).toMatchObject({ requestId: 3, result: { id: expect.stringMatching(ID) } });
    expect([broadcast.mock.calls.length, Math.max(...sizes) < 1024 * 1024, store.get("worker").assets.length]).toEqual([3, true, 1]);
  });
  it("agend-agent theme asset portrait: read here, sent in parts that fit the endpoint's 512 KiB body", async () => {
    const { createServer } = await import("node:http");
    const { execFile } = await import("node:child_process");
    const { svc, store } = service();
    const bodies: number[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => { bodies.push(Buffer.byteLength(body)); const p = JSON.parse(body); res.end(JSON.stringify(svc.handleTool(p.instance, "set_web_theme_asset", p.args))); });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const home = tmp("agend-card-cli-"), ws = tmp("agend-card-cli-ws-");
    writeFileSync(join(ws, "p.png"), big);
    try {
      const out = await new Promise<string>(resolve => execFile(process.execPath, ["--import", pathToFileURL(join(process.cwd(), "node_modules/tsx/dist/loader.mjs")).href, join(process.cwd(), "src/agent-cli.ts"), "theme", "asset", "portrait", "p.png"], {
        cwd: ws, env: { ...process.env, AGEND_PORT: String(port), AGEND_INSTANCE_NAME: "worker", AGEND_HOME: home }, timeout: 60_000,
      }, (_err, stdout) => resolve(stdout)));
      expect(JSON.parse(out)).toEqual({ id: expect.stringMatching(ID) });
      expect([bodies.length, bodies.every(b => b < 512 * 1024), store.get("worker").assets.map(a => a.slot)]).toEqual([3, true, ["portrait"]]);
    } finally { await new Promise(r => server.close(r)); }
  }, 120_000);
});

describe("a person's card wins, field by field", () => {
  const cards = () => {
    const dir = tmp("agend-card-h-");
    let db: import("better-sqlite3").Database | null = null;
    const open = () => (db ??= new (require("better-sqlite3"))(join(dir, "profiles.db")));
    return { dir, store: new HumanCardStore(dir, open), open };
  };
  const limits = effectiveAppearanceLimits({}).limits;
  it("one explicit bound in UTF-16 units too: 280 emoji families are a bio; 280 graphemes of 12 units are not (#1889 review)", () => {
    const { store } = cards();
    const family = "👨‍👩‍👧".repeat(280);
    expect([family.length, store.setText("a", { bio: family })]).toEqual([2240, { ok: true }]);
    expect(resolveCard("a", store.get("a"), undefined).bio).toEqual({ text: family, by: "human" });
    expect(store.setText("a", { bio: ("x" + "\u0301".repeat(11)).repeat(280) })).toMatchObject({ ok: false, error: "card_bio" });
    expect(store.setText("a", { tagline: ("x" + "\u0301".repeat(11)).repeat(60) })).toMatchObject({ ok: false, error: "card_tagline" });
  });
  it("text: the agent's rules; blank clears; CRLF is a line break", () => {
    const { store } = cards();
    expect(store.setText("a", { tagline: "Mine", bio: "one\r\ntwo" })).toEqual({ ok: true });
    expect(store.get("a")).toMatchObject({ tagline: "Mine", bio: "one\ntwo" });
    expect(store.setText("a", { tagline: "x".repeat(61) })).toMatchObject({ ok: false, error: "card_tagline" });
    expect(store.setText("a", { bio: "a\nb\nc\nd\ne" })).toMatchObject({ ok: false, error: "card_bio" });
    expect(store.setText("a", { tagline: "  " })).toEqual({ ok: true });
    expect(store.get("a")).toMatchObject({ tagline: null, bio: "one\ntwo" });
  });
  it("pictures: checked against the limits in force, stripped, the old one deleted; Clear card goes only for theirs", () => {
    const { store, dir } = cards();
    expect(store.setPicture("a", "portrait", png(1025, 10), limits)).toMatchObject({ ok: false, error: "card_dimensions" });
    expect(store.setPicture("a", "banner", GIF, limits)).toMatchObject({ ok: false, error: "card_type" });
    expect(store.setPicture("a", "portrait", png(10, 10, 1), limits)).toMatchObject({ ok: true });
    const two = store.setPicture("a", "portrait", png(10, 10, 2), limits) as { ok: true; id: string };
    expect(store.picture("a", "portrait")!.id).toBe(two.id);
    const cardDir = join(dir, "cards", readdirSync(join(dir, "cards"))[0]!);
    expect(readdirSync(cardDir)).toEqual([`portrait-${two.id}.png`]);                       // the replaced one went
    expect(readFileSync(join(cardDir, `portrait-${two.id}.png`)).includes(Buffer.from("GPS:1,2"))).toBe(false);
    writeFileSync(join(cardDir, "portrait-unrelated.png"), "keep");                           // not a file the row names
    store.setText("a", { tagline: "Mine" });
    expect(store.clear("a")).toEqual({ ok: true });
    expect([store.get("a"), readdirSync(cardDir)]).toEqual([{ tagline: null, bio: null, portrait: null, banner: null, updated_at: 0 }, ["portrait-unrelated.png"]]);
  });
  it("resolved per field: the person's where set, else the agent's — each marked whose", () => {
    const agent = { portrait: "a".repeat(32), banner: "b".repeat(32), tagline: "Agent's", bio: "Agent's bio" };
    const human = { tagline: "Person's", bio: null, portrait: `portrait-${"c".repeat(32)}.png`, banner: null, updated_at: 1 };
    expect(resolveCard("x y", human, agent)).toEqual({
      portrait: { id: "c".repeat(32), by: "human", src: `/api/card/x%20y/portrait?v=${"c".repeat(32)}` },
      banner: { id: "b".repeat(32), by: "agent", src: `/api/card/x%20y/banner?v=${"b".repeat(32)}` },
      tagline: { text: "Person's", by: "human" },
      bio: { text: "Agent's bio", by: "agent" },
    });
    expect(cardVersion(resolveCard("x", undefined, undefined))).toBeNull();
    // #1889 review: whose picture it is moves the version too (the same bytes, set by a person over the agent's).
    const C = "c".repeat(32);
    const onlyPicture = { tagline: null, bio: null, portrait: `portrait-${C}.png`, banner: null, updated_at: 2 };
    expect(cardVersion(resolveCard("x", undefined, { portrait: C }))).not.toBe(cardVersion(resolveCard("x", onlyPicture, { portrait: C })));
    const v1 = cardVersion(resolveCard("x", human, agent)), v2 = cardVersion(resolveCard("x", { ...human, tagline: null }, agent));
    expect([typeof v1, v1 === v2]).toEqual(["string", false]);
  });
});

describe("the card's routes", () => {
  it("on the public link (r4.1 Q2) — theme reset and lock still off it; the page's card reads are passive", () => {
    for (const [m, p] of [["GET", "/api/card/a"], ["GET", "/api/card/a/portrait"], ["POST", "/api/card/a/banner"], ["DELETE", "/api/card/a/portrait"], ["DELETE", "/api/card/a"]] as const) expect(isPublicWebRoute(m, p), `${m} ${p}`).toBe(true);
    for (const [m, p] of [["POST", "/api/card/a"], ["POST", "/api/card/a/avatar"], ["POST", "/ui/themes/a/reset"], ["POST", "/ui/themes/a/lock"]] as const) expect(isPublicWebRoute(m, p), `${m} ${p}`).toBe(false);
    expect([isPassiveWebRead("GET", "/api/card/a"), isPassiveWebRead("GET", "/api/card/a/banner"), isPassiveWebRead("DELETE", "/api/card/a")]).toEqual([true, true, false]);
  });
  it("through the handler: a person's edits (session and public link alike), resolved over the agent's; Reset clears only the agent's", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { handleViewRequest } = await import("../src/view-api.js");
    const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
    const { bindGatewayRequest } = await import("../src/web-request-context.js");
    const dir = tmp("agend-card-fm-");
    const fm = new FleetManager(dir) as any;
    const quiet = () => {};
    fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
    fm.fleetConfig = { instances: { alpha: { working_directory: "/tmp" } }, defaults: {} };
    fm.initializeWebAuthTokens(); fm.initializeWebSessions();
    const P = (fm.themeStore.addAsset("alpha", "portrait", png(20, 30)) as { id: string }).id;
    fm.webAppearance.setTheme("alpha", { set: { card: { portrait: P, tagline: "Agent's" } } });
    const call = (method: string, path: string, body?: Buffer | string, gateway = false, beforeBody?: () => void) => new Promise<{ status: number; body: string; headers: Record<string, string> }>((resolve) => {
      const surface = gateway ? "gateway" : "local";
      const { sessionId } = fm.webSessions.create({ tier: "admin", surface, ...(gateway ? { exposureId: "e".repeat(32) } : {}), label: "t", tokenEpoch: tokenEpoch(fm.webToken) });
      const host = gateway ? "x.trycloudflare.com" : "127.0.0.1:19280";
      const origin = gateway ? "https://x.trycloudflare.com" : "http://127.0.0.1:19280";
      const req: any = Object.assign(new EventEmitter(), { method, url: path, headers: { host, origin, cookie: `${gateway ? "__Host-" : ""}agend_session=${sessionId}`, "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/octet-stream" }, socket: { remoteAddress: "127.0.0.1" }, destroy() {}, resume() {} });
      if (gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: origin, isCurrent: () => true });
      let status = 0; const headers: Record<string, string> = {};
      const res: any = { headersSent: false, setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; }, writeHead(c: number, h?: Record<string, string>) { status = c; Object.assign(headers, Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]))); res.headersSent = true; return res; }, end(b?: Buffer | string) { resolve({ status, body: b ? b.toString() : "", headers }); } };
      expect(handleViewRequest(req, res, new URL(`${origin}${path}`), fm)).toBe(true);
      setImmediate(() => { beforeBody?.(); if (body !== undefined) req.emit("data", Buffer.isBuffer(body) ? body : Buffer.from(body)); req.emit("end"); });
    });
    const resolved = async () => { const { limits, ...card } = JSON.parse((await call("GET", "/api/card/alpha")).body); expect(limits.portrait).toEqual({ max_width: 1024, max_height: 1536, max_bytes: 1536 * 1024 }); return card; };
    expect(await resolved()).toEqual({ portrait: { id: P, by: "agent", src: `/api/card/alpha/portrait?v=${P}` }, tagline: { text: "Agent's", by: "agent" } });
    const agentPic = await call("GET", "/api/card/alpha/portrait");
    expect([agentPic.status, agentPic.headers["x-content-type-options"], agentPic.headers["content-security-policy"]]).toEqual([200, "nosniff", "default-src 'none'; sandbox"]);
    // The public link edits the person's card (r4.1 Q2), and it wins.
    const up = await call("POST", "/api/card/alpha/portrait", png(40, 40, 3), true);
    expect(up.status).toBe(200);
    const mine = JSON.parse(up.body).id as string;
    const text = await call("POST", "/api/profile/alpha", JSON.stringify({ card_bio: "Person's bio" }), true);
    expect(text.status).toBe(200);
    expect(await resolved()).toEqual({ portrait: { id: mine, by: "human", src: `/api/card/alpha/portrait?v=${mine}` }, tagline: { text: "Agent's", by: "agent" }, bio: { text: "Person's bio", by: "human" } });
    expect((await call("POST", "/api/profile/alpha", JSON.stringify({ card_tagline: "x".repeat(61), display_name: "Not saved" }))).status).toBe(400);
    expect(JSON.parse((await call("GET", "/api/profile/alpha")).body).display_name).toBeNull();          // a bad card field changes nothing
    expect((await call("POST", "/api/card/alpha/portrait", png(2000, 10, 4))).status).toBe(400);
    // A person's Reset clears the agent's card; theirs stays. Clear card clears theirs.
    expect(fm.webAppearance.humanReset("alpha")).toMatchObject({ ok: true });
    expect(await resolved()).toEqual({ portrait: { id: mine, by: "human", src: `/api/card/alpha/portrait?v=${mine}` }, bio: { text: "Person's bio", by: "human" } });
    expect((await call("DELETE", "/api/card/alpha", undefined, true)).status).toBe(200);
    expect(await resolved()).toEqual({});
    expect((await call("GET", "/api/card/alpha/portrait")).status).toBe(404);
    expect((await call("GET", "/api/card/ghost")).status).toBe(404);
    // #1889 review: the limits in force when the picture is stored, not when its upload began.
    const limit = (w: number) => { fm.fleetConfig.web = { appearance: { portrait: { max_width: w } } }; };
    limit(200);
    const lowered = await call("POST", "/api/card/alpha/portrait", png(100, 100, 7), false, () => limit(64));
    expect([lowered.status, JSON.parse(lowered.body).error]).toEqual([400, "card_dimensions"]);
    limit(64);
    expect((await call("POST", "/api/card/alpha/portrait", png(100, 100, 8), false, () => limit(200))).status).toBe(200);   // raised meanwhile: kept
    limit(200);
    expect((await call("POST", "/api/card/alpha/portrait", png(100, 100, 9))).status).toBe(200);                           // unchanged: kept
    delete fm.fleetConfig.web;
    expect((await call("DELETE", "/api/card/alpha")).status).toBe(200);
    // The frame's card_v follows what is drawn.
    vi.spyOn(fm, "getInstanceStatus").mockReturnValue("running");
    const v = () => fm.getUiStatus().instances.find((i: { name: string }) => i.name === "alpha").card_v;
    expect(v()).toBeUndefined();
    await call("POST", "/api/profile/alpha", JSON.stringify({ card_tagline: "Hello" }));
    const v1 = v();
    await call("POST", "/api/profile/alpha", JSON.stringify({ card_tagline: "Hello again" }));
    expect([typeof v1, v() !== v1]).toEqual(["string", true]);
    expect(existsSync(join(dir, "profiles.db"))).toBe(true);
    // View's roster carries the same card_v (its anonymous reader reads the card when it moves).
    const roster = JSON.parse((await call("GET", "/api/profiles")).body) as Array<{ instance_name: string; card_v?: string }>;
    expect(roster.find(r => r.instance_name === "alpha")!.card_v).toBe(v());
  }, 60_000);
});
