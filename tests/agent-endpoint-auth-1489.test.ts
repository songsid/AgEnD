/**
 * #1489: POST /agent must validate the instance token BEFORE reading the body,
 * must reject bodies exceeding MAX_AGENT_BODY (512 KiB), and must cross-check
 * the body's instance against the header's instance.
 *
 * Each assertion is accompanied by a reverse-mutation note demonstrating how
 * removing the protected branch makes the assertion fail.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { handleAgentRequest } from "../src/agent-endpoint.js";
import { agentTokenHeader } from "../src/agent-token-header.js";

// ── helpers ─────────────────────────────────────────────────────────────────

function makeCtx(dataDir: string, instanceName: string, token: string) {
  const instanceDir = join(dataDir, "instances", instanceName);
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(join(instanceDir, "agent.token"), token, { mode: 0o600 });
  return {
    dataDir,
    fleetConfig: { defaults: {}, instances: { [instanceName]: {} } },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as any;
}

/**
 * Minimal stub that behaves like an IncomingMessage.
 * We track whether the "data" listener was ever attached to detect body reads.
 */
function makeRequest(opts: {
  method?: string;
  headers?: Record<string, string>;
}): IncomingMessage & {
  dataListenerAttached: () => boolean;
  resume: () => void;
  pushData: (chunk: Buffer) => void;
  pushEnd: () => void;
} {
  const emitter = new EventEmitter();
  let dataAttached = false;
  const origOn = emitter.on.bind(emitter);
  const req = {
    method: opts.method ?? "POST",
    headers: opts.headers ?? {},
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === "data") dataAttached = true;
      origOn(event, listener);
      return this;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      emitter.off(event, listener);
      return this;
    },
    resume() { /* drain no-op */ },
    destroy() { emitter.emit("close"); },
    dataListenerAttached: () => dataAttached,
    pushData(chunk: Buffer) { emitter.emit("data", chunk); },
    pushEnd() { emitter.emit("end"); },
  } as any;
  return req;
}

function makeResponse(): ServerResponse & { status: number | null; body: string } {
  const res = {
    status: null as number | null,
    body: "",
    writeHead(code: number) { this.status = code; },
    end(data?: string) { if (data) this.body = data; },
  } as any;
  return res;
}

// ── 1. No token header → 401, body stream not consumed ──────────────────────
//
// Reverse mutation: removing the early `if (!headerValue)` guard makes this
// test fail because the handler attaches a "data" listener before rejecting.

describe("POST /agent: token-first validation (#1489)", () => {
  it("returns 401 and does NOT attach a data listener when no token header is present", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-ep-notoken-"));
    try {
      const ctx = makeCtx(dataDir, "dev", "test-token-not-a-secret");
      const req = makeRequest({ headers: {} });
      const res = makeResponse();

      handleAgentRequest(req, res, ctx);
      await new Promise(r => setTimeout(r, 20));

      expect(res.status).toBe(401);
      // Body stream must NOT have been touched before auth
      expect(req.dataListenerAttached()).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // ── 2. Wrong token → 401, body stream not consumed ──────────────────────
  //
  // Reverse mutation: removing the `if (!verifyInstanceToken(...))` guard
  // makes this test fail because the handler proceeds past auth.

  it("returns 401 and does NOT attach a data listener when token is wrong", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-ep-badtoken-"));
    try {
      const ctx = makeCtx(dataDir, "dev", "test-token-correct-value");
      const req = makeRequest({
        headers: { "x-agend-instance-token": agentTokenHeader("dev", "test-token-wrong-value") },
      });
      const res = makeResponse();

      handleAgentRequest(req, res, ctx);
      await new Promise(r => setTimeout(r, 20));

      expect(res.status).toBe(401);
      expect(req.dataListenerAttached()).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // ── 3. Body exceeds 512 KiB → 413 ──────────────────────────────────────
  //
  // Reverse mutation: removing the `readBoundedWebBody` call (reverting to
  // unbounded `req.on("data")` accumulation) makes this test fail because
  // the handler never rejects oversized payloads.

  it("returns 413 when the body exceeds 512 KiB", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-ep-toolarge-"));
    try {
      const ctx = makeCtx(dataDir, "dev", "test-token-not-a-secret");
      const req = makeRequest({
        headers: { "x-agend-instance-token": agentTokenHeader("dev", "test-token-not-a-secret") },
      });
      const res = makeResponse();

      handleAgentRequest(req, res, ctx);
      const big = Buffer.alloc(513 * 1024, 0x61); // 513 KiB > 512 KiB limit
      req.pushData(big);
      req.pushEnd();
      await new Promise(r => setTimeout(r, 50));

      expect(res.status).toBe(413);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // ── 4. Header token for A, body says instance B → 401, no op executed ──
  //
  // Reverse mutation: removing the `if (instance !== instanceFromHeader)` guard
  // (e.g. `if (false)`) makes this test fail because the handler proceeds to
  // dispatch on instance B using A's token.

  it("returns 401 when body instance does not match header instance", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-ep-mismatch-"));
    try {
      // Set up valid token for instance "alice"
      const ctx = makeCtx(dataDir, "alice", "test-token-not-a-secret");
      const dispatch = vi.spyOn(
        await import("../src/agent-endpoint.js"),
        "dispatchAgentOperation",
      );

      const req = makeRequest({
        headers: {
          "x-agend-instance-token": agentTokenHeader("alice", "test-token-not-a-secret"),
        },
      });
      const res = makeResponse();

      // Body claims instance "bob" — should be rejected
      const body = JSON.stringify({ instance: "bob", op: "list_instances", args: {} });
      handleAgentRequest(req, res, ctx);
      req.pushData(Buffer.from(body, "utf8"));
      req.pushEnd();
      await new Promise(r => setTimeout(r, 50));

      expect(res.status).toBe(401);
      // No op must have been dispatched
      expect(dispatch).not.toHaveBeenCalled();
      dispatch.mockRestore();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // ── 5. Non-ASCII instance name (P1: encodeURIComponent round-trip) ──────
  //
  // This test calls agentTokenHeader() (the real agent-cli export) with a
  // non-ASCII instance name and makes two verifiable assertions:
  //
  // (a) The header value is ASCII-safe (all code points <= 0x7F). This is
  //     required because HTTP/1.1 headers must be Latin-1 and Node's
  //     http.request throws ERR_INVALID_CHAR on non-ASCII values. Removing
  //     encodeURIComponent from agentTokenHeader() produces raw UTF-8 in
  //     the header string, which fails this assertion.
  //
  // (b) The endpoint authenticates with the encoded header — proving the
  //     server-side decodeURIComponent restores the original name for lookup.
  //
  // Reverse mutation: change `encodeURIComponent(instance)` to `instance`
  // in agentTokenHeader() → assertion (a) fails because the Chinese
  // characters are codepoints > 0x7F.

  it("agentTokenHeader produces ASCII-safe header and endpoint authenticates non-ASCII instance", async () => {
    const instanceName = "\u9B25\u7834\u4F01\u5283-7393"; // 鬥破企劃-7393
    const token = "test-token-not-a-secret"; // gitleaks:allow
    const dataDir = mkdtempSync(join(tmpdir(), "agend-ep-nonascii-"));
    try {
      // (a) Header must be ASCII-safe — fails if encodeURIComponent is removed.
      const headerValue = agentTokenHeader(instanceName, token);
      expect(
        [...headerValue].every(c => c.charCodeAt(0) <= 0x7f),
        `header must be ASCII-safe but got non-ASCII chars in: ${headerValue}`,
      ).toBe(true);

      // (b) Endpoint authenticates using the encoded header.
      const ctx = makeCtx(dataDir, instanceName, token);
      const req = makeRequest({
        headers: { "x-agend-instance-token": headerValue },
      });
      const res = makeResponse();

      const body = JSON.stringify({ instance: instanceName, op: "list_instances", args: {} });
      handleAgentRequest(req, res, ctx);
      req.pushData(Buffer.from(body, "utf8"));
      req.pushEnd();
      await new Promise(r => setTimeout(r, 50));

      // Auth passed: not 401.
      expect(res.status).not.toBe(401);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // ── 6. Valid token + body within limit → 200 with op result ─────────────
  //
  // Regression: ensure the fix does not break legitimate requests.
  // Reverse mutation: making the handler always return 500 would fail this
  // test because we assert status 200 and a non-empty JSON result.

  it("returns 200 with a JSON result for a valid token and well-formed body", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-ep-ok-"));
    try {
      const ctx = makeCtx(dataDir, "dev", "test-token-not-a-secret");
      // Minimal context for dispatchAgentOperation("dev", "send", {instance_name: "target", message: "hi"})
      ctx.fleetConfig = {
        defaults: {},
        instances: { dev: { tool_set: "worker" }, target: {} },
      };
      ctx.instanceIpcClients = new Map([["target", { connected: true }]]);
      ctx.sessionRegistry = new Map();
      ctx.lifecycle = { daemons: new Map() };
      ctx.getInstanceStatus = () => "running";
      ctx.getDaemonBootId = () => "boot-1";
      ctx.admitDurableDelivery = vi.fn(() => ({
        deliveryId: "d1", state: "queued", duplicate: false,
      }));
      ctx.eventLog = { logActivity: vi.fn() };
      ctx.queueMirrorMessage = vi.fn();

      const body = JSON.stringify({
        instance: "dev",
        op: "send",
        args: { instance_name: "target", message: "hello" },
      });
      const req = makeRequest({
        headers: { "x-agend-instance-token": agentTokenHeader("dev", "test-token-not-a-secret") },
      });
      const res = makeResponse();

      handleAgentRequest(req, res, ctx);
      req.pushData(Buffer.from(body, "utf8"));
      req.pushEnd();
      await new Promise(r => setTimeout(r, 50));

      expect(res.status).toBe(200);
      // Response must be non-empty JSON (actual op result)
      const parsed: unknown = JSON.parse(res.body);
      expect(parsed).toMatchObject({ operation_id: expect.any(String) });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
