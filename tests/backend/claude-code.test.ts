import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeBackend } from "../../src/backend/claude-code.js";
import type { CliBackendConfig } from "../../src/backend/types.js";
import { isModelCompatible, validateModel } from "../../src/backend/types.js";

const TEST_DIR = "/tmp/ccd-test-claude-backend";
const WORK_DIR = "/tmp/ccd-test-workdir";
const CLAUDE_DIR = "/tmp/ccd-test-claude-config";
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

function makeConfig(overrides?: Partial<CliBackendConfig>): CliBackendConfig {
  return {
    workingDirectory: WORK_DIR,
    instanceDir: TEST_DIR,
    instanceName: "test",
    mcpServers: {
      "agend": {
        command: "node",
        args: ["/path/to/mcp-server.js"],
        env: { AGEND_SOCKET_PATH: "/tmp/test.sock" },
      },
    },
    ...overrides,
  };
}

describe("ClaudeCodeBackend", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(WORK_DIR, { recursive: true });
    mkdirSync(CLAUDE_DIR, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR;
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(WORK_DIR, { recursive: true, force: true });
    rmSync(CLAUDE_DIR, { recursive: true, force: true });
    if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  });

  describe("buildCommand", () => {
    it("includes --mcp-config and --dangerously-skip-permissions", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("--mcp-config");
      expect(cmd).toContain("mcp-config.json");
      expect(cmd).toContain("--dangerously-skip-permissions");
    });

    it("does not include --dangerously-load-development-channels", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).not.toContain("--dangerously-load-development-channels");
    });

    it("uses --continue when session-id file exists to bypass the session picker", () => {
      writeFileSync(join(TEST_DIR, "session-id"), "sess-123");
      const projectDir = join(CLAUDE_DIR, "projects", "-tmp-ccd-test-workdir");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "sess-123.jsonl"), "{}\n");
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("--continue");
      expect(cmd).not.toContain("--resume");
    });

    it("matches Claude's project key for hidden and underscored working directories", () => {
      writeFileSync(join(TEST_DIR, "session-id"), "sess-special");
      const workingDirectory = join(WORK_DIR, ".agend", "with_under_score");
      mkdirSync(workingDirectory, { recursive: true });
      // Claude Code encodes dots and underscores as well as path separators.
      const projectDir = join(CLAUDE_DIR, "projects", "-tmp-ccd-test-workdir--agend-with-under-score");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "sess-special.jsonl"), "{}\n");

      const backend = new ClaudeCodeBackend(TEST_DIR);
      expect(backend.buildCommand(makeConfig({ workingDirectory }))).toContain("--continue");
    });

    it("matches Claude's bounded project key for a working directory over 200 characters", () => {
      writeFileSync(join(TEST_DIR, "session-id"), "sess-long");
      const workingDirectory = `/tmp/${"a".repeat(210)}`;
      const encoded = `-tmp-${"a".repeat(195)}-de6m7t`;
      const projectDir = join(CLAUDE_DIR, "projects", encoded);
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "sess-long.jsonl"), "{}\n");

      const backend = new ClaudeCodeBackend(TEST_DIR);
      expect(backend.buildCommand(makeConfig({ workingDirectory }))).toContain("--continue");
    });

    it("starts fresh when a generic session marker has no Claude transcript in the workspace", () => {
      writeFileSync(join(TEST_DIR, "session-id"), "kiro-session");
      const backend = new ClaudeCodeBackend(TEST_DIR);
      expect(backend.buildCommand(makeConfig())).not.toContain("--continue");
    });

    it("starts fresh when workingDirectory is empty", () => {
      writeFileSync(join(TEST_DIR, "session-id"), "stale-session");
      const backend = new ClaudeCodeBackend(TEST_DIR);
      expect(backend.buildCommand(makeConfig({ workingDirectory: "" }))).not.toContain("--continue");
    });

    it("does not include --system-prompt (prompt injected via MCP instructions)", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).not.toContain("--system-prompt");
      expect(existsSync(join(TEST_DIR, ".prompt-generated"))).toBe(false);
    });

    it("includes --append-system-prompt-file when fleet-instructions.md exists", () => {
      writeFileSync(join(TEST_DIR, "fleet-instructions.md"), "# Fleet");
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("--append-system-prompt-file");
      expect(cmd).toContain("fleet-instructions.md");
    });

    it("does not include --append-system-prompt-file when file absent", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).not.toContain("--append-system-prompt-file");
    });

    it("includes --model when model is set", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig({ model: "opus" }));
      expect(cmd).toContain("--model opus");
    });
  });

  describe("writeConfig", () => {
    it("writes mcp-config.json to instance dir", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      const mcpConfig = JSON.parse(readFileSync(join(TEST_DIR, "mcp-config.json"), "utf-8"));
      expect(mcpConfig.mcpServers["agend"]).toBeDefined();
      expect(mcpConfig.mcpServers["agend"].command).toBe("node");
    });

    it("does not write .mcp.json to working directory", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      expect(existsSync(join(WORK_DIR, ".mcp.json"))).toBe(false);
    });

    it("writes claude-settings.json with statusLine only (no permissions)", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      const settings = JSON.parse(readFileSync(join(TEST_DIR, "claude-settings.json"), "utf-8"));
      expect(settings.statusLine).toBeDefined();
      expect(settings.permissions).toBeUndefined();
    });

    it("writes statusline script", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      expect(existsSync(join(TEST_DIR, "statusline.js"))).toBe(true);
    });

    it("writes fleet-instructions.md when instructions provided", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig({ instructions: "# Fleet Context\nYou are test." }));
      const content = readFileSync(join(TEST_DIR, "fleet-instructions.md"), "utf-8");
      expect(content).toContain("# Fleet Context");
    });

    it("does not write fleet-instructions.md when instructions absent", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      expect(existsSync(join(TEST_DIR, "fleet-instructions.md"))).toBe(false);
    });
  });

  describe("getContextUsage", () => {
    it("returns percentage from statusline.json", () => {
      writeFileSync(join(TEST_DIR, "statusline.json"), JSON.stringify({
        context_window: { used_percentage: 42 },
      }));
      const backend = new ClaudeCodeBackend(TEST_DIR);
      expect(backend.getContextUsage()).toBe(42);
    });

    it("returns null when file missing", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      expect(backend.getContextUsage()).toBeNull();
    });
  });

  describe("getSessionId", () => {
    it("returns session_id from statusline.json", () => {
      writeFileSync(join(TEST_DIR, "statusline.json"), JSON.stringify({
        session_id: "sess-abc",
      }));
      const backend = new ClaudeCodeBackend(TEST_DIR);
      expect(backend.getSessionId()).toBe("sess-abc");
    });
  });

  describe("getErrorPatterns", () => {
    it.each([
      "Login expired",
      "Not logged in",
      "Please run /login to continue",
    ])("notifies when Claude requires re-login: %s", (output) => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const error = backend.getErrorPatterns().find(({ pattern }) => pattern.test(output));

      expect(error).toMatchObject({
        type: "auth_error",
        action: "notify",
        message: "Claude login expired — needs re-login (/login)",
      });
    });
  });

  describe("session resume dialog", () => {
    it("selects the full session at startup instead of the summary", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const dialog = backend.getStartupDialogs().find(({ pattern }) =>
        pattern.test("1. Resume from summary (recommended)"));

      expect(dialog?.keys).toEqual(["Down", "Enter"]);
      expect(dialog?.description).toContain("Resume full session as-is");
    });

    it("selects the full session when the prompt appears at runtime", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const dialog = backend.getRuntimeDialogs().find(({ pattern }) =>
        pattern.test("1. Resume from summary (recommended)"));

      expect(dialog?.keys).toEqual(["Down", "Enter"]);
      expect(dialog?.description).toContain("Resume full session as-is");
    });
  });

  describe("listModels", () => {
    it("offers Fable alongside the established aliases", async () => {
      const models = await new ClaudeCodeBackend(TEST_DIR).listModels();
      expect(models.map(m => m.id)).toEqual(["default", "sonnet", "opus", "haiku", "opusplan", "Fable"]);
    });

    it("passes the compatibility check so no advisory warning fires", () => {
      // The advisory pattern is a separate list from listModels(), so adding a
      // model in one place without the other yields a spurious
      // "doesn't match the usual pattern" warning on every start.
      for (const m of ["Fable", "fable", "FABLE"]) {
        expect(isModelCompatible("claude-code", m), m).toBe(true);
      }
      // Every advertised model must clear the check, not just the new one.
      expect(isModelCompatible("claude-code", "sonnet")).toBe(true);
      expect(isModelCompatible("claude-code", "opusplan")).toBe(true);
    });

    it("is safe to pass through to the CLI as a shell argument", () => {
      expect(validateModel("Fable")).toBe("Fable");
    });
  });
});
