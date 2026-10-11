import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const skill = readFileSync(
  new URL("../src/general-knowledge/skills/fleet-config/SKILL.md", import.meta.url),
  "utf8",
);

describe("General fleet-config skill", () => {
  it("documents the bounded reply guard, capability boundary, and Classic fallback", () => {
    expect(skill).toContain("reply_completion_guard");
    // #1634: codex and muse have the guard too (codex.ts / muse.ts replyCompletionGuard = true); it needs the MCP server.
    expect(skill).toContain("enabled by default for Claude Code, Codex, Muse and Kiro legacy/TUI (it needs the\nMCP server)");
    expect(skill).toContain("Kiro v3 is excluded");
    expect(skill).toContain("Other\nbackends keep the setting");
    expect(skill).toContain("channels.<id>` → `classicBot.yaml defaults` → `fleet.yaml");
    expect(skill).toContain("Prefer a narrow per-instance override");
    expect(skill).toContain("does not change which trusted human messages require a reply");
  });
});
