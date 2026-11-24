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
