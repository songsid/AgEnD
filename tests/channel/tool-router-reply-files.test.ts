import { describe, expect, it, vi } from "vitest";
import { routeToolCall } from "../../src/channel/tool-router.js";
import type { ChannelAdapter, SentMessage } from "../../src/channel/types.js";

/**
 * `reply` with files delivers two platform messages: the text, then the
 * attachment. The tool used to answer with the text's id only, and the
 * attachment ids — which sendFile has always returned — were dropped on the
 * floor. A caller that GETs the returned id to confirm delivery, or to read the
 * CDN url, lands on a message with `attachments: []` and cannot tell that from
 * the attachment having been lost.
 */

type Adapter = ChannelAdapter & {
  sendText: ReturnType<typeof vi.fn>;
  sendFile: ReturnType<typeof vi.fn>;
};

const sent = (messageId: string): SentMessage => ({ messageId, chatId: "chan" });

function makeAdapter(fileIds: string[] = []): Adapter {
  let next = 0;
  return {
    sendText: vi.fn(async () => sent("text-1")),
    sendFile: vi.fn(async () => sent(fileIds[next++] ?? `file-${next}`)),
  } as unknown as Adapter;
}

/** Run the tool and resolve with whatever it responded. */
function reply(adapter: Adapter, args: Record<string, unknown>) {
  return new Promise<{ result: unknown; error?: string }>(resolve => {
    const handled = routeToolCall(adapter, "reply", { chat_id: "chan", ...args }, undefined,
      (result, error) => resolve({ result, error }));
    expect(handled, "routeToolCall should handle reply").toBe(true);
  });
}

describe("reply with files", () => {
  it("reports the id of every message that carries an attachment", async () => {
    const adapter = makeAdapter(["img-a", "img-b"]);

    const { result } = await reply(adapter, { text: "here you go", files: ["/tmp/a.png", "/tmp/b.png"] });

    expect(result).toMatchObject({
      messageId: "text-1",
      attachment_message_ids: ["img-a", "img-b"],
    });
  });

  it("keeps messageId pointing at the text, so react and edit still land there", async () => {
    // Redefining messageId would have been the breaking fix: an agent that
    // reacts to its own reply would start reacting to the image instead.
    const adapter = makeAdapter(["img-a"]);

    const { result } = await reply(adapter, { text: "hi", files: ["/tmp/a.png"] });

    expect((result as { messageId: string }).messageId).toBe("text-1");
  });

  it("says nothing extra when the reply has no files", async () => {
    const adapter = makeAdapter();

    const { result } = await reply(adapter, { text: "just words" });

    expect(result).toEqual({ messageId: "text-1", chatId: "chan" });
    expect(result).not.toHaveProperty("attachment_message_ids");
    expect(adapter.sendFile).not.toHaveBeenCalled();
  });

  it("sends the files after the text, in the order given", async () => {
    const adapter = makeAdapter(["img-a", "img-b", "img-c"]);

    const { result } = await reply(adapter, { text: "three", files: ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"] });

    expect((result as { attachment_message_ids: string[] }).attachment_message_ids)
      .toEqual(["img-a", "img-b", "img-c"]);
    expect(adapter.sendFile.mock.calls.map(c => c[1])).toEqual(["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"]);
  });

  it("reports an error rather than a partial result when a file fails", async () => {
    // Pre-existing behaviour, pinned so it is changed on purpose: the text and
    // any earlier file are already delivered, and the tool still answers with
    // an error. Whoever fixes that has to decide what a partial send reports.
    const adapter = makeAdapter(["img-a"]);
    adapter.sendFile
      .mockImplementationOnce(async () => sent("img-a"))
      .mockImplementationOnce(async () => { throw new Error("upload failed"); });

    const { result, error } = await reply(adapter, { text: "hi", files: ["/tmp/a.png", "/tmp/b.png"] });

    expect(error).toBe("upload failed");
    expect(result).toBeNull();
  });

  it("refuses more than twenty files without sending anything", async () => {
    const adapter = makeAdapter();

    const { error } = await reply(adapter, { text: "hi", files: Array.from({ length: 21 }, (_, i) => `/tmp/${i}.png`) });

    expect(error).toContain("too many files");
    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(adapter.sendFile).not.toHaveBeenCalled();
  });
});
