/**
 * #2551 (a regression from #2456's native replies): in a ClassicBot room in collab mode, a bot's native reply to one of
 * THIS bot's messages is addressed to it, as an @mention is — a Discord reply carries its ping in the reference, not in
 * the text. One hop only: a reply to a message of ours that itself answered a bot is a chain (two agents answering each
 * other by native replies) and is logged, not delivered; an @mention still carries a conversation on. A reply to our
 * answer to a person is the ordinary handoff, and is delivered (Fable r1).
 * Fleet topics need nothing: their gate takes another fleet's bot whenever collab or open is on (no mention needed).
 * Telegram: bots never receive each other's messages there, so the same question never arises.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } }) }));
import { FleetManager } from "../src/fleet-manager.js";
import { AdapterWorld } from "../src/adapter-world.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import type { ChannelAdapter } from "../src/channel/types.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
const OPEN = { mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 0 };

function room() {
  const dir = mkdtempSync(join(tmpdir(), "agend-2551-")); dirs.push(dir);
  const fleetPath = join(dir, "fleet.yaml");
  writeFileSync(fleetPath, ["channels:", "  - { id: dc, type: discord, mode: topic, bot_token_env: FAKE_DC, group_id: guild-1, access: { mode: open } }",
    "defaults:", "  backend: claude-code", "instances: {}", ""].join("\n"));
  const fm = new FleetManager(dir) as any;
  fm.loadConfig(fleetPath);
  const adapter = { id: "dc", type: "discord", react: vi.fn(async () => {}), unreact: vi.fn(async () => {}) } as unknown as ChannelAdapter;
  const world = new AdapterWorld("dc", adapter, new AccessManager(OPEN as any, join(dir, "a.json")), fm.fleetConfig.channels[0]);
  world.botUserId = "BOT";
  fm.worlds.set("dc", world);
  fm.classicChannels = { isCollab: () => true, getInstanceByChannel: () => "classic-room" };
  vi.spyOn(ClassicChannelManager, "logMessage").mockImplementation(() => {});
  const forward = vi.fn(async () => {});
  fm.forwardToClassicInstance = forward;
  /** Another fleet's bot posts in the room: `reply` as the adapter reads a native reply. */
  const post = (text: string, reply?: { authorId: string; chain?: boolean }) => fm.handleClassicChannelMessage("classic-room", {
    source: "discord", adapterId: "dc", chatId: "guild-1", threadId: "555", messageId: `m-${Math.random()}`, userId: "OTHER-BOT", username: "bot-a",
    text, timestamp: new Date(), isBotMessage: true,
    ...(reply ? { replyTo: "r-1", replyToAuthorId: reply.authorId, ...(reply.chain ? { replyToChain: true } : {}) } : {}),
  });
  return { forward, post };
}

describe("#2551: a native reply to our bot's message is addressed to it (ClassicBot collab)", () => {
  it("bot A's native reply to bot B's message reaches B, with no <@B> in the text", async () => {
    const r = room();
    await r.post("here is the file you asked for", { authorId: "BOT" });
    expect(r.forward).toHaveBeenCalledTimes(1);
  });
  it("a reply to someone else's message is not addressed to B; neither is a plain message (the control)", async () => {
    const r = room();
    await r.post("thanks", { authorId: "SOMEONE-ELSE" });
    await r.post("just talking");
    expect(r.forward).not.toHaveBeenCalled();
  });
  it("A replies to B's answer to a person (B's message itself a reply, to a human): delivered — the ordinary handoff", async () => {
    const r = room();
    await r.post("I can take that over", { authorId: "BOT" });                     // the adapter found no bot above it
    expect(r.forward).toHaveBeenCalledTimes(1);
  });
  it("loop guard: a reply to a message of ours that itself answered a bot is a chain — not delivered; an @mention still is", async () => {
    const r = room();
    await r.post("and back to you", { authorId: "BOT", chain: true });
    expect(r.forward).not.toHaveBeenCalled();
    await r.post("<@BOT> and back to you", { authorId: "BOT", chain: true });
    expect(r.forward).toHaveBeenCalledTimes(1);
  });
});
