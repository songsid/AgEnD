import { describe, expect, it, vi } from "vitest";
import { AntigravityBackend } from "../../src/backend/antigravity.js";
import { ClaudeCodeBackend } from "../../src/backend/claude-code.js";
import { CodexBackend } from "../../src/backend/codex.js";
import { GeminiCliBackend } from "../../src/backend/gemini-cli.js";
import { GrokBackend } from "../../src/backend/grok.js";
import { KiroBackend } from "../../src/backend/kiro.js";
import { OpenCodeBackend } from "../../src/backend/opencode.js";
import type { CliBackend, CliBackendConfig } from "../../src/backend/types.js";

const INSTANCE_DIR = "/tmp/agend-model-passthrough";
// Must stay atypical for EVERY backend pattern in the table below, so it can't
// borrow a real model name — "fable-new-model" broke the moment Fable became a
// known claude-code model.
const UNKNOWN_MODEL = "zzz-not-a-real-model";

function config(model: string): CliBackendConfig {
  return {
    workingDirectory: INSTANCE_DIR,
    instanceDir: INSTANCE_DIR,
    instanceName: "model-passthrough",
    mcpServers: {},
    model,
  };
}

const cases: Array<{
  name: string;
  backend: () => CliBackend;
  expected: string;
  warns: boolean;
}> = [
  {
    name: "kiro-cli",
    backend: () => new KiroBackend(INSTANCE_DIR),
    expected: `--model '${UNKNOWN_MODEL}'`,
    warns: true,
  },
  {
    name: "claude-code",
    backend: () => new ClaudeCodeBackend(INSTANCE_DIR),
    expected: `--model '${UNKNOWN_MODEL}'`,
    warns: true,
  },
  {
    name: "codex",
    backend: () => new CodexBackend(INSTANCE_DIR),
    expected: `-c 'model="${UNKNOWN_MODEL}"'`,
    warns: true,
  },
  {
    name: "gemini-cli",
    backend: () => new GeminiCliBackend(INSTANCE_DIR),
    expected: `--model '${UNKNOWN_MODEL}'`,
    warns: true,
  },
  {
    name: "opencode",
    backend: () => new OpenCodeBackend(INSTANCE_DIR),
    expected: `--model '${UNKNOWN_MODEL}'`,
    warns: false, // provider-dependent: its advisory pattern accepts any model
  },
  {
    name: "antigravity",
    backend: () => new AntigravityBackend(INSTANCE_DIR),
    expected: `--model '${UNKNOWN_MODEL}'`,
    warns: true,
  },
  {
    name: "grok",
    backend: () => new GrokBackend(INSTANCE_DIR),
    expected: `--model '${UNKNOWN_MODEL}'`,
    warns: true,
  },
];

describe("backend model pass-through", () => {
  it.each(cases)(
    "$name keeps an atypical model in the final command",
    ({ name, backend, expected, warns }) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const command = backend().buildCommand(config(UNKNOWN_MODEL));

      expect(command).toContain(expected);
      if (warns) {
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(`typical pattern for ${name}, passing through anyway`),
        );
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
      warn.mockRestore();
    },
  );
});

describe("bracketed 1M-context models (claude opus[1m])", () => {
  it("validateModel accepts the [1m] suffix and still rejects shell metacharacters", async () => {
    const { validateModel } = await import("../../src/backend/types.js");
    expect(validateModel("opus[1m]")).toBe("opus[1m]");
    expect(validateModel("claude-opus-4-6[1m]")).toBe("claude-opus-4-6[1m]");
    for (const evil of ["a;b", "a$(x)", "a`x`", "a|b", "a&&b", "a b", "a'b", 'a"b', "a\\b", "a>b", "a*b", "a?b", "a${x}"]) {
      expect(() => validateModel(evil), evil).toThrow(/Invalid model name/);
    }
  });

  it("the claude launch command carries the bracketed model shell-quoted (glob-inert)", async () => {
    const { ClaudeCodeBackend } = await import("../../src/backend/claude-code.js");
    const backend = new ClaudeCodeBackend(INSTANCE_DIR);
    const cmd = backend.buildCommand(config("claude-opus-4-6[1m]"));
    expect(cmd).toContain("--model 'claude-opus-4-6[1m]'");
    // Never unquoted: bash pathname-expands an unquoted [..] against the CWD
    // and zsh aborts on a non-matching glob — the CLI would not even start.
    expect(cmd).not.toMatch(/--model claude-opus-4-6\[1m\]/);
  });
});
