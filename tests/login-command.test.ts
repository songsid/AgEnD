import { describe, expect, it, vi } from "vitest";
import { TopicCommands } from "../src/topic-commands.js";

function makeCommands(ctxOverrides: Record<string, unknown> = {}) {
  const sendText = vi.fn().mockResolvedValue({ messageId: "m1" });
  const adapter = { id: "discord", type: "discord", sendText };
  const ctx = {
    adapter,
    fleetConfig: { defaults: {}, instances: {} },
    isFleetAdmin: vi.fn(() => true),
    promptLoginBackends: vi.fn(async () => {}),
    startLoginSession: vi.fn(async (backend: string) => `started:${backend}`),
    loginSubmitInput: vi.fn(async (text: string) => `input:${text}`),
    cancelLoginSession: vi.fn(async () => "cancelled"),
    ...ctxOverrides,
  } as any;
  return { commands: new TopicCommands(ctx), ctx, sendText };
}

const msg = (text: string) => ({
  text, chatId: "chat", threadId: "topic", userId: "u1", adapterId: "discord", username: "admin",
}) as any;

describe("/login command", () => {
  it("denies non-admins without touching the login context", async () => {
    const { commands, ctx, sendText } = makeCommands({ isFleetAdmin: vi.fn(() => false) });
    expect(await commands.handleGeneralCommand(msg("/login codex"))).toBe(true);
    expect(ctx.startLoginSession).not.toHaveBeenCalled();
    expect(sendText.mock.calls[0][1]).toContain("Permission denied");
  });

  it("bare /login opens the backend chooser", async () => {
    const { commands, ctx } = makeCommands();
    expect(await commands.handleGeneralCommand(msg("/login"))).toBe(true);
    expect(ctx.promptLoginBackends).toHaveBeenCalledTimes(1);
    expect(ctx.startLoginSession).not.toHaveBeenCalled();
  });

  it("routes backend, code, and cancel arguments", async () => {
    const { commands, ctx, sendText } = makeCommands();
    await commands.handleGeneralCommand(msg("/login codex"));
    expect(ctx.startLoginSession).toHaveBeenCalledWith("codex", expect.objectContaining({ chatId: "chat" }));

    await commands.handleGeneralCommand(msg("/login code ABCD-1234"));
    expect(ctx.loginSubmitInput).toHaveBeenCalledWith("ABCD-1234");

    await commands.handleGeneralCommand(msg("/login cancel"));
    expect(ctx.cancelLoginSession).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(3);
  });

  it("rejects a multi-word argument that is not code/cancel with usage", async () => {
    const { commands, ctx, sendText } = makeCommands();
    await commands.handleGeneralCommand(msg("/login codex now please"));
    expect(ctx.startLoginSession).not.toHaveBeenCalled();
    expect(String(sendText.mock.calls[0][1])).toContain("/login");
  });
});
