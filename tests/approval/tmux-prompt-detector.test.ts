import { describe, it, expect } from "vitest";
import { detectPermissionPrompt } from "../../src/approval/tmux-prompt-detector.js";

describe("TmuxPromptDetector", () => {
  it("detects permission prompt", () => {
    expect(detectPermissionPrompt("Edit .claude/settings.json?\n1.Yes  2.Yes,andallow  3.No")).toBe(true);
  });
  it("ignores normal output", () => {
    expect(detectPermissionPrompt("Hello world")).toBe(false);
  });
  it("requires both markers", () => {
    expect(detectPermissionPrompt("1.Yes but no deny option")).toBe(false);
  });
});
