/**
 * #1630 (design: the comment on #1630): the host cache for platform images, and the rule that decides what stands for
 * an instance. The real WebImageCache on a scratch directory with a wall clock and a monotonic clock the test moves;
 * the real avatarFor / ownBotConnections / firstCharacter / accentColor.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebImageCache, WEB_IMAGE_MAX_AGE_MS, WEB_IMAGE_PRUNE_MS, WEB_IMAGE_RETRY_MS, imageMimeForFile } from "../src/web-images.js";
import { accentColor, avatarFor, firstCharacter, ownBotConnections } from "../src/instance-avatar.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const PNG = (n = 1) => ({ bytes: Buffer.alloc(16, n), ext: "png" as const });

function cache() {
  const dir = join(mkdtempSync(join(tmpdir(), "agend-1630-")), "cache", "avatars"); dirs.push(join(dir, "..", ".."));
  const clock = { wall: Date.now(), mono: 1_000 };              // the wall clock starts where file mtimes are written
  const errors: string[] = [];
  const c = new WebImageCache({ dir, now: () => clock.wall, mono: () => clock.mono, onError: (key) => errors.push(key) });
  let calls = 0;
  const loader = (result: () => Promise<{ bytes: Buffer; ext: "png" | "jpg" | "gif" | "webp" } | null>) => () => { calls++; return result(); };
  /** Age the files on disk by `ms` of wall time (their mtime), as a day passing would. */
  const age = (ms: number) => { clock.wall += ms; };
  const touchAll = (ms: number) => { for (const f of readdirSync(dir)) { const t = (clock.wall - ms) / 1000; utimesSync(join(dir, f), t, t); } };
  /** Puts the wall clock exactly at the newest file's real mtime (a file is written a few ms after the test began). */
  const atFileTime = () => { clock.wall = Math.max(...readdirSync(dir).map(f => statSync(join(dir, f)).mtimeMs)); };
  return { dir, c, clock, errors, loader, age, touchAll, atFileTime, calls: () => calls };
}

describe("the host cache", () => {
  it("nothing cached: peek says so and fetches behind; the next peek has it, with a version; read gives the bytes", async () => {
    const w = cache();
    const load = w.loader(async () => PNG(7));
    expect(w.c.peek("bot:discord-2", load)).toBeNull();
    await w.c.refresh("bot:discord-2", load);                 // the one already running (deduplicated)
    const seen = w.c.peek("bot:discord-2", load);
    expect([typeof seen?.version, w.calls()]).toEqual(["string", 1]);
    expect(w.c.read("bot:discord-2")).toEqual({ bytes: Buffer.alloc(16, 7), mime: "image/png", version: seen!.version });
  });
  it("a file is named by a hash of its key — a key never becomes a path; a private directory", async () => {
    const w = cache();
    await w.c.refresh("../../etc/passwd", w.loader(async () => PNG()));
    expect(readdirSync(w.dir)).toEqual([expect.stringMatching(/^[0-9a-f]{32}\.png$/)]);
    expect(existsSync(join(w.dir, "..", "..", "etc"))).toBe(false);
  });
  it("one fetch per key at a time, however many ask", async () => {
    const w = cache();
    let release!: () => void;
    const load = w.loader(() => new Promise(r => { release = () => r(PNG()); }));
    const a = w.c.refresh("k", load), b = w.c.refresh("k", load);
    w.c.peek("k", load); void w.c.get("k", load);
    await new Promise(r => setImmediate(r));                      // the fetch starts on a later tick
    release(); await Promise.all([a, b]);
    expect(w.calls()).toBe(1);
  });
  it("fresh for a day; after that the stale file is still served while it is refreshed behind", async () => {
    const w = cache();
    let n = 1;
    const load = w.loader(async () => PNG(n++));
    await w.c.refresh("k", load);
    w.atFileTime();
    w.age(WEB_IMAGE_MAX_AGE_MS - 1000);
    w.c.peek("k", load);
    expect(w.calls(), "fresh: not fetched again").toBe(1);
    w.age(1000);
    const got = await w.c.get("k", load);
    await new Promise(r => setImmediate(r));
    expect([got!.bytes[0], w.calls()], "the stale copy at once, and a refresh started behind it").toEqual([1, 2]);
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    expect([w.calls(), w.c.read("k")!.bytes[0]], "the refreshed copy replaced it").toEqual([2, 2]);
    w.age(WEB_IMAGE_MAX_AGE_MS);
    w.c.peek("k", load);
    await new Promise(r => setImmediate(r));
    expect(w.calls(), "peek refreshes a stale file too").toBe(3);
  });
  it("a failed fetch keeps the copy it had, and the key is quiet for an hour (monotonic), then tried again", async () => {
    const w = cache();
    await w.c.refresh("k", w.loader(async () => PNG(1)));
    w.age(WEB_IMAGE_MAX_AGE_MS);
    const failing = w.loader(async () => { throw new Error("HTTP 503"); });
    await w.c.refresh("k", failing);
    expect([w.c.read("k")?.bytes[0], w.errors]).toEqual([1, ["k"]]);
    w.clock.mono += WEB_IMAGE_RETRY_MS - 1;
    await w.c.refresh("k", failing);
    w.clock.wall -= 10 * WEB_IMAGE_MAX_AGE_MS;                   // the wall clock jumping back changes nothing
    await w.c.refresh("k", failing);
    expect(w.calls(), "quiet: no second try within the hour").toBe(2);
    w.clock.mono += 1;
    await w.c.refresh("k", failing);
    expect(w.calls()).toBe(3);
  });
  it("a loader that throws at once still releases its key: tried again after the hour (#1635 review)", async () => {
    const w = cache();
    const throwsNow = w.loader((() => { throw new Error("sync"); }) as never);
    await w.c.refresh("k", throwsNow);
    w.clock.mono += WEB_IMAGE_RETRY_MS;
    await w.c.refresh("k", throwsNow);
    expect([w.calls(), w.errors]).toEqual([2, ["k", "k"]]);
  });
  it("a write that fails leaves no temporary file behind (#1635 review)", async () => {
    const w = cache();
    const { createHash } = await import("node:crypto");
    mkdirSync(join(w.dir, `${createHash("sha256").update("k").digest("hex").slice(0, 32)}.png`), { recursive: true });   // the target is a directory
    await w.c.refresh("k", w.loader(async () => PNG()));
    expect([w.errors, readdirSync(w.dir).filter(n => n.endsWith(".tmp"))]).toEqual([["k"], []]);
  });
  it("a failed first fetch leaves nothing: peek stays null (the caller falls back)", async () => {
    const w = cache();
    await w.c.refresh("k", w.loader(async () => { throw new Error("HTTP 401"); }));
    expect([w.c.peek("k", w.loader(async () => PNG())), w.c.read("k")]).toEqual([null, null]);
  });
  it("'there is no picture' removes the cached one, and is not asked again for a day", async () => {
    const w = cache();
    await w.c.refresh("k", w.loader(async () => PNG()));
    w.age(WEB_IMAGE_MAX_AGE_MS);
    const none = w.loader(async () => null);
    await w.c.refresh("k", none);
    expect([w.c.read("k"), readdirSync(w.dir)]).toEqual([null, []]);
    w.c.peek("k", none); w.c.peek("k", none);
    expect(w.calls()).toBe(2);
    w.clock.mono += WEB_IMAGE_MAX_AGE_MS;
    await w.c.refresh("k", none);
    expect(w.calls()).toBe(3);
  });
  it("what is not a usable picture is refused and nothing is written (too big, empty)", async () => {
    const w = cache();
    await w.c.refresh("big", w.loader(async () => ({ bytes: Buffer.alloc(256 * 1024 + 1), ext: "png" as const })));
    await w.c.refresh("empty", w.loader(async () => ({ bytes: Buffer.alloc(0), ext: "png" as const })));
    expect([existsSync(w.dir) ? readdirSync(w.dir).length : 0, w.errors]).toEqual([0, ["big", "empty"]]);
  });
  it("a new picture of another type replaces the old one (one file per key)", async () => {
    const w = cache();
    await w.c.refresh("k", w.loader(async () => PNG()));
    w.age(WEB_IMAGE_MAX_AGE_MS);
    await w.c.refresh("k", w.loader(async () => ({ bytes: Buffer.alloc(8, 9), ext: "jpg" as const })));
    expect([readdirSync(w.dir).length, w.c.read("k")!.mime]).toEqual([1, "image/jpeg"]);
  });
  it("files not refreshed for 30 days are deleted on the next write", async () => {
    const w = cache();
    await w.c.refresh("old", w.loader(async () => PNG()));
    w.touchAll(WEB_IMAGE_PRUNE_MS + 1000);
    await w.c.refresh("new", w.loader(async () => PNG()));
    expect([w.c.read("old"), !!w.c.read("new")]).toEqual([null, true]);
  });
  it("an uploaded file's type by its extension", () => {
    expect(["a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp", "a.svg", "a", "a.png.exe"].map(imageMimeForFile))
      .toEqual(["image/png", "image/jpeg", "image/jpeg", "image/gif", "image/webp", null, null, null]);
  });
});

describe("what stands for an instance", () => {
  it("0. the picture uploaded in View comes first", () => {
    expect(avatarFor({ name: "web dev", profileVersion: "k1", bot: { connection: "discord-2", version: "b1" }, personaEmoji: "🦊" }))
      .toEqual({ kind: "image", src: "/ui/img/avatar/web%20dev?v=k1" });
  });
  it("1. then its own bot's avatar", () => {
    expect(avatarFor({ name: "x", bot: { connection: "discord-2", version: "b1" }, personaEmoji: "🦊" }))
      .toEqual({ kind: "image", src: "/ui/img/bot/discord-2?v=b1" });
  });
  it("2. then the persona emoji: unicode as text, a Discord server emoji through the emoji route", () => {
    expect(avatarFor({ name: "x", personaEmoji: " 🦊 " })).toEqual({ kind: "emoji", text: "🦊" });
    expect(avatarFor({ name: "x", personaEmoji: "<a:party_parrot:123456789012345678>" }))
      .toEqual({ kind: "emoji", src: "/ui/img/emoji/123456789012345678", alt: ":party_parrot:" });
  });
  it("3. then the first character of the display name, or of the name; a value that is not one emoji falls through", () => {
    expect(avatarFor({ name: "web-dev", displayName: "Kiro Reviewer", personaEmoji: "ok" })).toEqual({ kind: "initial", text: "K" });
    expect(avatarFor({ name: "web-dev", displayName: "", personaEmoji: "👀✅" })).toEqual({ kind: "initial", text: "W" });
  });
  it("the first character is a grapheme: a family emoji, an accented letter, a CJK character, leading spaces", () => {
    expect(["👨‍👩‍👧 team", "élan", "中文", "  x", "🇹🇼 tw", ""].map(firstCharacter)).toEqual(["👨‍👩‍👧", "É", "中", "X", "🇹🇼", "?"]);
  });
  it("an own bot: answering for exactly one instance or room — a shared primary is nobody's own", () => {
    const own = ownBotConnections([
      ["a", "discord"], ["b", "discord"],            // the shared fleet bot
      ["solo", "discord-2"],                          // its own
      ["p1", "telegram-2"], ["p2", "telegram-2"],     // a bot two instances share
      ["room", "discord-3"],                          // a ClassicBot room's own bot
      ["primary-only", "discord"], ["unbound", undefined],
    ]);
    expect([...own.entries()]).toEqual([["solo", "discord-2"], ["room", "discord-3"]]);
    // #1630 follow-up: a primary kept for General alone is General's own bot.
    expect([...ownBotConnections([["general", "discord"], ["solo", "discord-2"]]).entries()]).toEqual([["general", "discord"], ["solo", "discord-2"]]);
  });
  it("a role colour: #rrggbb, never black (Discord's 'no colour'), nothing else", () => {
    expect(["#E91E63", "#000000", "red", "#fff", "#12345g", null, "#1abc9c"].map(accentColor)).toEqual(["#e91e63", null, null, null, null, null, "#1abc9c"]);
  });
});
