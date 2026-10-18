/**
 * The user's tofu boxes: a Discord server emoji whose picture the host cannot fetch reads `:name:` in web chat; why it
 * failed is logged once per emoji at warn (it was debug only, so nobody could see it), never once per render.
 * FleetManager.webEmoji over the real WebImageCache, with the network stubbed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-emoji-log-")); dirs.push(dir);
  const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
  const fm: any = Object.assign(Object.create(FleetManager.prototype), { dataDir: dir, logger, webImageCaches: null, webEmojiFailures: new Set() });
  fm.webEmojiList = async () => [{ id: "111111111111111111", name: "party", animated: true }, { id: "222222222222222222", name: "pop", animated: false }];
  return { fm, logger };
}

describe("a server emoji picture that cannot be fetched", () => {
  it("answers nothing (the page shows :name:), and says why once per emoji at warn — again only at debug", async () => {
    const { fm, logger } = fleet();
    const fetches: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { fetches.push(url); return new Response("", { status: 403 }); }));
    expect(await fm.webEmoji("111111111111111111")).toBeNull();
    expect(await fm.webEmoji("222222222222222222")).toBeNull();
    expect(fetches).toEqual(["https://cdn.discordapp.com/emojis/111111111111111111.gif?size=64", "https://cdn.discordapp.com/emojis/222222222222222222.png?size=64"]);
    expect(logger.warn.mock.calls.map((c: any[]) => [c[0].key, c[0].err])).toEqual([["emoji:111111111111111111", "HTTP 403"], ["emoji:222222222222222222", "HTTP 403"]]);
    expect(await fm.webEmoji("111111111111111111"), "quiet for an hour: no new fetch, no new line").toBeNull();
    expect([fetches.length, logger.warn.mock.calls.length]).toEqual([2, 2]);
    // The same emoji failing again later (its quiet hour over): debug only.
    fm.webImageCache("emoji").opts.onError("emoji:111111111111111111", new Error("HTTP 403"));
    expect(logger.warn.mock.calls.length).toBe(1 + 1);
    expect(logger.debug).toHaveBeenCalledWith(expect.objectContaining({ key: "emoji:111111111111111111" }), expect.any(String));
  });
});
