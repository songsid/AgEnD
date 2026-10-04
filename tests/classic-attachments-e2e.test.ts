import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import type { Attachment, ChannelAdapter } from "../src/channel/types.js";

/**
 * A ClassicBot channel receiving files, driven through the real `handleClassicChannelMessage` →
 * `saveClassicAttachment` → `processAttachments` → `forwardToClassicInstance` chain with only the platform
 * and the agent's delivery faked. No fleet, tmux or process is started: `deliverToInstance` is the seam where
 * "what the agent is handed" is read off, and the adapter is a recorder whose downloads write real files.
 *
 * What this pins is the contract the agent depends on: the file ends up in the instance's workspace inbox
 * (not in the adapter's scratch download), the text carries the tag, the meta names the path, and a file
 * saved by an untriggered message is still found by the next triggered one.
 */

const INSTANCE = "classic-room";
let home: string;
let scratch: string;
let fm: FleetManager;
let adapter: ReturnType<typeof fakeAdapter>;
let delivered: Array<{ content: string; meta: Record<string, string> }>;

function fakeAdapter(failing: string[] = []) {
  const events = new EventEmitter();
  const downloads: string[] = [];
  return Object.assign(events, {
    id: "tg", type: "telegram", topology: "topics",
    downloads,
    react: vi.fn(async () => {}),
    sendText: vi.fn(async () => ({ messageId: "x" })),
    downloadAttachment: vi.fn(async (fileId: string) => {
      downloads.push(fileId);
      if (failing.includes(fileId)) throw new Error(`no ${fileId}`);
      const path = join(scratch, `${Date.now()}-${fileId}`);
      writeFileSync(path, `content of ${fileId}`);
      return path;
    }),
  });
}

const inboxOf = () => join(home, "workspaces", INSTANCE, "inbox");

function setup(opts: { collab?: boolean; failing?: string[]; botUserId?: string } = {}) {
  adapter = fakeAdapter(opts.failing);
  fm = new FleetManager(home);
  const state = fm as any;
  state.adapter = adapter as unknown as ChannelAdapter;
  state.botUserId = opts.botUserId;
  state.classicChannels = {
    isCollab: () => !!opts.collab,
    getAdapterIdByInstance: () => "tg",
    getChannelIdByInstance: () => "room-1",
    getContextLines: () => 5,
  };
  delivered = [];
  state.deliverToInstance = vi.fn(async (_name: string, payload: { content: string; meta: Record<string, string> }) => {
    delivered.push({ content: payload.content, meta: payload.meta });
  });
  state.trackInboundMsg = vi.fn();
  state.sendCancelButton = vi.fn(async () => {});
  return fm;
}

const message = (text: string, attachments?: Attachment[], over: Record<string, unknown> = {}) => ({
  source: "telegram", adapterId: "tg", chatId: "room-1", messageId: "m-1", userId: "u-1", username: "alice",
  text, timestamp: new Date(), ...(attachments ? { attachments } : {}), ...over,
});
const handle = (msg: ReturnType<typeof message>) => (fm as any).handleClassicChannelMessage(INSTANCE, msg) as Promise<void>;
const chatLog = () => {
  const dir = join(home, "workspaces", INSTANCE, "chat-logs");
  return existsSync(dir) ? readdirSync(dir).map(f => readFileSync(join(dir, f), "utf8")).join("") : "";
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "classic-att-"));
  scratch = join(home, "scratch");
  mkdirSync(scratch, { recursive: true });
  vi.stubEnv("AGEND_HOME", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("normal ClassicBot channel (/chat triggers the agent)", () => {
  it("/chat with a photo: the photo is moved into the workspace inbox and handed over as image_path", async () => {
    setup();
    await handle(message("/chat what is this", [{ kind: "photo", fileId: "ph1" }]));

    const [file] = readdirSync(inboxOf());
    expect(file).toMatch(/-ph1$/);
    const dest = join(inboxOf(), file);
    expect(readFileSync(dest, "utf8")).toBe("content of ph1");
    expect(readdirSync(scratch), "the scratch download is cleaned up").toEqual([]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].content).toBe(`[📷 Image: ${dest}]\nwhat is this`);
    expect(delivered[0].meta).toMatchObject({ image_path: dest, chat_id: "room-1", user: "alice", source: "telegram", adapter_id: "tg" });
    expect(adapter.downloads, "downloaded once, not again by processAttachments").toEqual(["ph1"]);
  });

  it("/chat with two photos: every path, in the order sent, each with its tag", async () => {
    setup();
    await handle(message("/chat many", [{ kind: "photo", fileId: "a" }, { kind: "photo", fileId: "b" }]));
    const byId = (id: string) => join(inboxOf(), readdirSync(inboxOf()).find(f => f.endsWith(`-${id}`))!);
    const [a, b] = [byId("a"), byId("b")];
    expect(delivered[0].meta.image_path).toBe(a);
    expect(delivered[0].meta.image_paths).toBe(`${a},${b}`);
    expect(delivered[0].content).toBe(`[📷 Image: ${a}]\n[📷 Image: ${b}]\nmany`);
    expect(readFileSync(b, "utf8")).toBe("content of b");
  });

  it("/chat with a document: tagged with its file name, attachment_path set, no image_path", async () => {
    setup();
    await handle(message("/chat read this", [{ kind: "document", fileId: "doc1", filename: "report.pdf" }]));
    const [file] = readdirSync(inboxOf());
    const dest = join(inboxOf(), file);
    expect(delivered[0].content).toBe(`[📎 File: report.pdf → ${dest}]\nread this`);
    expect(delivered[0].meta.attachment_path).toBe(dest);
    expect(delivered[0].meta.image_path).toBeUndefined();
  });

  it("a photo WITHOUT /chat is saved and logged but does not wake the agent", async () => {
    setup();
    await handle(message("look at this", [{ kind: "photo", fileId: "quiet" }]));
    const [file] = readdirSync(inboxOf());
    expect(delivered).toEqual([]);
    expect(chatLog()).toContain(`<alice> look at this [📷 saved: ${join(inboxOf(), file)}]`);
    expect(adapter.react).toHaveBeenCalledTimes(1);
  });

  it("the photo saved earlier is still found by the next /chat that carries none", async () => {
    setup();
    await handle(message("look at this", [{ kind: "photo", fileId: "earlier" }]));
    const [file] = readdirSync(inboxOf());
    await handle(message("/chat what did I just send?", undefined, { messageId: "m-2" }));
    expect(delivered).toHaveLength(1);
    expect(delivered[0].meta.image_path).toBe(join(inboxOf(), file));
    expect(delivered[0].content).toContain("[User message]\nwhat did I just send?");
    expect(delivered[0].content).toContain(`[📷 saved: ${join(inboxOf(), file)}]`);
  });

  it("a download that fails: the text still reaches the agent and no path is invented", async () => {
    setup({ failing: ["bad"] });
    await handle(message("/chat try", [{ kind: "photo", fileId: "bad" }]));
    expect(delivered).toHaveLength(1);
    expect(delivered[0].content).toBe("try");
    expect(delivered[0].meta.image_path).toBeUndefined();
    expect(existsSync(inboxOf()) ? readdirSync(inboxOf()) : []).toEqual([]);
  });

  it("/chat /raw … is dropped even with an attachment (the raw gate is not a way in)", async () => {
    setup();
    await handle(message("/chat /raw rm -rf x", [{ kind: "photo", fileId: "ph" }]));
    expect(delivered).toEqual([]);
  });

  it("a voice note is not saved to the inbox; with no Groq key it reaches the agent as an audio file", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    setup();
    await handle(message("/chat listen", [{ kind: "voice", fileId: "vo1" }]));
    expect(existsSync(inboxOf())).toBe(false);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].content).toMatch(/^\[🎵 Audio: audio → .*vo1\]\nlisten$/);
    expect(delivered[0].meta.attachment_file_id).toBe("vo1");
  });
});

describe("collab ClassicBot channel (an @mention triggers the agent)", () => {
  const BOT = "4242";

  it("an @mention with a photo: forwarded with the self marker and the inbox path", async () => {
    setup({ collab: true, botUserId: BOT });
    await handle(message(`<@${BOT}> check this`, [{ kind: "photo", fileId: "c1" }]));
    const [file] = readdirSync(inboxOf());
    const dest = join(inboxOf(), file);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].content).toBe(`[📷 Image: ${dest}]\n<@${BOT}> (you) check this`);
    expect(delivered[0].meta.image_path).toBe(dest);
  });

  it("a photo without the mention is saved, logged with its path and NOT forwarded", async () => {
    setup({ collab: true, botUserId: BOT });
    await handle(message("just sharing", [{ kind: "photo", fileId: "c2" }]));
    const [file] = readdirSync(inboxOf());
    expect(delivered).toEqual([]);
    expect(chatLog()).toContain(`<alice> just sharing [📷 saved: ${join(inboxOf(), file)}]`);
  });

  it("someone else's @mention is not ours: nothing is forwarded", async () => {
    setup({ collab: true, botUserId: BOT });
    await handle(message("<@999> look", [{ kind: "photo", fileId: "c3" }]));
    expect(delivered).toEqual([]);
  });

  it("@mention + /raw is blocked", async () => {
    setup({ collab: true, botUserId: BOT });
    await handle(message(`<@${BOT}> /raw boom`));
    expect(delivered).toEqual([]);
  });
});
