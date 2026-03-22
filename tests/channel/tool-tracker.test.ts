import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolTracker } from "../../src/channel/tool-tracker.js";
import type { ChannelAdapter, SentMessage } from "../../src/channel/types.js";

function mockAdapter(): ChannelAdapter {
  return {
    sendText: vi.fn().mockResolvedValue({ messageId: "status-1", chatId: "c1" } as SentMessage),
    editMessage: vi.fn().mockResolvedValue(undefined),
    // other methods not needed for ToolTracker
  } as unknown as ChannelAdapter;
}

describe("ToolTracker", () => {
  let adapter: ChannelAdapter;
  let tracker: ToolTracker;

  beforeEach(() => {
    adapter = mockAdapter();
    tracker = new ToolTracker(adapter, "chat-1", "thread-42");
  });

  it("sends new status message on first tool_use", async () => {
    await tracker.onToolUse("Read", { file_path: "/tmp/foo.ts" });
    expect(adapter.sendText).toHaveBeenCalledTimes(1);
    expect((adapter.sendText as any).mock.calls[0][1]).toContain("🔧 Read: /tmp/foo.ts");
  });

  it("edits existing message on subsequent tool_use", async () => {
    await tracker.onToolUse("Read", { file_path: "/tmp/a.ts" });
    await tracker.onToolUse("Edit", { file_path: "/tmp/b.ts" });
    expect(adapter.sendText).toHaveBeenCalledTimes(1);
    expect(adapter.editMessage).toHaveBeenCalledTimes(1);
    const editText = (adapter.editMessage as any).mock.calls[0][2];
    expect(editText).toContain("Read: /tmp/a.ts");
    expect(editText).toContain("Edit: /tmp/b.ts");
  });

  it("marks tool as done on tool_result", async () => {
    await tracker.onToolUse("Read", { file_path: "/tmp/foo.ts" });
    await tracker.onToolResult("Read", {});
    const editText = (adapter.editMessage as any).mock.calls[0][2];
    expect(editText).toContain("✅");
    expect(editText).not.toContain("🔧");
  });

  it("resets for new batch", async () => {
    await tracker.onToolUse("Read", { file_path: "/tmp/a.ts" });
    tracker.reset();
    await tracker.onToolUse("Bash", { command: "npm test" });
    // Should send a NEW message (not edit the old one)
    expect(adapter.sendText).toHaveBeenCalledTimes(2);
  });
});
