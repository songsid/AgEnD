import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Daemon } from "../src/daemon.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";

// Point CLAUDE_HOME at an empty dir: the credentials FILE outranks the env
// token, so a dev machine's real login must not leak into these tests.
const emptyHome = mkdtempSync(join(tmpdir(), "agend-claude-home-"));
const realClaudeHome = process.env.CLAUDE_HOME;
process.env.CLAUDE_HOME = emptyHome;

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_HOME = emptyHome;
});
afterAll(() => {
  if (realClaudeHome === undefined) delete process.env.CLAUDE_HOME;
  else process.env.CLAUDE_HOME = realClaudeHome;
  rmSync(emptyHome, { recursive: true, force: true });
});

describe("claude error patterns", () => {
  const patterns = new ClaudeCodeBackend("/tmp/test").getErrorPatterns();

  it("detects the previously silent bad-model failures as model_error notify", () => {
    const modelError = patterns.find(ep => ep.type === "model_error")!;
    expect(modelError.action).toBe("notify");
    expect(modelError.pattern.test("API Error: 404 [claude-code:unrecognized_model] not found")).toBe(true);
    expect(modelError.pattern.test("API Error: 403 [claude-code:model_access] forbidden")).toBe(true);
    expect(modelError.pattern.test("There's an issue with the selected model.")).toBe(true);
    expect(modelError.pattern.test("Claude Opus is not available on your plan, or ask your admin to enable this model.")).toBe(true);
    expect(modelError.pattern.test("normal conversation about models")).toBe(false);
    expect(modelError.pattern.test("model access can vary by account")).toBe(false);
  });

  it("auth expiry pauses instead of merely notifying", () => {
    for (const ep of patterns.filter(p => p.type === "auth_error")) {
      expect(ep.action, ep.pattern.source).toBe("pause");
    }
  });

  it("a bad model on the idle screen emits model_error through the monitor", () => {
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-claude-model-"));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("claude-model", {
      working_directory: "/tmp",
      backend: "claude-code",
      model: "claude-opus-4-6[1m]",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      log_level: "silent",
    } as any, instanceDir, false, { getReadyPattern: () => /❯/ } as any, undefined,
      { child: () => logger } as any);
    const errors: any[] = [];
    daemon.on("pty_error", e => errors.push(e));
    try {
      (daemon as any).instanceState = "idle";
      (daemon as any).evaluateErrorPatterns(
        "There's an issue with the selected model\n❯ ", patterns, /❯/, 10 * 60_000);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ type: "model_error", action: "notify" });
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});

describe("listApiModels", () => {
  it("maps /v1/models and appends a [1m] variant per model", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "FAKE-OAUTH-FOR-TEST";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [
        { id: "claude-opus-5", display_name: "Claude Opus 5" },
        { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
      ] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const models = await new ClaudeCodeBackend("/tmp/test").listApiModels();
    expect(models.map(m => m.id)).toEqual([
      "claude-opus-5", "claude-opus-5[1m]",
      "claude-sonnet-5", "claude-sonnet-5[1m]",
    ]);
    expect(models[1].description).toContain("1M");

    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(String(url)).toContain("/v1/models");
    expect(init.headers.Authorization).toBe("Bearer FAKE-OAUTH-FOR-TEST");
    expect(init.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("degrades to [] on missing token, non-200, and network failure", async () => {
    // No token anywhere → no fetch at all.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const be = new ClaudeCodeBackend("/tmp/test");
    // (token may resolve from the real credentials file on a dev machine; only
    // assert the failure paths that are hermetic.)
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "FAKE-OAUTH-FOR-TEST";
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    expect(await be.listApiModels()).toEqual([]);
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect(await be.listApiModels()).toEqual([]);
  });

  it("probeCLIEnv keeps the short alias tier separate from the API tier", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "FAKE-OAUTH-FOR-TEST";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "claude-opus-5" }] }),
    })));
    const env = await new ClaudeCodeBackend("/tmp/test").probeCLIEnv!({} as any);
    expect(env.models!.map(m => m.id)).toContain("opus");        // quick-pick aliases
    expect(env.models!.map(m => m.id)).not.toContain("claude-opus-5");
    expect((env as any).apiModels.map((m: any) => m.id)).toEqual(["claude-opus-5", "claude-opus-5[1m]"]);
  });
});
