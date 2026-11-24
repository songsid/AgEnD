/**
 * M-3533 R2b: the Fleet's pictures for an agent are what its own pages show (fleet-manager.ts hubPictureSources): the disc is
 * the sidebar's — its theme avatar while the owner shows agents' themes, else its bot's avatar, else a Discord custom persona
 * emoji (a Unicode one is no picture) — and the portrait is the identity card's. Each source is keyed by a version, so a
 * changed picture is a changed key.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fleet(delivered: string) {
  const root = mkdtempSync(join(tmpdir(), "agend-pictures-")); roots.push(root);
  const fm = new FleetManager(root) as any;
  fm.fleetConfig = { defaults: {}, instances: { docs: { working_directory: join(root, "docs"), backend: "claude-code", status_emojis: { delivered } } } };
  const theme: any = { v: 1 }, assets = new Map<string, Buffer>(), shown = { value: true };
  vi.spyOn(fm.themeStore, "get").mockImplementation(() => ({ theme, locked: false, placements: {} }));
  vi.spyOn(fm.themeStore, "asset").mockImplementation((...a: unknown[]) => { const b = assets.get(a[1] as string); return b ? { bytes: b, mime: "image/png" } : null; });
  vi.spyOn(fm.webPrefs, "read").mockImplementation(() => ({ values: shown.value ? {} : { "fx.show": false } }));
  const bot = { own: new Map<string, string>(), version: "v1", bytes: Buffer.from("bot") };
  vi.spyOn(fm, "webBots").mockImplementation(() => ({ own: bot.own, speaking: new Map() }));
  vi.spyOn(fm, "botOwner").mockImplementation(() => ({ adapter: { fetchBotAvatar: async () => null }, id: "adapter-1" }));
  const emoji = new Map<string, { bytes: Buffer; version: string }>();
  vi.spyOn(fm, "webImageCache").mockImplementation((...a: unknown[]) => a[0] === "avatars"
    ? { peek: () => (bot.own.size ? { version: bot.version } : null), read: () => (bot.own.size ? { bytes: bot.bytes, mime: "image/png", version: bot.version } : null) }
    : { read: (key: string) => { const e = emoji.get(key); return e ? { ...e, mime: "image/png" } : null; } });
  return { fm, theme, assets, shown, bot, emoji, sources: () => fm.hubPictureSources("docs") };
}

it("the disc: the theme avatar while themes are shown, else the bot's avatar, else a custom emoji; a Unicode emoji is none", () => {
  const f = fleet("<:fox:123456789012345678>");
  f.theme.avatar = "a".repeat(32); f.assets.set("a".repeat(32), Buffer.from("theme"));
  f.bot.own.set("docs", "conn-1");
  f.emoji.set("emoji:123456789012345678", { bytes: Buffer.from("emoji"), version: "e1" });
  let s = f.sources();
  expect([s.disc.key, s.disc.load().bytes.toString()]).toEqual([`theme:${"a".repeat(32)}`, "theme"]);
  f.shown.value = false; s = f.sources();
  expect(s.disc.load().bytes.toString(), "themes hidden: the bot").toBe("bot");
  const botKey = s.disc.key; f.bot.version = "v2";
  expect(f.sources().disc.key, "a new bot picture is a new key").not.toBe(botKey);
  f.bot.own.clear(); s = f.sources();
  expect([s.disc.key, s.disc.load().bytes.toString()]).toEqual(["emoji:123456789012345678:e1", "emoji"]);
  f.emoji.clear();
  expect(f.sources().disc, "a custom emoji not fetched yet: none until it is").toBe(null);
  expect(fleet("📚").sources().disc).toBe(null);
});

it("the portrait: the agent's own identity-card picture, keyed by its id; none without one", () => {
  const f = fleet("📚");
  expect(f.sources().portrait).toBe(null);
  f.theme.card = { portrait: "c".repeat(32) }; f.assets.set("c".repeat(32), Buffer.from("portrait"));
  const s = f.sources();
  expect([s.portrait.key, s.portrait.load().bytes.toString()]).toEqual([`agent-card:${"c".repeat(32)}`, "portrait"]);
});

// M-3533 R2c: its own character is the set its owner's pack names for it, read from the Fleet's real office and pack stores.
it("R2c: the character is the set the owner's pack names for it in the first office holding it; keyed by the pack's version and the set", async () => {
  const { readFileSync } = await import("node:fs");
  const { cropInProcess } = await import("../src/hub-picture-reduce.js");
  const { decodePng } = await import("../src/web-png.js");
  const f = fleet("");
  const FIXTURE = join(process.cwd(), "tests", "fixtures", "office-skin-clinic");
  const manifest = { ...JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8")), byInstance: { docs: "fox" } };
  const files = { "office_bg.png": readFileSync(join(FIXTURE, "office_bg.png")).toString("base64"), "fox_idle.png": readFileSync(join(FIXTURE, "fox_idle.png")).toString("base64") };
  expect(f.fm.officeSkins.add({ manifest, files }, "admin")).toMatchObject({ ok: true });
  // No office holds it in that pack yet: no character (its All office is the built-in style).
  expect(f.sources().character).toBeNull();
  expect(f.fm.officeStore.replace([{ id: "front", name: "Front", skin: manifest.id, members: [] }], 0)).toMatchObject({ ok: true });
  const c = f.sources().character;
  expect(c.key).toMatch(new RegExp(`^${manifest.id}@[0-9a-f]+:fox$`));
  const loaded = c.load();
  // The clinic's fox has only idle: every room pose is drawn with it (filled inside the set).
  expect(Object.keys(loaded.plan.poses).sort()).toEqual(["idle", "paused", "stand", "working"]);
  expect([...loaded.pictures.keys()]).toEqual(["fox_idle.png"]);
  const cut = (await cropInProcess(loaded.pictures, Object.values(loaded.plan.poses).map((p: any) => p.cut)))!;
  const idle = decodePng(cut.get("idle")!, { maxSide: 512 });
  expect([idle.width, idle.height]).toEqual([4 * 32, 48]);
  // Another agent the pack does not name: none (the pack's default is nobody's own).
  expect(f.fm.hubPictureSources("other").character).toBeNull();
});
