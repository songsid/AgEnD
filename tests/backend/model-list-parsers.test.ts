import { describe, expect, it } from "vitest";
import { parseAntigravityModelsOutput } from "../../src/backend/antigravity.js";
import { parseGrokModelsOutput } from "../../src/backend/grok.js";
import { isModelCompatible } from "../../src/backend/types.js";

describe("Grok model list parser", () => {
  it("parses the live `grok models` bullet format", () => {
    expect(parseGrokModelsOutput(`You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
`)).toEqual([
      { id: "grok-4.5", label: "grok-4.5" },
    ]);
  });

  it("accepts additional Grok catalog ids and ignores unrelated prose", () => {
    expect(parseGrokModelsOutput(`Available models:
- grok-4.5
- grok-build-0.1
status: ready
`)).toEqual([
      { id: "grok-4.5", label: "grok-4.5" },
      { id: "grok-build-0.1", label: "grok-build-0.1" },
    ]);
  });
});

describe("Antigravity model list parser", () => {
  it("parses the live one-slug-per-line format", () => {
    expect(parseAntigravityModelsOutput(`gemini-3.6-flash-high
claude-sonnet-4-6
gpt-oss-120b-medium
`)).toEqual([
      { id: "gemini-3.6-flash-high", label: "gemini-3.6-flash-high" },
      { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
      { id: "gpt-oss-120b-medium", label: "gpt-oss-120b-medium" },
    ]);
  });

  it("preserves effort suffixes in older human-readable output", () => {
    expect(parseAntigravityModelsOutput(`Default model: Gemini 3.5 Flash (Medium)
Available models:
  * Gemini 3.5 Flash (Medium)
  * Gemini 3.5 Flash (High)
  * Claude Opus 4.6 (Thinking)
`)).toEqual([
      { id: "Gemini 3.5 Flash (Medium)", label: "Gemini 3.5 Flash (Medium)" },
      { id: "Gemini 3.5 Flash (High)", label: "Gemini 3.5 Flash (High)" },
      { id: "Claude Opus 4.6 (Thinking)", label: "Claude Opus 4.6 (Thinking)" },
    ]);
  });

  it.each([
    "gemini-3.6-flash-high",
    "claude-sonnet-4-6",
    "gpt-oss-120b-medium",
    "Gemini 3.5 Flash (High)",
  ])("accepts listed agy model format in backend compatibility checks: %s", (model) => {
    expect(isModelCompatible("antigravity", model)).toBe(true);
  });
});
