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
  it("parses the live TSV slug and display-name format", () => {
    const rows = [
      ["gemini-3.7-flash-high", "Gemini 3.7 Flash (High)"],
      ["gemini-3.7-flash-low", "Gemini 3.7 Flash (Low)"],
      ["gemini-3.6-pro-high", "Gemini 3.6 Pro (High)"],
      ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
      ["claude-sonnet-4-6-thinking", "Claude Sonnet 4.6 (Thinking)"],
      ["claude-opus-4-6", "Claude Opus 4.6"],
      ["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"],
      ["gpt-oss-120b-medium", "GPT OSS 120B (Medium)"],
      ["gpt-oss-120b-high", "GPT OSS 120B (High)"],
      ["gemini-3.5-flash-medium", "Gemini 3.5 Flash (Medium)"],
      ["gemini-3.5-flash-high", "Gemini 3.5 Flash (High)"],
    ] as const;
    const output = rows.map(row => row.join("\t")).join("\n");

    expect(parseAntigravityModelsOutput(output)).toEqual(
      rows.map(([id, label]) => ({ id, label })),
    );
  });

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

  it("does not treat the fetching spinner as a model", () => {
    expect(parseAntigravityModelsOutput(`Fetching available models...
gemini-3.7-flash-high\tGemini 3.7 Flash (High)
`)).toEqual([
      { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
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

describe("Kiro model compatibility hints", () => {
  it.each([
    "auto",
    "claude-opus-5",
    "claude-sonnet-4.6",
    "gpt-5.6-sol",
    "deepseek-3.2",
    "minimax-m2.5",
    "glm-5",
    "qwen3-coder-next",
  ])("recognizes a model from the live 2026-07-29 catalog: %s", (model) => {
    expect(isModelCompatible("kiro-cli", model)).toBe(true);
  });
});
