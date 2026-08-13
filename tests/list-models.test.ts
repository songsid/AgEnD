import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { outboundHandlers } from "../src/outbound-handlers.js";

/**
 * `list_models` exists so an agent stops guessing model ids. The distinction it
 * has to get right is scope: an instance on a custom provider can offer a
 * different catalog than the account, and answering such an instance with the
 * account list would name models its CLI rejects.
 *
 * These drive the real FleetManager against a real cli-env cache file; the only
 * thing stubbed is the live probe, which would otherwise spawn CLIs.
 */
let home: string;
let dataDir: string;
let codexHome: string;
const realHome = process.env.AGEND_HOME;
const realCodexHome = process.env.CODEX_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agend-listmodels-"));
  process.env.AGEND_HOME = home;
  dataDir = mkdtempSync(join(tmpdir(), "agend-listmodels-data-"));
  // CodexBackend.listModels() reads models_cache.json and falls back to the
  // SHARED codex home — without this a test would read the developer's real
  // ~/.codex and pass or fail based on their account. Same class of bug as #357.
  codexHome = mkdtempSync(join(tmpdir(), "agend-listmodels-codex-"));
  process.env.CODEX_HOME = codexHome;
});
afterEach(() => {
  if (realHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = realHome;
  if (realCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = realCodexHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
});

/** Seed the same cache file the startup probe writes. */
function seedCliEnv(backend: string, models: Array<{ id: string; label?: string }>, opts: { currentModel?: string; ageMs?: number } = {}) {
  const dir = join(home, "cli-env");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${backend}.json`), JSON.stringify({
    backend,
    models,
    currentModel: opts.currentModel,
    probedAt: Date.now() - (opts.ageMs ?? 0),
  }));
}

function makeFleet(instances: Record<string, unknown> = {}, defaults: Record<string, unknown> = {}) {
  const fm = new FleetManager(dataDir);
  (fm as any).fleetConfig = { defaults: { backend: "claude-code", ...defaults }, channel: {}, instances };
  // Never spawn a real CLI from a test.
  (fm as any).probeBackend = vi.fn().mockResolvedValue(null);
  return fm;
}

describe("listModelCatalog — global scope", () => {
  it("serves the account catalog from the startup probe cache", async () => {
    seedCliEnv("kiro-cli", [{ id: "auto" }, { id: "claude-opus-5" }], { currentModel: "auto" });
    const fm = makeFleet();

    const r = await fm.listModelCatalog({ backend: "kiro-cli" });

    expect(r.scope).toBe("global");
    expect(r.source).toBe("cache");
    expect(r.models.map(m => m.id)).toEqual(["auto", "claude-opus-5"]);
    expect(r.current_model).toBe("auto");
    expect(r.probed_at).toBeTruthy();
  });

  it("falls back to the fleet default backend when none is named", async () => {
    seedCliEnv("claude-code", [{ id: "sonnet" }]);
    const fm = makeFleet();
    expect((await fm.listModelCatalog()).backend).toBe("claude-code");
  });

  it("ignores a cache past its 24h TTL rather than serving stale ids", async () => {
    seedCliEnv("grok", [{ id: "grok-4.6" }], { ageMs: 25 * 60 * 60 * 1000 });
    const fm = makeFleet();

    const r = await fm.listModelCatalog({ backend: "grok" });

    // probeBackend is stubbed to fail, so this proves the stale file was not used.
    expect(r.source).toBe("fallback");
    expect(r.models).toEqual([]);
  });

  it("reports an unlistable backend instead of throwing", async () => {
    const fm = makeFleet();
    const r = await fm.listModelCatalog({ backend: "nonexistent-cli" });

    expect(r.source).toBe("fallback");
    expect(r.models).toEqual([]);
    // The caller can still set a model by name, and must be told so.
    expect(r.note).toMatch(/passed through/i);
  });
});

describe("listModelCatalog — instance scope", () => {
  it("reads the catalog through the instance when the backend can list per-instance", async () => {
    // claude-code exposes a static alias set, so instance scope resolves with no
    // probe at all — and the answer is genuinely instance-accurate.
    const fm = makeFleet({ alpha: { working_directory: "/tmp", backend: "claude-code", model: "opus" } });

    const r = await fm.listModelCatalog({ instanceName: "alpha" });

    expect(r.instance).toBe("alpha");
    expect(r.current_model).toBe("opus");
    expect(r.scope).toBe("instance");
    expect(r.models.map(m => m.id)).toContain("opus");
  });

  it("labels a fallback to the account catalog as global, not instance", async () => {
    // The honesty case: asked about an instance whose backend cannot be
    // enumerated, so the list is account-wide and must say so.
    seedCliEnv("nonexistent-cli", [{ id: "whatever" }]);
    const fm = makeFleet({ alpha: { working_directory: "/tmp", backend: "nonexistent-cli", model: "whatever" } });

    const r = await fm.listModelCatalog({ instanceName: "alpha" });

    expect(r.instance).toBe("alpha");
    // Must NOT claim instance scope for a list it did not read per-instance.
    expect(r.scope).toBe("global");
    expect(r.note).toMatch(/account catalog/i);
  });

  it("warns that a custom-provider instance may not match the account catalog", async () => {
    seedCliEnv("codex", [{ id: "gpt-5.6-sol" }]);
    const fm = makeFleet({
      glm: {
        working_directory: "/tmp",
        backend: "codex",
        backend_options: { codex: { provider: "glm" } },
      },
    });

    const r = await fm.listModelCatalog({ instanceName: "glm" });

    // Naming the provider is the point: a catalog that silently belongs to a
    // different provider is exactly the trap this tool exists to prevent.
    expect(r.note).toMatch(/glm/);
    expect(r.note).toMatch(/differ|NOT match/i);
  });

  it("inherits a custom provider from fleet defaults too", async () => {
    seedCliEnv("codex", [{ id: "gpt-5.6-sol" }]);
    const fm = makeFleet(
      { plain: { working_directory: "/tmp", backend: "codex" } },
      { backend_options: { codex: { provider: "glm" } } },
    );
    expect((await fm.listModelCatalog({ instanceName: "plain" })).note).toMatch(/glm/);
  });
});

describe("list_models handler", () => {
  const meta = { instanceName: "caller", requestId: 1, fleetRequestId: undefined, senderSessionName: undefined };

  function call(ctx: unknown, args: Record<string, unknown>) {
    return new Promise<{ result: any; error?: string }>(res => {
      void outboundHandlers.get("list_models")!(ctx as any, args, (result, error) => res({ result, error }), meta as any);
    });
  }

  const baseCtx = (over: Record<string, unknown> = {}) => ({
    fleetConfig: { defaults: {}, instances: { alpha: {} } },
    classicChannels: null,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    listModelCatalog: vi.fn().mockResolvedValue({ backend: "codex", scope: "global", current_model: null, models: [], source: "fallback" }),
    ...over,
  });

  it("passes both arguments through to the facade", async () => {
    const ctx = baseCtx();
    const { error } = await call(ctx, { backend: "codex", instance_name: "alpha" });
    expect(error).toBeUndefined();
    expect(ctx.listModelCatalog).toHaveBeenCalledWith({ backend: "codex", instanceName: "alpha" });
  });

  it("rejects an unknown instance instead of silently answering for the default backend", async () => {
    const ctx = baseCtx();
    const { result, error } = await call(ctx, { instance_name: "ghost" });
    expect(result).toBeNull();
    expect(error).toMatch(/not found/i);
    expect(ctx.listModelCatalog).not.toHaveBeenCalled();
  });

  it("accepts a classic-channel instance", async () => {
    const ctx = baseCtx({
      classicChannels: { getAll: () => [{ instanceName: "classic-x" }] },
    });
    const { error } = await call(ctx, { instance_name: "classic-x" });
    expect(error).toBeUndefined();
  });

  it("surfaces a facade failure as an error rather than a broken result", async () => {
    const ctx = baseCtx({ listModelCatalog: vi.fn().mockRejectedValue(new Error("boom")) });
    const { result, error } = await call(ctx, {});
    expect(result).toBeNull();
    expect(error).toMatch(/boom/);
  });
});

describe("tool registration", () => {
  it("is exposed to general instances", async () => {
    const { TOOLS, TOOL_SETS } = await import("../src/channel/mcp-tools.js");
    expect(TOOLS.some(t => t.name === "list_models")).toBe(true);
    expect(TOOL_SETS.general).toContain("list_models");
  });
});
