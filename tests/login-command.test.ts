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

  it("routes backend and cancel; `code` is no longer an argument (#1137)", async () => {
    const { commands, ctx, sendText } = makeCommands();
    await commands.handleGeneralCommand(msg("/login codex"));
    expect(ctx.startLoginSession).toHaveBeenCalledWith("codex", expect.objectContaining({ chatId: "chat" }));

    await commands.handleGeneralCommand(msg("/login code ABCD-1234"));
    expect(ctx.startLoginSession).toHaveBeenCalledTimes(1);       // only the first one started anything
    expect(sendText.mock.calls.at(-1)![1]).toContain("Usage");

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

describe("/install-cli as a removed typed leftover (#2359), and no /login reinstall (#1137)", () => {
  it("/login reinstall is not an argument: a usage error", async () => {
    const { commands, ctx, sendText } = makeCommands();
    await commands.handleGeneralCommand(msg("/login reinstall codex"));
    expect(ctx.startLoginSession).not.toHaveBeenCalled();
    expect(sendText.mock.calls.at(-1)![1]).toContain("Usage");
  });

  it("/install-cli <backend> (either spelling) points at /login and does not run login", async () => {
    const { commands, ctx, sendText } = makeCommands();
    expect(await commands.handleGeneralCommand(msg("/install-cli grok"))).toBe(true);
    expect(await commands.handleGeneralCommand(msg("/install_cli codex"))).toBe(true);
    expect(sendText.mock.calls.filter(c => String(c[1]).includes("`/install-cli` was removed. Use `/login`."))).toHaveLength(2);
    expect(ctx.startLoginSession).not.toHaveBeenCalled();
    expect(ctx.promptLoginBackends).not.toHaveBeenCalled();
  });

  it("bare /install-cli and /install-cli cancel also only point at /login", async () => {
    const { commands, ctx, sendText } = makeCommands();
    await commands.handleGeneralCommand(msg("/install-cli"));
    await commands.handleGeneralCommand(msg("/install-cli cancel"));
    expect(ctx.promptLoginBackends).not.toHaveBeenCalled();
    expect(ctx.cancelLoginSession).not.toHaveBeenCalled();
    expect(sendText.mock.calls.filter(c => String(c[1]).includes("`/install-cli` was removed. Use `/login`."))).toHaveLength(2);
  });

  it("a non-admin gets the same one-line pointer, not a login refusal", async () => {
    const { commands, ctx, sendText } = makeCommands({ isFleetAdmin: vi.fn(() => false) });
    await commands.handleGeneralCommand(msg("/install-cli grok"));
    expect(ctx.startLoginSession).not.toHaveBeenCalled();
    expect(sendText.mock.calls.at(-1)![1]).toBe("`/install-cli` was removed. Use `/login`.");
  });
});
