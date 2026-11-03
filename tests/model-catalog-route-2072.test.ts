/**
 * #2072 part 3: GET /ui/models answers a Settings model field from the cached catalog (an instance's own account when
 * named) — the fleet's modelCatalogFor; it never probes. Bad input is refused before the fleet is asked.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleWebRequest } from "../src/web-api.js";
import { readGrokModelCache } from "../src/backend/grok-model-cache.js";
import { WEB_TOKEN_INVALID_MESSAGE } from "../src/web-auth.js";
import type { ModelOption } from "../src/backend/types.js";

function get(path: string, modelCatalogFor?: (b: string, i: string | null) => unknown, backendAvailabilityRows?: () => unknown[], cliModelCatalogFor?: (b: string, i: string | null) => unknown, extraContext: Record<string, unknown> = {}) {
  const token = "c".repeat(48);
  const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers: { host: "127.0.0.1:19280", "x-agend-token": token }, socket: { remoteAddress: "127.0.0.1", destroy() {} } });
  let status = 0, body = "";
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const res = Object.assign(new EventEmitter(), {
    headersSent: false, destroyed: false, writableEnded: false,
    setHeader() {}, getHeader() { return undefined; },
    writeHead: vi.fn((c: number): void => { status = c; res.headersSent = true; }),
    end: vi.fn((t = ""): void => { body = String(t); res.writableEnded = true; finish(); }),
    write() { return true; },
  });
  const ctx = { webToken: token as string | null, modelCatalogFor, backendAvailabilityRows, cliModelCatalogFor, logger: { info() {}, debug() {}, error() {}, warn() {} }, ...extraContext };
  const handled = handleWebRequest(req as never, res as never, new URL(path, "http://127.0.0.1:19280"), ctx as never);
  return { ctx, req, res, handled, finished, status: () => status, json: () => JSON.parse(body || "null") };
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

describe("GET /ui/models", () => {
  it("answers the fleet's cached catalog for that backend and instance", async () => {
    const catalog = vi.fn(() => [{ id: "opus", label: "opus" }]);
    const r = get("/ui/models?backend=claude-code&instance=w", catalog);
    await r.finished;
    expect(r.status()).toBe(200);
    expect(r.json()).toEqual({ backend: "claude-code", models: [{ id: "opus", label: "opus" }] });
    expect(catalog).toHaveBeenCalledWith("claude-code", "w");
    const r2 = get("/ui/models?backend=codex", catalog);
    await r2.finished;
    expect(catalog).toHaveBeenLastCalledWith("codex", null);
    expect(r2.status()).toBe(200);
  });
  it("refuses a missing or malformed backend without asking the fleet", async () => {
    const catalog = vi.fn(() => []);
    const cliCatalog = vi.fn(() => []);
    for (const q of ["", "?backend=", "?backend=Bad%20Name", "?backend=codex&instance="]) {
      const r = get(`/ui/models${q}`, catalog, undefined, cliCatalog);
      await r.finished;
      expect(r.status()).toBe(400);
    }
    expect(catalog).not.toHaveBeenCalled();
    expect(cliCatalog).not.toHaveBeenCalled();
  });
  it("a context without a fleet answers no models", async () => {
    const r = get("/ui/models?backend=codex");
    await r.finished;
    expect(r.json()).toEqual({ backend: "codex", models: [] });
  });
  it("provides version-compatible documented Claude choices only when its account cache is empty", async () => {
    const catalog = vi.fn(() => []);
    const r = get("/ui/models?backend=claude-code", catalog, () => [{ backend: "claude-code", version: "2.1.299" }]);
    await r.finished;
    expect(r.json()).toMatchObject({ backend: "claude-code", source: "official-catalog", models: expect.arrayContaining([{ id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }]) });
    expect(catalog).toHaveBeenCalledWith("claude-code", null);
  });
  it.each(["runtime=other", "refresh=true"])("rejects malformed options %s before requesting models", async query => {
    const catalog = vi.fn(() => []);
    const cliCatalog = vi.fn(() => []);
    const r = get(`/ui/models?backend=codex&${query}`, catalog, undefined, cliCatalog);
    await r.finished;
    expect(r.status()).toBe(400); expect(catalog).not.toHaveBeenCalled();
    expect(cliCatalog).not.toHaveBeenCalled();
  });
  it("keeps a Windows machine's inventory ahead of either host catalog", async () => {
    vi.stubEnv("AGEND_REMOTE_RUNTIME", "1");
    vi.stubEnv("AGEND_WINDOWS_CLI", "0");
    try {
      const machineId = "11111111-1111-4111-8111-111111111111";
      const catalog = vi.fn(() => [{ id: "grok-host", label: "Host account" }]);
      const cliCatalog = vi.fn(async () => [{ id: "grok-host-cache", label: "Host cache" }]);
      const machine = vi.fn(() => ({ id: machineId, status: "online", inventory: { home: "C:\\Fixture", clis: [{ id: "grok", modelsSource: "cli-cache", models: [{ id: "grok-windows", name: "Windows account" }] }] } }));
      const response = get(`/ui/models?backend=grok&runtime=windows&machineId=${machineId}&refresh=1`, catalog, undefined, cliCatalog, { runtimeCoordinator: () => ({ machine }) });
      await response.finished;
      expect(response.status()).toBe(200);
      expect(response.json()).toEqual({ backend: "grok", runtime: "windows", machineId, source: "cli-cache", models: [{ id: "grok-windows", label: "Windows account" }] });
      expect(machine).toHaveBeenCalledWith(machineId);
      expect(catalog).not.toHaveBeenCalled();
      expect(cliCatalog).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
});

describe("GET /ui/models reads Grok's own offline model cache", () => {
  let grokHome: string;
  const canary = "fixture-only-secret-must-never-leave-model-cache";
  beforeEach(() => {
    grokHome = mkdtempSync(join(tmpdir(), "agend-grok-model-route-"));
    vi.stubEnv("GROK_HOME", grokHome);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(grokHome, { recursive: true, force: true });
  });
  const seed = (ids: string[]) => writeFileSync(join(grokHome, "models_cache.json"), JSON.stringify({
    fetched_at: new Date().toISOString(),
    models: Object.fromEntries(ids.map(id => [id, {
      info: { id, name: id === "grok-4.7" ? "Grok 4.7" : id, description: `Cached ${id}`, hidden: false },
      api_key: canary, env_key: "FIXTURE_GROK_KEY", api_base_url: `https://example.invalid/${canary}`,
    }])),
  }), { mode: 0o600 });
  const readCli = () => vi.fn((_backend: string, _instance: string | null) => readGrokModelCache());

  it.each(["", "&refresh=1"])("keeps an existing account catalog on GET%s without reading the host CLI cache", async query => {
    seed(["grok-host-account"]);
    const models = [{ id: "grok-profile-account", label: "Instance account catalog" }];
    const catalog = vi.fn(() => models), cliCatalog = readCli();
    const response = get(`/ui/models?backend=grok&instance=agent-1${query}`, catalog, undefined, cliCatalog);
    await response.finished;
    expect(response.status()).toBe(200);
    expect(response.json()).toEqual({ backend: "grok", models });
    expect(catalog).toHaveBeenCalledWith("grok", "agent-1");
    expect(cliCatalog).not.toHaveBeenCalled();
  });

  it.each(["", "&refresh=1"])("serves the actual CLI cache projection only when AgEnD's catalog is empty on GET%s without exposing credential fields", async query => {
    seed(["grok-4.7", "grok-code-fast-1"]);
    const fallback = vi.fn(() => []);
    const cliCatalog = readCli();
    const response = get(`/ui/models?backend=grok&instance=agent-1${query}`, fallback, undefined, cliCatalog);
    await response.finished;
    expect(response.status()).toBe(200);
    expect(response.json()).toEqual({ backend: "grok", source: "cli-cache", models: [
      { id: "grok-4.7", label: "Grok 4.7", description: "Cached grok-4.7" },
      { id: "grok-code-fast-1", label: "grok-code-fast-1", description: "Cached grok-code-fast-1" },
    ] });
    expect(cliCatalog).toHaveBeenCalledWith("grok", "agent-1");
    expect(fallback).toHaveBeenCalledWith("grok", "agent-1");
    const output = JSON.stringify(response.json());
    for (const secret of [canary, "api_key", "env_key", "api_base_url", "FIXTURE_GROK_KEY"]) expect(output).not.toContain(secret);
  });

  it("rereads a changed CLI cache on refresh instead of returning the preceding snapshot", async () => {
    const fallback = vi.fn(() => []), cliCatalog = readCli();
    seed(["grok-4.7"]);
    const first = get("/ui/models?backend=grok", fallback, undefined, cliCatalog);
    await first.finished;
    expect(first.json().models.map((model: any) => model.id)).toEqual(["grok-4.7"]);
    seed(["grok-4.7", "grok-code-fast-1"]);
    const refreshed = get("/ui/models?backend=grok&refresh=1", fallback, undefined, cliCatalog);
    await refreshed.finished;
    expect(refreshed.status()).toBe(200);
    expect(refreshed.json().source).toBe("cli-cache");
    expect(refreshed.json().models.map((model: any) => model.id)).toEqual(["grok-4.7", "grok-code-fast-1"]);
    expect(cliCatalog).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveBeenNthCalledWith(1, "grok", null);
    expect(fallback).toHaveBeenNthCalledWith(2, "grok", null);
  });

  it.each(["missing", "empty"])("keeps the empty catalog when the CLI cache is %s", async cache => {
    if (cache === "empty") seed([]);
    const models: ModelOption[] = [];
    const fallback = vi.fn(() => models), cliCatalog = readCli();
    const response = get("/ui/models?backend=grok&instance=agent-1&refresh=1", fallback, undefined, cliCatalog);
    await response.finished;
    expect(response.status()).toBe(200);
    expect(response.json()).toEqual({ backend: "grok", models });
    expect(cliCatalog).toHaveBeenCalledWith("grok", "agent-1");
    expect(fallback).toHaveBeenCalledWith("grok", "agent-1");
  });

  it("waits for asynchronous file choices while an unrelated cached request can finish", async () => {
    const pending = deferred<ModelOption[]>();
    const cliCatalog = vi.fn(() => pending.promise);
    const response = get("/ui/models?backend=grok", () => [], undefined, cliCatalog);
    expect(response.handled).toBe(true);
    expect(cliCatalog).toHaveBeenCalledWith("grok", null);
    expect(response.res.writeHead).not.toHaveBeenCalled();
    expect(response.res.end).not.toHaveBeenCalled();

    const other = get("/ui/models?backend=codex", () => [{ id: "codex-ready", label: "Ready" }]);
    await other.finished;
    expect(other.status()).toBe(200);
    expect(other.json().models).toEqual([{ id: "codex-ready", label: "Ready" }]);
    expect(response.status()).toBe(0);

    pending.resolve([{ id: "grok-ready", label: "Ready after read" }]);
    await response.finished;
    expect(response.status()).toBe(200);
    expect(response.json()).toEqual({ backend: "grok", source: "cli-cache", models: [{ id: "grok-ready", label: "Ready after read" }] });
    expect(response.res.end).toHaveBeenCalledOnce();
  });

  it("contains an unexpected asynchronous callback rejection without leaking its error", async () => {
    const cliCatalog = vi.fn(async () => { throw new Error(canary); });
    const response = get("/ui/models?backend=grok", () => [], undefined, cliCatalog);
    await response.finished;
    expect(response.status()).toBe(503);
    expect(response.json()).toEqual({ error: "CLI model cache unavailable" });
    expect(JSON.stringify(response.json())).not.toContain(canary);
    expect(response.res.end).toHaveBeenCalledOnce();
  });

  it("does not return choices if authorization is revoked while a read is pending", async () => {
    const pending = deferred<ModelOption[]>();
    const response = get("/ui/models?backend=grok", () => [], undefined, () => pending.promise);
    expect(response.status()).toBe(0);
    response.ctx.webToken = null;
    pending.resolve([{ id: "grok-private", label: "Must not return" }]);
    await response.finished;
    expect(response.status()).toBe(401);
    expect(response.json()).toEqual({ error: WEB_TOKEN_INVALID_MESSAGE });
    expect(JSON.stringify(response.json())).not.toContain("grok-private");
  });

  it.each(["destroyed", "writableEnded"] as const)("does not write a late async result to a response marked %s", async state => {
    const pending = deferred<ModelOption[]>();
    const response = get("/ui/models?backend=grok", () => [], undefined, () => pending.promise);
    response.res[state] = true;
    pending.resolve([{ id: "grok-late", label: "Late result" }]);
    await nextTurn();
    expect(response.res.writeHead).not.toHaveBeenCalled();
    expect(response.res.end).not.toHaveBeenCalled();
    expect(response.status()).toBe(0);
  });
});

describe("GET /ui/backends names the fleet default backend (#2098 review P3-3)", () => {
  const backends = (fleetConfig: unknown) => {
    const token = "c".repeat(48);
    const req = Object.assign(new EventEmitter(), { method: "GET", url: "/ui/backends", headers: { host: "127.0.0.1:19280", "x-agend-token": token }, socket: { remoteAddress: "127.0.0.1", destroy() {} } });
    let body = "";
    const res = Object.assign(new EventEmitter(), { headersSent: false, setHeader() {}, getHeader() { return undefined; }, writeHead() {}, end(t = "") { body = String(t); }, write() { return true; } });
    handleWebRequest(req as never, res as never, new URL("/ui/backends", "http://127.0.0.1:19280"),
      { webToken: token, fleetConfig, backendAvailabilityRows: () => [{ backend: "codex", state: "usable", path: "/bin/codex", minVersion: null }], logger: { info() {}, debug() {}, error() {}, warn() {} } } as never);
    return JSON.parse(body);
  };
  it("the configured default, else claude-code", () => {
    expect(backends({ defaults: { backend: "codex" }, instances: {} }).defaultBackend).toBe("codex");
    expect(backends({ instances: {} }).defaultBackend).toBe("claude-code");
  });
});
