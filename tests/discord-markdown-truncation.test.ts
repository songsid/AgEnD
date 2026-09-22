import { describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";

const FENCED_MESSAGE = `before\n\`\`\`ts\n${"const value = 1;\n".repeat(180)}\`\`\`\nafter`;

function makeAdapter() {
  const edit = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue({ id: "message-1" });
  const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
  // sendApproval uses EventEmitter.on; Object.create avoids constructing a
  // real discord.js Client, while this is enough of EventEmitter's state for
  // the production method to register and later clean up its handler.
  (adapter as any)._events = Object.create(null);
  (adapter as any)._eventsCount = 0;
  (adapter as any).generalChannelId = "general";
  (adapter as any)._fetchTextChannel = vi.fn(async () => ({
    messages: { fetch: vi.fn(async () => ({ edit })) },
    send,
  }));
  return { adapter, edit, send };
}

describe("Discord markdown-safe truncation wiring", () => {
  it("editMessage closes a fence before applying Discord's 2000-char cap", async () => {
    const { adapter, edit } = makeAdapter();
    await adapter.editMessage("chat", "message", FENCED_MESSAGE);

    const output = edit.mock.calls[0][0] as string;
    expect(output.length).toBeLessThanOrEqual(2000);
    expect(output).toMatch(/\n```$/);
  });

  it("editMessageRemoveButtons keeps fenced content balanced", async () => {
    const { adapter, edit } = makeAdapter();
    await adapter.editMessageRemoveButtons("chat", "message", FENCED_MESSAGE);

    const output = edit.mock.calls[0][0].content as string;
    expect(output.length).toBeLessThanOrEqual(2000);
    expect(output).toMatch(/\n```$/);
    expect(edit.mock.calls[0][0].components).toEqual([]);
  });

  it("editAlert keeps a long fenced alert renderable", async () => {
    const { adapter, edit } = makeAdapter();
    await adapter.editAlert("chat", "message", { type: "cancel", instanceName: "demo", message: FENCED_MESSAGE });

    const output = edit.mock.calls[0][0].content as string;
    expect(output.length).toBeLessThanOrEqual(2000);
    expect(output).toMatch(/\n```$/);
  });

  it("permission previews choose an outer fence longer than embedded backticks", async () => {
    const { adapter, send } = makeAdapter();
    const prompt = {
      tool_name: "shell",
      input_preview: "echo ``` nested\n" + "x".repeat(240),
      description: "",
    };

    await adapter.sendApproval(prompt, vi.fn());
    const output = send.mock.calls[0][0].content as string;
    const block = output.slice(output.indexOf("\n``" ) + 1);
    expect(block.startsWith("````\n")).toBe(true);
    expect(block.endsWith("\n````")).toBe(true);
  });
});
