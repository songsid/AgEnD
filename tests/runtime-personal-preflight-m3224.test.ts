import { describe, expect, it } from "vitest";
import { validatePersonalFeaturesOutput, validatePersonalPromptOutput } from "../src/runtime-personal-preflight.js";
import { PERSONAL_CODEX_DISABLED_FEATURES } from "../src/runtime-personal-profile.js";
describe("personal prompt isolation proof", () => {
  it("requires every effective isolation flag, refusing unsupported or ignored flags", () => {
    const flags = PERSONAL_CODEX_DISABLED_FEATURES.map(name => `${name} stable false`).concat("skip_host_skill_discovery under development true").join("\n");
    expect(() => validatePersonalFeaturesOutput(flags)).not.toThrow();
    for (const name of PERSONAL_CODEX_DISABLED_FEATURES) {
      expect(() => validatePersonalFeaturesOutput(flags.replace(`${name} stable false`, `${name} stable true`))).toThrow("profile-unavailable");
      expect(() => validatePersonalFeaturesOutput(flags.replace(`${name} stable false`, ""))).toThrow("profile-unavailable");
    }
    expect(() => validatePersonalFeaturesOutput(flags.replace("discovery under development true", "discovery under development false"))).toThrow();
  });
  it("accepts only a rendered input list without inherited skill or agent instructions", () => {
    expect(() => validatePersonalPromptOutput(JSON.stringify([{ role: "developer", content: [{ type: "input_text", text: "An empty controlled workspace." }] }]))).not.toThrow();
    for (const text of ["## Skills", "<skills_instructions>Available skills</skills_instructions>", "# AGENTS.md instructions for a private repo"])
      expect(() => validatePersonalPromptOutput(JSON.stringify([{ role: "developer", content: [{ type: "input_text", text }] }]))).toThrow("profile-unavailable");
    expect(() => validatePersonalPromptOutput(JSON.stringify([{ role: "developer", content: [{ type: "input_text", text: 'Stock guidance mentions "### Available skills" without offering any.' }] }]))).not.toThrow();
    expect(() => validatePersonalPromptOutput(JSON.stringify([{ role: "developer", content: [], internal_chat_message_metadata_passthrough: { content_item_kinds: ["host_skills.instructions"] } }]))).toThrow();
  });
  it("refuses malformed, empty, unknown and oversized render output without using it as an answer", () => {
    for (const value of ["private raw text", "[]", '{"error":"private details"}', "x".repeat(512 * 1024 + 1)])
      expect(() => validatePersonalPromptOutput(value)).toThrow("profile-unavailable");
  });
});
