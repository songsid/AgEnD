/**
 * #2072 part 3: GET /ui/models answers a Settings model field from the cached catalog (an instance's own account when
 * named) — the fleet's modelCatalogFor; it never probes. Bad input is refused before the fleet is asked.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { handleWebRequest } from "../src/web-api.js";

function get(path: string, modelCatalogFor?: (b: string, i: string | null) => unknown) {
  const token = "c".repeat(48);
  const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers: { host: "127.0.0.1:19280", "x-agend-token": token }, socket: { remoteAddress: "127.0.0.1", destroy() {} } });
  let status = 0, body = "";
  const res = Object.assign(new EventEmitter(), { headersSent: false, setHeader() {}, getHeader() { return undefined; }, writeHead(c: number) { status = c; }, end(t = "") { body = String(t); }, write() { return true; } });
  handleWebRequest(req as never, res as never, new URL(path, "http://127.0.0.1:19280"), { webToken: token, modelCatalogFor, logger: { info() {}, debug() {}, error() {}, warn() {} } } as never);
  return { status: () => status, json: () => JSON.parse(body || "null") };
}

describe("GET /ui/models", () => {
  it("answers the fleet's cached catalog for that backend and instance", async () => {
    const catalog = vi.fn(() => [{ id: "opus", label: "opus" }]);
    const r = get("/ui/models?backend=claude-code&instance=w", catalog);
    await new Promise(r2 => setTimeout(r2, 10));
    expect(r.status()).toBe(200);
    expect(r.json()).toEqual({ backend: "claude-code", models: [{ id: "opus", label: "opus" }] });
    expect(catalog).toHaveBeenCalledWith("claude-code", "w");
    const r2 = get("/ui/models?backend=codex", catalog);
    await new Promise(r3 => setTimeout(r3, 10));
    expect(catalog).toHaveBeenLastCalledWith("codex", null);
    expect(r2.status()).toBe(200);
  });
  it("refuses a missing or malformed backend without asking the fleet", async () => {
    const catalog = vi.fn(() => []);
    for (const q of ["", "?backend=", "?backend=Bad%20Name", "?backend=codex&instance="]) {
      const r = get(`/ui/models${q}`, catalog);
      await new Promise(r2 => setTimeout(r2, 5));
      expect(r.status()).toBe(400);
    }
    expect(catalog).not.toHaveBeenCalled();
  });
  it("a context without a fleet answers no models", async () => {
    const r = get("/ui/models?backend=codex");
    await new Promise(r2 => setTimeout(r2, 10));
    expect(r.json()).toEqual({ backend: "codex", models: [] });
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
