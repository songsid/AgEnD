import { describe, expect, it, vi } from "vitest";
import { outboundHandlers } from "../src/outbound-handlers.js";

/**
 * A cross-instance message whose code block starts right after the second
 * sentence. `send_to_instance` without `request_kind` posts a 100-char preview
 * to the target's topic; a plain slice() landed inside the fence, so Discord
 * received an unclosed ``` and swallowed the rest of the message.
 */
const FENCED = [
  "我查到根因了。",
  "",
  "問題在這段程式碼，你看一下：",
  "",
  "```ts",
  "const chunks = splitText(text, chunkLimit);",
  "for (const chunk of chunks) await channel.send(chunk);",
  "const preview = message.slice(0, 100);",
  "```",
  "",
  "所以只要訊息含 code block 就會壞掉。",
].join("\n");

function fenceLines(s: string): number {
  return s.split("\n").filter(l => /^\s{0,3}```/.test(l)).length;
}

function makeContext(sendText: ReturnType<typeof vi.fn>) {
  return {
    fleetConfig: {
      defaults: {},
      instances: { sender: { topic_id: 10 }, target: { topic_id: 20 } },
      channel: { group_id: 42 },
    },
    adapter: { sendText },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    instanceIpcClients: new Map([["target", { connected: true, send: vi.fn() }]]),
    sessionRegistry: new Map(),
    lifecycle: { daemons: new Map(), isPaused: vi.fn(() => false) },
    classicChannels: null,
    eventLog: { logActivity: vi.fn(), insert: vi.fn() },
    deliverToInstance: vi.fn(async () => {}),
    notifyInstanceTopic: vi.fn(() => true),
    lastActivityMs: vi.fn(() => 0),
  } as any;
}

const meta = { instanceName: "sender", requestId: 1, fleetRequestId: undefined, senderSessionName: undefined };

describe("cross-instance topic notifications never emit a dangling code fence", () => {
  it("closes the fence in the truncated target-topic preview", async () => {
    // Precondition: the old behaviour really did produce an unbalanced preview.
    expect(fenceLines(FENCED.slice(0, 100)) % 2).toBe(1);

    const sendText = vi.fn(async () => ({ messageId: "1", chatId: "42" }));
    const ctx = makeContext(sendText);
    await outboundHandlers.get("send_to_instance")!(
      ctx, { instance_name: "target", message: FENCED }, () => {}, meta as any,
    );

    const posts = sendText.mock.calls.map(c => String(c[1]));
    expect(posts.length).toBeGreaterThan(0);

    const preview = posts.find(p => p.includes("…"));
    expect(preview, "a truncated preview should have been posted").toBeDefined();
    expect(preview!.length).toBeLessThan(FENCED.length);
    expect(fenceLines(preview!) % 2, `unbalanced preview: ${preview}`).toBe(0);

    // Every topic post, truncated or not, must be renderable.
    for (const p of posts) expect(fenceLines(p) % 2, `unbalanced post: ${p}`).toBe(0);
  });
});
