import { describe, it, expect } from "vitest";
import {
  detectPermissionPrompt,
  detectInteractivePrompt,
  classifyPrompt,
  extractToolPattern,
} from "../../src/approval/tmux-prompt-detector.js";

describe("detectInteractivePrompt", () => {
  it("detects permission prompt", () => {
    const text = "Do you want to proceed?\n❯ 1. Yes\n  2. Don't ask again\n  3. No\nEsc to cancel";
    expect(detectInteractivePrompt(text)).toBe(true);
  });

  it("detects dev channels prompt", () => {
    const text = "❯ 1. I am using this for local development\n  2. Exit\nEnter to confirm · Esc to cancel";
    expect(detectInteractivePrompt(text)).toBe(true);
  });

  it("detects settings error prompt", () => {
    const text = "❯ 1. Exit and fix manually\n  2. Continue without these settings\nEnter to confirm · Esc to cancel";
    expect(detectInteractivePrompt(text)).toBe(true);
  });

  it("detects SKILL.md creation prompt", () => {
    const text = "Do you want to create SKILL.md?\n❯ 1. Yes\n  2. Yes, allow editing\n  3. No\nEsc to cancel · Tab to amend";
    expect(detectInteractivePrompt(text)).toBe(true);
  });

  it("ignores normal output", () => {
    expect(detectInteractivePrompt("Hello world")).toBe(false);
  });

  it("ignores numbered lists without prompt chrome", () => {
    expect(detectInteractivePrompt("1. First item\n2. Second item")).toBe(false);
  });
});

describe("classifyPrompt", () => {
  it("classifies permission prompt", () => {
    const text = "Do you want to proceed?\n❯ 1. Yes\n  3. No\nEsc to cancel";
    expect(classifyPrompt(text)).toBe("permission");
  });

  it("classifies settings error", () => {
    const text = "Settings Error\n❯ 1. Exit\n  2. Continue without these settings\nEnter to confirm";
    expect(classifyPrompt(text)).toBe("settings_error");
  });

  it("classifies dev channels", () => {
    const text = "❯ 1. I am using this for local development\n  2. Exit";
    expect(classifyPrompt(text)).toBe("dev_channels");
  });

  it("classifies MCP trust", () => {
    const text = "New MCP server found\n❯ 1. Trust\n  2. Skip";
    expect(classifyPrompt(text)).toBe("mcp_trust");
  });

  it("classifies file creation (SKILL.md)", () => {
    const text = "Do you want to create SKILL.md?\n❯ 1. Yes\n  3. No";
    expect(classifyPrompt(text)).toBe("file_creation");
  });

  it("returns unknown for unrecognized prompts", () => {
    const text = "Something else\n❯ 1. Option A\n  2. Option B";
    expect(classifyPrompt(text)).toBe("unknown");
  });
});

describe("detectPermissionPrompt (legacy)", () => {
  it("detects old format (no space)", () => {
    expect(detectPermissionPrompt("1.Yes  2.Yes,andallow  3.No")).toBe(true);
  });

  it("detects new format (with space)", () => {
    expect(detectPermissionPrompt("❯ 1. Yes\n  2. Don't ask\n  3. No")).toBe(true);
  });

  it("detects prompt with ANSI codes", () => {
    expect(detectPermissionPrompt("\x1b[32m1\x1b[0m. Yes\n\x1b[31m3\x1b[0m. No")).toBe(true);
  });

  it("ignores normal output", () => {
    expect(detectPermissionPrompt("Hello world")).toBe(false);
  });
});

describe("extractToolPattern", () => {
  it("extracts MCP tool pattern", () => {
    const text = "2. Yes, and don't ask again for puppeteer - puppeteer_navigate commands in /foo";
    expect(extractToolPattern(text)).toBe("mcp__puppeteer__puppeteer_navigate");
  });

  it("extracts built-in tool pattern", () => {
    const text = "2. Yes, and don't ask again for Bash commands in /foo";
    expect(extractToolPattern(text)).toBe("Bash(*)");
  });

  it("returns null when no match", () => {
    expect(extractToolPattern("random text")).toBeNull();
  });

  it("handles ANSI codes", () => {
    const text = "2. Yes, and don\x1b[0m't ask again for \x1b[32mpuppeteer\x1b[0m - \x1b[32mpuppeteer_click\x1b[0m commands in /foo";
    expect(extractToolPattern(text)).toBe("mcp__puppeteer__puppeteer_click");
  });

  it("handles real tmux cursor-forward codes", () => {
    const text = "\x1b[3C\x1b[38;5;246m2.\x1b[1C\x1b[39mYes,\x1b[1Cand\x1b[1Cdont\x1b[1Cask\x1b[1Cagain\x1b[1Cfor\x1b[1C\x1b[1mpuppeteer\x1b[1C-\x1b[1Cpuppeteer_navigate\x1b[1C\x1b[22mcommands\x1b[1Cin";
    expect(extractToolPattern(text)).toBe("mcp__puppeteer__puppeteer_navigate");
  });
});
