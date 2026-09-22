import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function manager() {
  const dir = mkdtempSync(join(tmpdir(), "agend-fleet-secret-")); dirs.push(dir);
  const fm = new FleetManager(dir) as any;
  fm.fleetConfig = {
    channels: [{ id: "primary", type: "discord", mode: "topic", bot_token_env: "DISCORD_BOT_TOKEN", group_id: "1", access: { mode: "open", allowed_users: [] } }],
    defaults: {}, instances: {},
  };
  return { fm, dir };
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
});
