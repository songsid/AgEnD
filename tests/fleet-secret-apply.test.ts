import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function manager(type: "discord" | "telegram" = "discord") {
  const dir = mkdtempSync(join(tmpdir(), "agend-fleet-secret-")); dirs.push(dir);
  const fm = new FleetManager(dir) as any;
  fm.fleetConfig = {
    channels: [{ id: "primary", type, mode: "topic", bot_token_env: type === "telegram" ? "TELEGRAM_BOT_TOKEN" : "DISCORD_BOT_TOKEN", group_id: "1", access: { mode: "open", allowed_users: [] } }],
    defaults: {}, instances: {},
  };
  return { fm, dir };
}

function fakeAdapter(id = "primary", type = "telegram") {
  const adapter = new EventEmitter() as any;
  adapter.id = id;
  adapter.type = type;
  adapter.topology = "topics";
  adapter.stop = vi.fn(async () => {});
  adapter.start = vi.fn(async () => {});
  return adapter;
}

async function verified(fm: any, input: Partial<{ sessionBinding: string; idempotencyKey: string; secret: string }> = {}) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ id: "bot-1", username: "agend" }) })));
  return fm.verifyConnectionSecret({
    connectionId: "primary",
    secret: input.secret ?? "new-token",
    sessionBinding: input.sessionBinding ?? "session",
    idempotencyKey: input.idempotencyKey ?? `key-${Math.random()}`,
  });
}

describe("FleetManager connection secret apply", () => {
  it("verifies before creating a challenge and applies through the fenced job", async () => {
    const { fm, dir } = manager();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ id: "bot-1", username: "agend" }) })));
    const verified = await fm.verifyConnectionSecret({ connectionId: "primary", secret: "new-token", sessionBinding: "session", idempotencyKey: "key_test" });
    expect(verified.ok).toBe(true);
    const challenge = verified.verification_id;
    fm.rebuildAdapterForSecret = vi.fn(async () => true);
    const accepted = fm.startConnectionSecretApply({ connectionId: "primary", verificationId: challenge, sessionBinding: "session", idempotencyKey: "key_test" });
    expect(accepted.job.result).toBe("applying");
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      if (accepted.job.status === "done") break;
    }
    expect(accepted.job.result).toBe("applied");
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("DISCORD_BOT_TOKEN=new-token");
    expect(JSON.stringify(accepted.job)).not.toContain("new-token");
  });

  it("rejects a stale generation and leaves the secret file untouched", async () => {
    const { fm, dir } = manager();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ id: "bot-1", username: "agend" }) })));
    const verified = await fm.verifyConnectionSecret({ connectionId: "primary", secret: "new-token", sessionBinding: "session", idempotencyKey: "key_test" });
    fm.connectionSecretGenerations.set("primary", 9);
    const result = fm.startConnectionSecretApply({ connectionId: "primary", verificationId: verified.verification_id, sessionBinding: "session", idempotencyKey: "key_test" });
    expect(result).toEqual({ error: expect.stringContaining("does not match") });
    expect(() => readFileSync(join(dir, ".env"), "utf8")).toThrow();
  });

  it("restores the previous secret when rebuilding the adapter fails", async () => {
    const { fm, dir } = manager();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ id: "bot-1", username: "agend" }) })));
    const verified = await fm.verifyConnectionSecret({ connectionId: "primary", secret: "new-token", sessionBinding: "session", idempotencyKey: "key_test" });
    let calls = 0;
    fm.rebuildAdapterForSecret = vi.fn(async () => { calls++; if (calls === 1) throw new Error("connect failed"); return true; });
    const accepted = fm.startConnectionSecretApply({ connectionId: "primary", verificationId: verified.verification_id, sessionBinding: "session", idempotencyKey: "key_test" });
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      if (accepted.job.status === "done") break;
    }
    expect(accepted.job.result).toBe("rolled_back");
    expect(() => readFileSync(join(dir, ".env"), "utf8")).toThrow();
  });

  it("rolls back when a polling adapter never emits started", async () => {
    vi.useFakeTimers();
    const { fm, dir } = manager("telegram");
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "old-token";
    writeFileSync(join(dir, ".env"), "TELEGRAM_BOT_TOKEN=old-token\n", { mode: 0o600 });

    const old = fakeAdapter();
    fm.adapters.set("primary", old);
    fm.adapter = old;
    fm.adapterState.set("primary", { status: "connected", retryCount: 0 });
    let starts = 0;
    fm.startSingleAdapter = vi.fn(async (_fleet: unknown, _channel: unknown, onStarted?: () => void) => {
      const fresh = fakeAdapter();
      fm.adapters.set("primary", fresh);
      fm.adapter = fresh;
      starts++;
      // The first (new token) adapter is deliberately silent. The second one
      // is the restored token and proves that rollback can reconnect.
      if (starts === 2) queueMicrotask(() => onStarted?.());
    });

    const job = {
      id: "secret_apply_test",
      connectionId: "primary",
      idempotencyKey: "key_started",
      result: "applying",
      status: "running",
      startedAt: Date.now(),
    };
    fm.connectionSecretJobs.set(job.id, job);
    fm.connectionSecretJobSession.set(job.id, "session");
    fm.connectionSecretInFlight.set("primary", job.id);
    const running = fm.runConnectionSecretApply(job, "new-token");
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.runAllTicks();
    await running;

    expect(job.result).toBe("rolled_back");
    expect(job.status).toBe("done");
    expect(starts).toBe(2);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("TELEGRAM_BOT_TOKEN=old-token\n");
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
  });

  it("rejects a challenge used from a different session", async () => {
    const { fm } = manager();
    const verifiedResult = await verified(fm, { idempotencyKey: "key_session" });
    fm.rebuildAdapterForSecret = vi.fn(async () => true);
    const result = fm.startConnectionSecretApply({
      connectionId: "primary",
      verificationId: verifiedResult.verification_id,
      sessionBinding: "other-session",
      idempotencyKey: "key_session",
    });
    expect(result).toEqual({ error: expect.stringContaining("does not match") });
  });

  it("rejects an expired verification challenge", async () => {
    const { fm } = manager();
    const verifiedResult = await verified(fm, { idempotencyKey: "key_expiry" });
    fm.connectionSecretChallenges.get(verifiedResult.verification_id).expiresAt = Date.now() - 1;
    fm.rebuildAdapterForSecret = vi.fn(async () => true);
    const result = fm.startConnectionSecretApply({
      connectionId: "primary",
      verificationId: verifiedResult.verification_id,
      sessionBinding: "session",
      idempotencyKey: "key_expiry",
    });
    expect(result).toEqual({ error: expect.stringContaining("expired") });
  });

  it("rejects a challenge bound to a different connection", async () => {
    const { fm } = manager();
    fm.fleetConfig.channels.push({ id: "secondary", type: "discord", mode: "topic", bot_token_env: "OTHER_BOT_TOKEN", group_id: "2", access: { mode: "open", allowed_users: [] } });
    const verifiedResult = await verified(fm, { idempotencyKey: "key_connection" });
    fm.rebuildAdapterForSecret = vi.fn(async () => true);
    const result = fm.startConnectionSecretApply({
      connectionId: "secondary",
      verificationId: verifiedResult.verification_id,
      sessionBinding: "session",
      idempotencyKey: "key_connection",
    });
    expect(result).toEqual({ error: expect.stringContaining("does not match") });
  });

  it("consumes a verification challenge so it cannot be replayed", async () => {
    const { fm } = manager();
    const verifiedResult = await verified(fm, { idempotencyKey: "key_replay" });
    fm.runConnectionSecretApply = vi.fn(async () => {});
    const input = {
      connectionId: "primary",
      verificationId: verifiedResult.verification_id,
      sessionBinding: "session",
      idempotencyKey: "key_replay",
    };
    const accepted = fm.startConnectionSecretApply(input);
    expect(accepted.job.result).toBe("applying");
    // Bypass the idempotent job lookup: this models a retry after the original
    // job record has been retired and asserts that the one-time challenge is
    // still consumed.
    fm.connectionSecretJobs.clear();
    fm.connectionSecretJobSession.clear();
    fm.connectionSecretInFlight.clear();
    const replay = fm.startConnectionSecretApply(input);
    expect(replay).toEqual({ error: expect.stringContaining("expired") });
  });

  it("does not issue a challenge when the provider rejects the token", async () => {
    const { fm } = manager();
    const fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: "Unauthorized" }) }));
    vi.stubGlobal("fetch", fetch);
    const result = await fm.verifyConnectionSecret({
      connectionId: "primary",
      secret: "rejected-token",
      sessionBinding: "session",
      idempotencyKey: "key_provider",
    });
    expect(result).toEqual({ ok: false, error: "provider rejected the secret" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fm.connectionSecretChallenges.size).toBe(0);
  });
});
