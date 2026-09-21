import { describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import type { AlertData } from "../src/channel/types.js";

/**
 * `editAlert` is what keeps the cancel button alive across progress updates, and
 * the two platforms disagree — invertedly — about what omitting the buttons means:
 *
 *   Telegram: omitting `reply_markup` CLEARS the keyboard.
 *   Discord:  omitting `components` KEEPS whatever is already on the message.
 *
 * So one call site produced opposite outcomes. These tests pin the contract from
 * the caller's side: `alert.choices` fully describes the resulting buttons, on
 * both platforms, in both directions.
 */

const CANCEL: AlertData = {
  type: "cancel",
  instanceName: "alpha",
  message: "⏳ 處理中… (已進行 5m 32s)",
  choices: [{ id: "cancel:alpha", label: "Cancel" }],
};

const NO_BUTTONS: AlertData = {
  type: "cancel",
  instanceName: "alpha",
  message: "done",
};

// Both members are private on their adapter, so an intersection cannot widen
// them — `TelegramAdapter & { bot: … }` collapses to `never`, which is what left
// every use below unchecked. Naming the shape separately and reaching it through
// an index access says the same thing and keeps the adapter itself typed.
type TelegramInternals = { bot: { api: { editMessageText: ReturnType<typeof vi.fn> } } };
type DiscordInternals = { _fetchTextChannel(id: string): Promise<unknown> };

function makeTelegram() {
  const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
  const editMessageText = vi.fn().mockResolvedValue(undefined);
  (adapter as unknown as TelegramInternals).bot = { api: { editMessageText } };
  return { adapter, editMessageText };
}

function makeDiscord() {
  const edit = vi.fn().mockResolvedValue(undefined);
  const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
  (adapter as unknown as DiscordInternals)._fetchTextChannel = async () => ({
    messages: { fetch: async () => ({ edit }) },
  });
  return { adapter, edit };
}

describe("editAlert keeps the cancel button on every platform", () => {
  it("Telegram re-sends the keyboard from the alert's choices", async () => {
    const { adapter, editMessageText } = makeTelegram();
    await adapter.editAlert("123", "456", CANCEL);

    const [, , text, opts] = editMessageText.mock.calls[0];
    expect(text).toBe(CANCEL.message);
    expect(opts.reply_markup.inline_keyboard.flat()).toMatchObject([
      { text: "Cancel", callback_data: "cancel:alpha" },
    ]);
  });

  it("Discord re-sends the button row from the alert's choices", async () => {
    const { adapter, edit } = makeDiscord();
    await adapter.editAlert("123", "456", CANCEL);

    const payload = edit.mock.calls[0][0];
    expect(payload.content).toBe(CANCEL.message);
    expect(payload.components).toHaveLength(1);
    const button = payload.components[0].components[0].toJSON();
    expect(button).toMatchObject({ custom_id: "cancel:alpha", label: "Cancel" });
  });
});

describe("editAlert clears buttons the same way on both platforms", () => {
  it("Telegram always sends reply_markup, so absence never means 'keep'", async () => {
    const { adapter, editMessageText } = makeTelegram();
    await adapter.editAlert("123", "456", NO_BUTTONS);

    const [, , , opts] = editMessageText.mock.calls[0];
    expect(opts).toHaveProperty("reply_markup");
    expect(opts.reply_markup.inline_keyboard.flat()).toHaveLength(0);
  });

  it("Discord always sends components, so absence never means 'keep'", async () => {
    // Previously the field was spread in conditionally. With no choices it was
    // omitted, and discord.js leaves existing components untouched — the buttons
    // survived an edit that asked for none, the exact opposite of Telegram.
    const { adapter, edit } = makeDiscord();
    await adapter.editAlert("123", "456", NO_BUTTONS);

    const payload = edit.mock.calls[0][0];
    expect(payload).toHaveProperty("components");
    expect(payload.components).toEqual([]);
  });
});
