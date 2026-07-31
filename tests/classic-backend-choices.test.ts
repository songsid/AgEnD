import { describe, expect, it } from "vitest";
import { DISCORD_START_BACKEND_CHOICES } from "../src/channel/adapters/discord.js";
import { getClassicBackendChoices } from "../src/classic-channel-manager.js";

describe("ClassicBot backend choices", () => {
  it("registers the curated Discord slash-command choices", () => {
    expect(DISCORD_START_BACKEND_CHOICES).toEqual([
      { name: "Claude Code", value: "claude-code" },
      { name: "Kiro CLI", value: "kiro-cli" },
      { name: "Codex", value: "codex" },
      { name: "OpenCode", value: "opencode" },
      { name: "Antigravity", value: "antigravity" },
      { name: "Grok Build", value: "grok" },
    ]);
  });

  it("marks no backend as experimental — Telegram and Discord must agree", () => {
    // Grok's ⚠️ was removed from the Discord choices, the wizard, the factory and
    // the docs, but ClassicBot kept its own EXPERIMENTAL_BACKENDS set, so the two
    // platforms labelled the same backend differently.
    expect(getClassicBackendChoices().every(choice => !choice.label.includes("⚠️"))).toBe(true);
  });

  it("omits deprecated Gemini and test-only mock from Telegram choices", () => {
    const ids = getClassicBackendChoices().map(choice => choice.id);
    expect(ids).not.toContain("gemini-cli");
    expect(ids).not.toContain("mock");
    expect(ids).toContain("grok");
  });
});
