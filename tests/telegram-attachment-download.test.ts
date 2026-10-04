import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTelegramMock, type TelegramMock } from "../e2e/mock-servers/telegram-mock.js";
import { getFreePort, waitFor } from "../e2e/mock-servers/shared.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { processAttachments } from "../src/channel/attachment-handler.js";
import type { InboundMessage } from "../src/channel/types.js";

/**
 * The Telegram attachment path end to end with no token: a real TelegramAdapter against the local mock Bot
 * API. A photo or document sent to the bot arrives as an `InboundMessage` with attachments; the agent's
 * file lives in the inbox only if `downloadAttachment` really fetched it from `/file/bot<token>/<path>`.
 * Nothing in the suite covered this, so a broken download URL, a file written outside the inbox, or a
 * failed download that still produced an `image_path` could all have shipped.
 */

const GROUP = -1001234567890;
const USER = 111222333;
let mock: TelegramMock;
let dir: string;
let inbox: string;
let adapter: TelegramAdapter | undefined;

function newAdapter(): TelegramAdapter {
  const access = new AccessManager({ mode: "locked", allowed_users: [USER], max_pending_codes: 5, code_expiry_minutes: 10 }, join(dir, "access.json"));
  adapter = new TelegramAdapter({ id: "t", botToken: "123456:FAKE_TOKEN", accessManager: access, inboxDir: inbox, apiRoot: `http://localhost:${mock.port}` });
  return adapter;
}

async function start(a: TelegramAdapter): Promise<InboundMessage[]> {
  const got: InboundMessage[] = [];
  a.on("message", (m: InboundMessage) => got.push(m));
  await a.start();
  await waitFor(() => mock.getCallsFor("getUpdates").length > 0, { timeout: 5000, interval: 20, label: "first poll" });
  return got;
}

beforeEach(async () => {
  // Short path: keeps the adapter's socket paths well under the unix limit.
  dir = mkdtempSync(join(tmpdir(), "tgatt-"));
  inbox = join(dir, "inbox");
  mkdirSync(inbox, { recursive: true });
  mock = createTelegramMock({ port: await getFreePort() });
  await mock.start();
});
afterEach(async () => {
  await adapter?.stop().catch(() => {});
  adapter = undefined;
  await mock.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("TelegramAdapter.downloadAttachment against the mock Bot API", () => {
  it("fetches the file Telegram names and writes it into the inbox, whole", async () => {
    mock.registerFile({ fileId: "AgACAgQAAxkBAAIB", filePath: "photos/file_7.jpg", body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), contentType: "image/jpeg" });
    const path = await newAdapter().downloadAttachment("AgACAgQAAxkBAAIB");
    expect(dirname(path)).toBe(inbox);
    expect(basename(path)).toMatch(/^\d+-AxkBAAIB-file_7\.jpg$/);
    expect([...readFileSync(path)]).toEqual([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    expect(mock.getFileDownloads()).toEqual(["photos/file_7.jpg"]);
    expect(mock.getCallsFor("getFile")[0].params.file_id).toBe("AgACAgQAAxkBAAIB");
  });

  it("a nested file_path names the local file by its last segment only: nothing is created below the inbox", async () => {
    mock.registerFile({ fileId: "nest0001", filePath: "documents/2026/10/deep/x.txt", body: "payload" });
    const path = await newAdapter().downloadAttachment("nest0001");
    expect(dirname(path)).toBe(inbox);
    expect(basename(path)).toMatch(/^\d+-nest0001-x\.txt$/);
    expect(readdirSync(inbox)).toEqual([basename(path)]);
    expect(readdirSync(dir).sort()).toEqual(["inbox"]);
  });

  it("rejects when Telegram returns no file_path (a file too large to download)", async () => {
    mock.registerFile({ fileId: "big00001", body: "x" });
    await expect(newAdapter().downloadAttachment("big00001")).rejects.toThrow(/No file_path returned for fileId: big00001/);
    expect(readdirSync(inbox)).toEqual([]);
  });

  it("rejects on an HTTP error from the file endpoint and leaves nothing a caller could mistake for the file", async () => {
    mock.registerFile({ fileId: "gone0001", filePath: "documents/file_9.pdf", status: 404 });
    await expect(newAdapter().downloadAttachment("gone0001")).rejects.toThrow(/Failed to download file: 404/);
    expect(readdirSync(inbox)).toEqual([]);
  });
});

describe("a photo or document sent to the bot reaches the agent as a file path", () => {
  it("photo: the largest size is downloaded and tagged as an image", async () => {
    mock.registerFile({ fileId: "small001", filePath: "photos/small.jpg", body: "tiny" });
    mock.registerFile({ fileId: "large001", filePath: "photos/large.jpg", body: "the-large-photo" });
    const a = newAdapter();
    const got = await start(a);

    mock.injectMessage({ text: "what is this?", chatId: GROUP, userId: USER, threadId: 5, photo: [{ fileId: "small001" }, { fileId: "large001", size: 15 }] });
    await waitFor(() => got.length > 0, { timeout: 10_000, interval: 20, label: "inbound photo" });

    expect(got[0].text).toBe("what is this?");
    expect(got[0].attachments).toEqual([{ kind: "photo", fileId: "large001", size: 15 }]);
    const out = await processAttachments(got[0], a, { info() {}, warn() {} });
    const path = out.extraMeta.image_path;
    expect(dirname(path)).toBe(inbox);
    expect(readFileSync(path, "utf8")).toBe("the-large-photo");
    expect(out.text).toBe(`[📷 Image: ${path}]\nwhat is this?`);
    expect(mock.getFileDownloads()).toEqual(["photos/large.jpg"]);
  });

  it("document: keeps the name it was sent with and is tagged as a file", async () => {
    mock.registerFile({ fileId: "doc00001", filePath: "documents/file_3.pdf", body: "%PDF-1.4 hello", contentType: "application/pdf" });
    const a = newAdapter();
    const got = await start(a);

    mock.injectMessage({ text: "", chatId: GROUP, userId: USER, document: { fileId: "doc00001", fileName: "report.pdf", mimeType: "application/pdf", size: 14 } });
    await waitFor(() => got.length > 0, { timeout: 10_000, interval: 20, label: "inbound document" });

    expect(got[0].attachments).toEqual([{ kind: "document", fileId: "doc00001", mime: "application/pdf", size: 14, filename: "report.pdf" }]);
    const out = await processAttachments(got[0], a, { info() {}, warn() {} });
    const path = out.extraMeta.attachment_path;
    expect(dirname(path)).toBe(inbox);
    expect(readFileSync(path, "utf8")).toBe("%PDF-1.4 hello");
    expect(out.text).toBe(`[📎 File: report.pdf → ${path}]\n`);
  });

  it("a download the platform refuses leaves the message text intact and names no file", async () => {
    mock.registerFile({ fileId: "gone0002", filePath: "photos/gone.jpg", status: 500 });
    const a = newAdapter();
    const got = await start(a);
    mock.injectMessage({ text: "still here", chatId: GROUP, userId: USER, photo: [{ fileId: "gone0002" }] });
    await waitFor(() => got.length > 0, { timeout: 10_000, interval: 20, label: "inbound photo" });

    const warnings: string[] = [];
    const out = await processAttachments(got[0], a, { info() {}, warn: (o: unknown) => warnings.push((o as { err: string }).err) });
    expect(out).toEqual({ text: "still here", extraMeta: {} });
    expect(warnings).toEqual(["Failed to download file: 500 Internal Server Error"]);
  });
});
