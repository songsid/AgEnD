/**
 * #2959 (reported by hxhsandy): two bots on one host downloading the same attachment in the same millisecond got the
 * same temp file in the shared inbox. A ClassicBot copies that file into its workspace and then unlinks it, so the
 * second bot found it gone, logged "Attachment copy failed — skipping" and dropped the picture (21 of 127 multi-bot
 * pictures in the field). Each download now has its own name: `<ms>-<8 random hex>-<id tail>-<name>`.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramMock, type TelegramMock } from "../e2e/mock-servers/telegram-mock.js";
import { getFreePort } from "../e2e/mock-servers/shared.js";
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } }) }));
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { inboxTempName } from "../src/channel/inbox-temp-name.js";

const NOW = 1_793_669_079_648;
let dir: string, inbox: string;
const stops: Array<() => Promise<unknown>> = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "inb2959-")); inbox = join(dir, "inbox"); mkdirSync(inbox, { recursive: true }); });
afterEach(async () => { vi.restoreAllMocks(); for (const s of stops.splice(0)) await s().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });

const access = () => new AccessManager({ mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 10 }, join(dir, `access-${Math.random()}.json`));

/** A ClassicBot's save (fleet-manager saveClassicAttachment): copy the temp file into its workspace, then unlink it. */
function classicSave(tmpPath: string, workspace: string): string | null {
  mkdirSync(workspace, { recursive: true });
  const dest = join(workspace, basename(tmpPath));
  try { copyFileSync(tmpPath, dest); } catch { return null; }   // "Attachment copy failed — skipping"
  try { unlinkSync(tmpPath); } catch { /* non-fatal */ }
  return dest;
}

describe("#2959 the temp name", () => {
  it("is <ms>-<8 random hex>-<id tail>-<name>, and differs between two calls in the same millisecond", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const a = inboxTempName("AgACAgQAAxkBAAIB", "file_7.jpg"), b = inboxTempName("AgACAgQAAxkBAAIB", "file_7.jpg");
    expect(a).toMatch(new RegExp(`^${NOW}-[0-9a-f]{8}-AxkBAAIB-file_7\\.jpg$`));
    expect(a).not.toBe(b);
  });
});

describe("#2959 two bots, the same attachment, the same millisecond — both pictures land", () => {
  it("Telegram: two adapters sharing the inbox download it concurrently; each ClassicBot's copy-then-unlink keeps its own", async () => {
    const mock: TelegramMock = createTelegramMock({ port: await getFreePort() });
    await mock.start(); stops.push(() => mock.stop());
    const body = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6]);
    mock.registerFile({ fileId: "AgACAgQAAxkBAAIB", filePath: "photos/file_7.jpg", body, contentType: "image/jpeg" });
    const bot = (id: string) => new TelegramAdapter({ id, botToken: `12345${id.length}:FAKE_TOKEN`, accessManager: access(), inboxDir: inbox, apiRoot: `http://localhost:${mock.port}` });
    const a = bot("a"), b = bot("bb");
    vi.spyOn(Date, "now").mockReturnValue(NOW);                    // the same millisecond
    const [pa, pb] = await Promise.all([a.downloadAttachment("AgACAgQAAxkBAAIB"), b.downloadAttachment("AgACAgQAAxkBAAIB")]);
    expect(pa).not.toBe(pb);
    // The field order: bot A saves (copy, unlink) before bot B copies.
    const da = classicSave(pa, join(dir, "ws-a")), db = classicSave(pb, join(dir, "ws-b"));
    expect([da !== null, db !== null], "both saved").toEqual([true, true]);
    expect([...readFileSync(da!)]).toEqual([...body]);
    expect([...readFileSync(db!)]).toEqual([...body]);
    expect([existsSync(pa), existsSync(pb)], "both temp files cleaned").toEqual([false, false]);
  });

  it("Discord: the same, through the adapters' own download", async () => {
    const url = "https://cdn.discordapp.com/attachments/1/2/image.png?ex=1";
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(body, { status: 200 }));
    const bot = (id: string) => {
      const ad = new DiscordAdapter({ id, botToken: "FAKE-TOKEN-FOR-TEST", accessManager: access(), inboxDir: inbox, guildId: "guild-1", registerCommands: false });
      stops.push(() => ad.stop());
      (ad as any).attachmentUrls.set("1300000000000000042", url);
      return ad;
    };
    const a = bot("discord-a"), b = bot("discord-b");
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const [pa, pb] = await Promise.all([a.downloadAttachment("1300000000000000042"), b.downloadAttachment("1300000000000000042")]);
    expect(pa).not.toBe(pb);
    expect(basename(pa)).toMatch(new RegExp(`^${NOW}-[0-9a-f]{8}-00000042-image\\.png$`));
    const da = classicSave(pa, join(dir, "ws-a")), db = classicSave(pb, join(dir, "ws-b"));
    expect([da !== null, db !== null]).toEqual([true, true]);
    expect([...readFileSync(db!)]).toEqual([...body]);
  });
});
