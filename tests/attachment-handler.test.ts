import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processAttachments } from "../src/channel/attachment-handler.js";
import type { Attachment, ChannelAdapter, InboundMessage } from "../src/channel/types.js";

vi.mock("../src/stt.js", () => ({ transcribe: vi.fn() }));
import { transcribe } from "../src/stt.js";

/**
 * `processAttachments` is what turns a platform attachment into the line the agent actually reads
 * (`[📷 Image: <path>]`, `[📎 File: …]`) and the meta keys it triggers on (`image_path`,
 * `attachment_path`). It had no test: a wrong tag or a lost path produced an agent that silently never
 * saw the file. The expectations below are written out by hand, tag by tag.
 */

let dir: string;
const logger = { info: vi.fn(), warn: vi.fn() };

/** An adapter whose downloads write a real file named after the file id, or fail for ids listed in `failing`. */
function adapterWith(failing: string[] = []): { adapter: ChannelAdapter; downloads: string[] } {
  const downloads: string[] = [];
  const adapter = {
    downloadAttachment: async (fileId: string) => {
      downloads.push(fileId);
      if (failing.includes(fileId)) throw new Error(`boom ${fileId}`);
      const path = join(dir, `dl-${fileId}`);
      writeFileSync(path, `bytes of ${fileId}`);
      return path;
    },
  } as unknown as ChannelAdapter;
  return { adapter, downloads };
}

const message = (text: string, attachments?: Attachment[]): InboundMessage => ({
  source: "telegram", adapterId: "t", chatId: "c", messageId: "m", userId: "u", username: "alice",
  text, timestamp: new Date(0), ...(attachments ? { attachments } : {}),
});
const at = (id: string) => join(dir, `dl-${id}`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "att-handler-"));
  logger.info.mockReset();
  logger.warn.mockReset();
  vi.mocked(transcribe).mockReset();
  delete process.env.GROQ_API_KEY;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.GROQ_API_KEY;
});

describe("processAttachments", () => {
  it("leaves a message without attachments exactly as it was", async () => {
    const { adapter, downloads } = adapterWith();
    expect(await processAttachments(message("hello"), adapter, logger)).toEqual({ text: "hello", extraMeta: {} });
    expect(downloads).toEqual([]);
  });

  it("downloads a photo, tags it above the text and names it image_path", async () => {
    const { adapter } = adapterWith();
    const out = await processAttachments(message("look", [{ kind: "photo", fileId: "p1" }]), adapter, logger);
    expect(out.text).toBe(`[📷 Image: ${at("p1")}]\nlook`);
    expect(out.extraMeta).toEqual({ image_path: at("p1") });
  });

  it("several photos: one tag each, image_path is the first, image_paths lists all in order", async () => {
    const { adapter } = adapterWith();
    const out = await processAttachments(message("two", [{ kind: "photo", fileId: "p1" }, { kind: "photo", fileId: "p2" }]), adapter, logger);
    expect(out.text).toBe(`[📷 Image: ${at("p1")}]\n[📷 Image: ${at("p2")}]\ntwo`);
    expect(out.extraMeta).toEqual({ image_path: at("p1"), image_paths: `${at("p1")},${at("p2")}` });
  });

  it("a photo that fails to download is skipped and logged; the others still arrive", async () => {
    const { adapter } = adapterWith(["bad"]);
    const out = await processAttachments(message("x", [{ kind: "photo", fileId: "bad" }, { kind: "photo", fileId: "ok" }]), adapter, logger);
    expect(out.text).toBe(`[📷 Image: ${at("ok")}]\nx`);
    expect(out.extraMeta).toEqual({ image_path: at("ok") });
    expect(logger.warn).toHaveBeenCalledWith({ err: "boom bad" }, "Photo download failed");
  });

  it("when every photo fails the text is untouched and no image_path is invented", async () => {
    const { adapter } = adapterWith(["bad"]);
    expect(await processAttachments(message("x", [{ kind: "photo", fileId: "bad" }]), adapter, logger)).toEqual({ text: "x", extraMeta: {} });
  });

  it("a document is tagged with its file name and named attachment_path", async () => {
    const { adapter } = adapterWith();
    const out = await processAttachments(message("see", [{ kind: "document", fileId: "d1", filename: "report.pdf" }]), adapter, logger);
    expect(out.text).toBe(`[📎 File: report.pdf → ${at("d1")}]\nsee`);
    expect(out.extraMeta).toEqual({ attachment_path: at("d1") });
  });

  it("a document without a file name is called 'file'; several documents list all paths", async () => {
    const { adapter } = adapterWith();
    const out = await processAttachments(message("", [{ kind: "document", fileId: "d1" }, { kind: "document", fileId: "d2", filename: "b.txt" }]), adapter, logger);
    expect(out.text).toBe(`[📎 File: b.txt → ${at("d2")}]\n[📎 File: file → ${at("d1")}]\n`);
    expect(out.extraMeta).toEqual({ attachment_path: at("d1"), attachment_paths: `${at("d1")},${at("d2")}` });
  });

  it("a failed document download keeps its file id so the agent can fetch it by hand", async () => {
    const { adapter } = adapterWith(["d1"]);
    const out = await processAttachments(message("t", [{ kind: "document", fileId: "d1", filename: "r.pdf" }]), adapter, logger);
    expect(out.text).toBe("t");
    expect(out.extraMeta).toEqual({ attachment_file_id: "d1" });
    expect(logger.warn).toHaveBeenCalledWith({ err: "boom d1" }, "Document download failed");
  });

  it("a video is tagged, and does not displace a document's attachment_path", async () => {
    const { adapter } = adapterWith();
    const out = await processAttachments(message("t", [{ kind: "document", fileId: "d1", filename: "a.txt" }, { kind: "video", fileId: "v1", filename: "clip.mp4" }]), adapter, logger);
    expect(out.text).toBe(`[🎬 Video: clip.mp4 → ${at("v1")}]\n[📎 File: a.txt → ${at("d1")}]\nt`);
    expect(out.extraMeta.attachment_path).toBe(at("d1"));
  });

  it("a video alone becomes attachment_path; its default name is 'video'", async () => {
    const { adapter } = adapterWith();
    const out = await processAttachments(message("", [{ kind: "video", fileId: "v1" }]), adapter, logger);
    expect(out.text).toBe(`[🎬 Video: video → ${at("v1")}]\n`);
    expect(out.extraMeta).toEqual({ attachment_path: at("v1") });
  });

  it("an attachment kind with no download handling passes its file id through", async () => {
    const { adapter, downloads } = adapterWith();
    const out = await processAttachments(message("s", [{ kind: "sticker", fileId: "s1" }]), adapter, logger);
    expect(out).toEqual({ text: "s", extraMeta: { attachment_file_id: "s1" } });
    expect(downloads).toEqual([]);
  });

  describe("voice", () => {
    const voice: Attachment = { kind: "voice", fileId: "v9" };

    it("without a Groq key keeps the audio as a file the agent can open", async () => {
      const { adapter } = adapterWith();
      const out = await processAttachments(message("", [voice]), adapter, logger);
      expect(out.text).toBe(`[🎵 Audio: audio → ${at("v9")}]\n`);
      expect(out.extraMeta).toEqual({ attachment_path: at("v9"), attachment_file_id: "v9" });
      expect(transcribe).not.toHaveBeenCalled();
      expect(existsSync(at("v9")), "an untranscribed recording must survive").toBe(true);
    });

    it("with a key, the transcription replaces the file: text is prefixed, the audio deleted, no attachment_path", async () => {
      process.env.GROQ_API_KEY = "gk-test";
      vi.mocked(transcribe).mockResolvedValue({ text: "buy milk" });
      const { adapter } = adapterWith();
      const out = await processAttachments(message("", [voice]), adapter, logger, "inst");
      expect(transcribe).toHaveBeenCalledWith(at("v9"), "gk-test");
      expect(out.text).toBe("[Voice message] buy milk");
      expect(out.extraMeta).toEqual({ attachment_file_id: "v9" });
      expect(existsSync(at("v9"))).toBe(false);
      expect(logger.info).toHaveBeenCalledWith({ context: "inst", transcription: "buy milk" }, "Voice transcribed");
    });

    it("a caption is kept above the transcription", async () => {
      process.env.GROQ_API_KEY = "gk-test";
      vi.mocked(transcribe).mockResolvedValue({ text: "buy milk" });
      const { adapter } = adapterWith();
      expect((await processAttachments(message("note", [voice]), adapter, logger)).text).toBe("note\n\n[Voice message] buy milk");
    });

    it("a failed transcription falls back to the audio file and keeps it", async () => {
      process.env.GROQ_API_KEY = "gk-test";
      vi.mocked(transcribe).mockRejectedValue(new Error("groq 500"));
      const { adapter } = adapterWith();
      const out = await processAttachments(message("", [{ kind: "audio", fileId: "a1", filename: "memo.mp3" }]), adapter, logger);
      expect(out.text).toBe(`[🎵 Audio: memo.mp3 → ${at("a1")}]\n`);
      expect(out.extraMeta).toEqual({ attachment_path: at("a1"), attachment_file_id: "a1" });
      expect(existsSync(at("a1"))).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith({ err: "groq 500" }, "Voice transcription failed");
    });

    it("a failed audio download says so instead of leaving the message empty", async () => {
      const { adapter } = adapterWith(["v9"]);
      const out = await processAttachments(message("", [voice]), adapter, logger);
      expect(out.text).toBe("[Audio attachment — download failed]");
      expect(out.extraMeta).toEqual({ attachment_file_id: "v9" });
    });

    it("a failed audio download does not overwrite the user's own caption", async () => {
      const { adapter } = adapterWith(["v9"]);
      expect((await processAttachments(message("my words", [voice]), adapter, logger)).text).toBe("my words");
    });
  });
});
