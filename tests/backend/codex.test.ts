import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { CodexBackend } from "../../src/backend/codex.js";
import { appendWithMarker } from "../../src/backend/marker-utils.js";
import type { CliBackendConfig } from "../../src/backend/types.js";

const TEST_DIR = "/tmp/ccd-test-codex-backend";
const WORK_DIR = "/tmp/ccd-test-codex-workdir";
const SHARED_CODEX_HOME = "/tmp/ccd-test-codex-shared-home";

function makeConfig(overrides?: Partial<CliBackendConfig>): CliBackendConfig {
  return {
    workingDirectory: WORK_DIR,
    instanceDir: TEST_DIR,
    instanceName: "test-codex",
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

describe("CodexBackend", () => {
  const originalCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(WORK_DIR, { recursive: true });
    mkdirSync(SHARED_CODEX_HOME, { recursive: true });
    process.env.CODEX_HOME = SHARED_CODEX_HOME;
  });
  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(WORK_DIR, { recursive: true, force: true });
    rmSync(SHARED_CODEX_HOME, { recursive: true, force: true });
  });

  describe("buildCommand", () => {
    it("always uses resume --last (resumes latest session for CWD)", () => {
      const backend = new CodexBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain(`CODEX_HOME='${join(TEST_DIR, "codex-home")}'`);
      expect(cmd).toContain("resume --last");
      expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(cmd).toContain("-c check_for_update_on_startup=false");
    });

    it("includes model config", () => {
      const backend = new CodexBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig({ model: "o3" }));
      expect(cmd).toContain("resume --last");
      expect(cmd).toContain(`-c 'model="o3"'`);
    });

    it("uses --full-auto when skipPermissions is false", () => {
      const backend = new CodexBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig({ skipPermissions: false }));
      expect(cmd).toContain("--full-auto");
      expect(cmd).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    });

    it("includes model_provider when backendOptions.provider is set", () => {
      const backend = new CodexBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig({ backendOptions: { provider: "glm" } }));
      expect(cmd).toContain(`-c 'model_provider="glm"'`);
    });

    it.each(["glm;rm", "glm$HOME", "glm provider"])(
      "rejects unsafe provider name %j",
      (provider) => {
        const backend = new CodexBackend(TEST_DIR);
        expect(() => backend.buildCommand(makeConfig({ backendOptions: { provider } })))
          .toThrow("Invalid provider name");
      },
    );

    it("does not include model_provider when backendOptions.provider is absent", () => {
      const backend = new CodexBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).not.toContain("model_provider");
    });

    it("includes both model and model_provider when both are set", () => {
      const backend = new CodexBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig({ model: "o3", backendOptions: { provider: "glm" } }));
      expect(cmd).toContain(`-c 'model="o3"'`);
      expect(cmd).toContain(`-c 'model_provider="glm"'`);
    });
  });

  describe("per-instance MCP isolation", () => {
    it("writes only each instance's MCP server to its private CODEX_HOME", () => {
      const instanceA = join(TEST_DIR, "instance-a");
      const instanceB = join(TEST_DIR, "instance-b");
      mkdirSync(instanceA, { recursive: true });
      mkdirSync(instanceB, { recursive: true });
      writeFileSync(join(SHARED_CODEX_HOME, "config.toml"), [
        'model = "gpt-5.6-sol"',
        "",
        "[mcp_servers.third_party]",
        'command = "third-party"',
        "",
        "[mcp_servers.agend-stale-instance]",
        'command = "node"',
        "",
        "[mcp_servers.agend-stale-instance.env]",
        'AGEND_DECISIONS = """',
        "[a table-looking line inside a multiline string]",
        'secret decision from stale instance"""',
        'AGEND_SOCKET_PATH = "/tmp/stale.sock"',
        "",
      ].join("\n"), { mode: 0o600 });
      writeFileSync(join(SHARED_CODEX_HOME, "auth.json"), '{"token":"shared"}', { mode: 0o600 });

      const configA = makeConfig({
        instanceDir: instanceA,
        instanceName: "codex-a",
        mcpServers: {
          agend: {
            command: "node",
            args: ["/opt/agend/mcp-server.js"],
            env: {
              AGEND_SOCKET_PATH: "/tmp/codex-a.sock",
              AGEND_DECISIONS: "decision-a",
            },
          },
        },
      });
      const configB = makeConfig({
        instanceDir: instanceB,
        instanceName: "codex-b",
        mcpServers: {
          agend: {
            command: "node",
            args: ["/opt/agend/mcp-server.js"],
            env: {
              AGEND_SOCKET_PATH: "/tmp/codex-b.sock",
              AGEND_DECISIONS: "decision-b",
            },
          },
        },
      });

      // Exercise the production writeConfig implementation for two instances.
      const backendA = new CodexBackend(instanceA);
      const backendB = new CodexBackend(instanceB);
      backendA.writeConfig(configA);
      backendB.writeConfig(configB);

      const homeA = join(instanceA, "codex-home");
      const homeB = join(instanceB, "codex-home");
      const contentA = readFileSync(join(homeA, "config.toml"), "utf-8");
      const contentB = readFileSync(join(homeB, "config.toml"), "utf-8");
      const shared = readFileSync(join(SHARED_CODEX_HOME, "config.toml"), "utf-8");

      expect(contentA).toContain("[mcp_servers.agend-codex-a]");
      expect(contentA).toContain("tool_timeout_sec = 90");
      expect(contentA).toContain('AGEND_SOCKET_PATH = "/tmp/codex-a.sock"');
      expect(contentA).toContain('AGEND_DECISIONS = "decision-a"');
      expect(contentA).not.toContain("codex-b");
      expect(contentA).not.toContain("stale instance");
      expect(contentA).toContain("[mcp_servers.third_party]");

      expect(contentB).toContain("[mcp_servers.agend-codex-b]");
      expect(contentB).toContain('AGEND_SOCKET_PATH = "/tmp/codex-b.sock"');
      expect(contentB).toContain('AGEND_DECISIONS = "decision-b"');
      expect(contentB).not.toContain("codex-a");
      expect(contentB).not.toContain("stale instance");
      expect(contentB).toContain("[mcp_servers.third_party]");

      // Existing global pollution is removed, while unrelated config survives.
      expect(shared).not.toContain("agend-stale-instance");
      expect(shared).not.toContain("secret decision");
      expect(shared).toContain("[mcp_servers.third_party]");
      expect(shared).toContain('model = "gpt-5.6-sol"');

      // Private homes/configs are not group/world-readable. Runtime auth and
      // session state remain shared through links, preserving login/resume.
      expect(statSync(homeA).mode & 0o077).toBe(0);
      expect(statSync(join(homeA, "config.toml")).mode & 0o077).toBe(0);
      expect(lstatSync(join(homeA, "auth.json")).isSymbolicLink()).toBe(true);
    });
  });

  describe("getSessionId", () => {
    it("returns null (Codex manages sessions internally)", () => {
      const backend = new CodexBackend(TEST_DIR);
      expect(backend.getSessionId()).toBeNull();
    });
  });

  describe("listModels", () => {
    it("reads visible account models from the Codex TUI cache", async () => {
      const codexHome = SHARED_CODEX_HOME;
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify({
        models: [
          { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", description: "Frontier", visibility: "list" },
          { slug: "codex-auto-review", display_name: "Auto Review", visibility: "hide" },
          { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", visibility: "list" },
          { slug: "gpt-5.6-sol", display_name: "Duplicate", visibility: "list" },
          { slug: "unsafe model", display_name: "Unsafe", visibility: "list" },
        ],
      }));

      const backend = new CodexBackend(TEST_DIR);
      expect(await backend.listModels()).toEqual([
        { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", description: "Frontier" },
        { id: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
      ]);
    });

    it.each(["missing", "malformed", "unknown-shape"])(
      "returns documented fallback models for a %s cache",
      async (kind) => {
        const codexHome = SHARED_CODEX_HOME;
        mkdirSync(codexHome, { recursive: true });
        if (kind === "malformed") writeFileSync(join(codexHome, "models_cache.json"), "{");
        if (kind === "unknown-shape") writeFileSync(join(codexHome, "models_cache.json"), "{}");

        const backend = new CodexBackend(TEST_DIR);
        const models = await backend.listModels();
        expect(models.map(model => model.id)).toEqual([
          "gpt-5.6-sol",
          "gpt-5.6-terra",
          "gpt-5.6-luna",
        ]);
      },
    );
  });

  describe("getErrorPatterns", () => {
    const matchingError = (pane: string) => new CodexBackend(TEST_DIR)
      .getErrorPatterns()
      .find(({ pattern }) => pattern.test(pane));

    it.each([
      "⚠ Model metadata for 'unknown-model' not found. Defaulting to fallback metadata",
      `■ {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'unknown-model' model is not supported when using Codex with a ChatGPT account."}}`,
    ])("notifies for Codex model errors: %s", (pane) => {
      expect(matchingError(pane)).toMatchObject({
        type: "model_error",
        action: "notify",
      });
    });

    it("still detects a model rejection after tmux hard-wraps it", () => {
      expect(matchingError([
        `■ {"type":"error","status":400,"error":{"message":"The 'unknown-model' model is not`,
        `supported when using Codex with a ChatGPT account."}}`,
      ].join("\n"))).toMatchObject({ type: "model_error", action: "notify" });
    });

    it.each([
      `■ {"type":"error","status":429,"error":{"type":"rate_limit_exceeded","message":"Too many requests"}}`,
      "Error: rate limit reached for gpt-5.6-sol",
      "unexpected status 429 Too Many Requests",
    ])("fails over on a real Codex rate-limit error: %s", (pane) => {
      expect(matchingError(pane)).toMatchObject({ type: "rate_limit", action: "failover" });
    });

    it.each([
      `■ {"type":"error","status":401,"error":{"type":"authentication_error","message":"Unauthorized"}}`,
      "API Error: authentication failed",
      "unexpected status 401 Unauthorized",
    ])("pauses on a real Codex authentication error: %s", (pane) => {
      expect(matchingError(pane)).toMatchObject({ type: "auth_error", action: "pause" });
    });

    it("classifies insufficient_quota before its enclosing HTTP 429", () => {
      const pane = `■ {"status":429,"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}`;
      expect(matchingError(pane)).toMatchObject({ type: "quota", action: "pause" });
    });

    it.each([
      "We need to document authentication and 401 handling.",
      "The service has a rate limit and billing dashboard.",
      "const status = 429; // Too Many Requests is retried",
      "This test says 401 Unauthorized should pause the daemon.",
      `const fixture = {"status":429,"error":{"type":"rate_limit_exceeded"}};`,
      `expect(body.error.type).toBe("authentication_error");`,
    ])("does not treat ordinary agent prose/source as a Codex incident: %s", (pane) => {
      expect(matchingError(pane)).toBeUndefined();
    });
  });

  describe("cleanup — AGENTS.md", () => {
    it("removes marker block from AGENTS.md", () => {
      const agentsMd = join(WORK_DIR, "AGENTS.md");
      writeFileSync(agentsMd, "# User rules\n");
      appendWithMarker(agentsMd, "test-codex", "Fleet context");
      expect(readFileSync(agentsMd, "utf-8")).toContain("Fleet context");
      const backend = new CodexBackend(TEST_DIR);
      backend.cleanup(makeConfig());
      const content = readFileSync(agentsMd, "utf-8");
      expect(content).toContain("# User rules");
      expect(content).not.toContain("Fleet context");
    });

    it("deletes AGENTS.md if empty after marker removal", () => {
      const agentsMd = join(WORK_DIR, "AGENTS.md");
      appendWithMarker(agentsMd, "test-codex", "Fleet context");
      const backend = new CodexBackend(TEST_DIR);
      backend.cleanup(makeConfig());
      expect(existsSync(agentsMd)).toBe(false);
    });
  });
});
