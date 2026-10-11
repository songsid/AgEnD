/**
 * #1651 (baseline: the issue body): edit_message.format means what reply's means — "markdown" is the adapter's "html";
 * Telegram renders it (parse_mode HTML on editMessageText, as on sendMessage); Discord always renders Markdown, so an
 * edit there is unchanged. The real tool router and the real adapters' editMessage with their platform calls stubbed.
 */
import { describe, expect, it, vi } from "vitest";
import { routeToolCall } from "../src/channel/tool-router.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";

describe("the tool router passes edit_message's format, mapped like reply's", () => {
  const route = (args: Record<string, unknown>) => {
    const editMessage = vi.fn(async () => {});
    let result: unknown;
    routeToolCall({ editMessage } as never, "edit_message", { chat_id: "c1", message_id: "m1", text: "**hi**", ...args }, "th1", (r) => { result = r; });
    return { editMessage, done: () => result };
  };
  it("markdown → the adapter's html", async () => {
    const r = route({ format: "markdown" });
    await Promise.resolve();
    expect(r.editMessage.mock.calls).toEqual([["c1", "m1", "**hi**", "th1", { format: "html" }]]);
    await Promise.resolve();
    expect(r.done()).toBe("ok");
  });
  it("text, or no format: exactly the call it always was — no options argument (the edit is plain, as before)", () => {
    for (const args of [{ format: "text" }, {}]) {
      const r = route(args);
      expect([r.editMessage.mock.calls, r.editMessage.mock.calls[0]!.length], JSON.stringify(args)).toEqual([[["c1", "m1", "**hi**", "th1"]], 4]);
    }
  });
});

describe("Telegram renders an edit like the reply it edits", () => {
  type Internals = { bot: { api: { editMessageText: ReturnType<typeof vi.fn> } } };
  const make = () => {
    const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    (adapter as unknown as Internals).bot = { api: { editMessageText } };
    return { adapter, editMessageText };
  };
  it("html → parse_mode HTML", async () => {
    const t = make();
    await t.adapter.editMessage("100", "7", "<b>bold</b>", undefined, { format: "html" });
    expect(t.editMessageText.mock.calls).toEqual([[100, 7, "<b>bold</b>", { parse_mode: "HTML" }]]);
  });
  it("no format: exactly the call it always made (no options — so no keyboard is touched either)", async () => {
    const t = make();
    await t.adapter.editMessage("100", "7", "plain");
    await t.adapter.editMessage("100", "7", "plain", "th", {});
    expect(t.editMessageText.mock.calls).toEqual([[100, 7, "plain"], [100, 7, "plain"]]);
  });
});

describe("Discord: always Markdown, so an edit is what it was", () => {
  it("the format changes nothing about the edit", async () => {
    const edits: unknown[] = [];
    const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
    (adapter as unknown as { _fetchTextChannel(id: string): Promise<unknown> })._fetchTextChannel = async () => ({
      messages: { fetch: async () => ({ edit: async (body: unknown) => { edits.push(body); } }) },
    });
    await adapter.editMessage("g1", "m1", "**bold**", "t1", { format: "html" });
    await adapter.editMessage("g1", "m1", "**bold**", "t1");
    expect(edits).toEqual(["**bold**", "**bold**"]);
  });
});
