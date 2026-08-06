import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { AccessManager } from "../src/channel/access-manager.js";

/**
 * Discord "Forward" re-materializes the original message as a messageSnapshot:
 * its images arrive as snapshot attachments — or as embeds of type "image",
 * which the adapter used to ignore entirely. Worse, the whole snapshot block
 * was gated on the outer message having NO content, so forwarding with a
 * comment silently dropped the forwarded text AND its images. The agent then
 * answered "I can't see any image — there is no image_path".
 */

/** Minimal stand-in for discord.js Collection (Map + .map). */
class FakeCollection<V> extends Map<string, V> {
  map<R>(fn: (v: V) => R): R[] {
    return [...this.values()].map(fn);
  }
}

function fakeAttachment(id: string, url: string, contentType = "image/png") {
  return { id, url, contentType, size: 123, name: url.split("/").pop() };
}

function fakeMessage(overrides: Record<string, unknown> = {}) {
  return {
    author: { id: "user-1", bot: false, username: "hanhanv" },
    guildId: "guild-1",
    channelId: "topic-1",
    id: "message-1",
    content: "",
    attachments: new FakeCollection<any>(),
    embeds: [] as any[],
    reference: undefined,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("Discord forwarded message images", () => {
  let dir: string;
  let adapter: DiscordAdapter;
  let client: any;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agend-discord-fwd-"));
    const access = new AccessManager({
      mode: "open",
      allowed_users: [],
      max_pending_codes: 0,
      code_expiry_minutes: 10,
    }, join(dir, "access.json"));
    adapter = new DiscordAdapter({
      id: "discord",
      botToken: "FAKE-TOKEN-FOR-TEST",
      accessManager: access,
      inboxDir: dir,
      guildId: "guild-1",
      registerCommands: false,
    });
    client = (adapter as any).client;
    Object.defineProperty(client, "user", { value: { id: "self-bot" }, configurable: true });
  });

  afterEach(async () => {
    await adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function inbound(msg: unknown): Promise<any> {
    const seen = new Promise(resolve => adapter.once("message", resolve));
    client.emit("messageCreate", msg);
    return seen;
  }

  it("delivers a forwarded snapshot attachment image even when the forwarder added a comment", async () => {
    // The regression case: content non-empty used to skip snapshot handling.
    const snapshots = new FakeCollection<any>();
    snapshots.set("snap-1", {
      message: {
        content: "original text",
        embeds: [],
        attachments: new FakeCollection<any>().set("att-9", fakeAttachment("att-9", "https://cdn.example/photo.png")),
      },
    });
    const msg = fakeMessage({ content: "look at this", messageSnapshots: snapshots });

    const got = await inbound(msg);

    expect(got.attachments).toEqual([expect.objectContaining({ kind: "photo", fileId: "att-9" })]);
    expect(got.text).toContain("look at this");
    expect(got.text).toContain("[Forwarded]");
    expect(got.text).toContain("original text");
  });

  it("turns a forwarded image EMBED into a downloadable photo attachment", async () => {
    const snapshots = new FakeCollection<any>();
    snapshots.set("snap-1", {
      message: {
        content: "",
        embeds: [{ data: { type: "image" }, url: "https://cdn.example/pic.jpg", thumbnail: { url: "https://proxy.example/pic-thumb.jpg" } }],
        attachments: new FakeCollection<any>(),
      },
    });
    const msg = fakeMessage({ messageSnapshots: snapshots });

    const got = await inbound(msg);

    expect(got.attachments).toHaveLength(1);
    const photo = got.attachments[0];
    expect(photo).toMatchObject({ kind: "photo", fileId: "embed-img-message-1-0", mime: "image/jpeg" });
    // The synthetic id must resolve through the same URL table the real
    // download path uses — that is what makes image_path work downstream.
    expect((adapter as any).attachmentUrls.get("embed-img-message-1-0")).toBe("https://cdn.example/pic.jpg");
  });

  it("collects multiple image embeds as multiple photos, deduplicated by URL", async () => {
    const msg = fakeMessage({
      content: "three embeds, two distinct",
      embeds: [
        { data: { type: "image" }, url: "https://cdn.example/a.png" },
        { data: { type: "image" }, url: "https://cdn.example/b.webp" },
        { data: { type: "image" }, url: "https://cdn.example/a.png" }, // duplicate
      ],
    });

    const got = await inbound(msg);

    expect(got.attachments).toHaveLength(2);
    expect(got.attachments.map((a: any) => a.fileId)).toEqual([
      "embed-img-message-1-0",
      "embed-img-message-1-1",
    ]);
    expect(got.attachments.map((a: any) => a.mime)).toEqual(["image/png", "image/webp"]);
  });

  it("ignores link-preview / video / gifv embeds — they are not images", async () => {
    const msg = fakeMessage({
      content: "https://example.com/article",
      embeds: [
        { data: { type: "link" }, url: "https://example.com/article", thumbnail: { url: "https://example.com/og.png" } },
        { data: { type: "rich" }, title: "Card", image: { url: "https://example.com/card.png" } },
        { data: { type: "video" }, url: "https://example.com/clip.mp4", thumbnail: { url: "https://example.com/poster.jpg" } },
        { data: { type: "gifv" }, url: "https://tenor.example/funny.gif" },
      ],
    });

    const got = await inbound(msg);

    expect(got.attachments).toBeUndefined();
  });

  it("keeps a plain attachment message exactly as before", async () => {
    const msg = fakeMessage({ content: "here" });
    msg.attachments.set("att-1", fakeAttachment("att-1", "https://cdn.example/direct.png"));

    const got = await inbound(msg);

    expect(got.attachments).toEqual([expect.objectContaining({ kind: "photo", fileId: "att-1" })]);
    expect(got.text).toBe("here");
    expect(got.text).not.toContain("[Forwarded]");
  });

  it("a bare forward still reads as the forwarded text itself (no label)", async () => {
    const snapshots = new FakeCollection<any>();
    snapshots.set("snap-1", {
      message: { content: "forwarded words", embeds: [], attachments: new FakeCollection<any>() },
    });
    const msg = fakeMessage({ messageSnapshots: snapshots });

    const got = await inbound(msg);

    expect(got.text).toBe("forwarded words");
  });
});
