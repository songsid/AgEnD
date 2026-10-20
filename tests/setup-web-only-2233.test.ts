/**
 * #2233 part 3: the setup page's "Web only (no bot)" — a fleet with no chat connection, made without a bot token. The
 * real SetupHost on a scratch directory (no fleet is started: spawnFleet is a spy), its host confirmation through the
 * control socket, and the written files.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import yaml from "js-yaml";
import { SetupHost } from "../src/setup-host.js";
import { draftWebOnly, validateWizardInput, webOnlyConflict } from "../src/quickstart-api.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { setupHttp, decideSetup } from "./helpers/setup-confirmation-1423.js";

const WEB = { web_only: true, backend: "claude-code", working_directory: "/home/demo/project", instance_name: "agent-1" };
const fixtures: { host: SetupHost; dir: string }[] = [];
afterEach(async () => { for (const { host, dir } of fixtures.splice(0)) { await host.shutdown(false, "test cleanup"); rmSync(dir, { recursive: true, force: true }); } vi.restoreAllMocks(); });
async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "agend-test-setup-web-")), spawnFleet = vi.fn(), logs: string[] = [];
  const host = new SetupHost({ dataDir: dir, configPath: join(dir, "fleet.yaml"), port: 0, spawnFleet, log: message => logs.push(message) });
  fixtures.push({ host, dir });
  const { port, path, code } = await host.start();
  const signed = await setupHttp(port, path + "open", "POST", { code });
  const cookie = String(signed.headers["set-cookie"]).split(";")[0]!;
  return { host, dir, port, path, cookie, spawnFleet, logs };
}

describe("#2233 web-only setup on the real SetupHost", () => {
  it("plan → commit (pending, nothing written) → host confirmation → the agent alone, no connection, no .env → finish hands over", async () => {
    const h = await harness();
    const plan = await setupHttp(h.port, h.path + "api/settings/quickstart/plan", "POST", WEB, h.cookie);
    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({ web_only: true, instance: { name: "agent-1", backend: "claude-code", working_directory: "/home/demo/project" }, env_keys: [] });
    const pending = await setupHttp(h.port, h.path + "api/settings/quickstart/commit", "POST", WEB, h.cookie);
    expect(pending.status).toBe(202);
    expect(existsSync(join(h.dir, "fleet.yaml"))).toBe(false);
    expect((await setupHttp(h.port, h.path + "setup/finish", "POST", undefined, h.cookie)).status).toBe(409);
    expect((await decideSetup(h.dir, pending.body.pending_change.id)).pending_change.state).toBe("applied");
    const written = yaml.load(readFileSync(join(h.dir, "fleet.yaml"), "utf8")) as Record<string, any>;
    expect(written.instances).toEqual({ "agent-1": { working_directory: "/home/demo/project", backend: "claude-code" } });
    expect(written.channel).toBeUndefined();
    expect(written.channels).toBeUndefined();
    expect(existsSync(join(h.dir, ".env")), "no secret: nothing to write").toBe(false);
    expect(validateFleetConfig(written as never).valid).toBe(true);
    expect((await setupHttp(h.port, h.path + "setup/status", "GET", undefined, h.cookie)).body.finish_ready).toBe(true);
    expect((await setupHttp(h.port, h.path + "setup/finish", "POST", undefined, h.cookie)).status).toBe(202);
    await h.host.shutdown(true, "finished");
    expect(h.spawnFleet).toHaveBeenCalledOnce();
  });

  it("a write that fails after the file was saved is undone: no agent in memory, no fleet.yaml, no hand-over", async () => {
    const h = await harness();
    const pending = await setupHttp(h.port, h.path + "api/settings/quickstart/commit", "POST", WEB, h.cookie);
    (h.host as any).setupContext.settingsCommitted = () => { throw new Error("inert receipt failure"); };
    expect((await decideSetup(h.dir, pending.body.pending_change.id)).pending_change.state).toBe("failed");
    expect((h.host as any).setupContext.fleetConfig.instances).toEqual({});
    expect(existsSync(join(h.dir, "fleet.yaml"))).toBe(false);
    expect((await setupHttp(h.port, h.path + "setup/finish", "POST", undefined, h.cookie)).status).toBe(409);
    expect(h.spawnFleet).not.toHaveBeenCalled();
  });

  it("a web-only body carrying any connection field (a token included) is refused before anything is proposed", async () => {
    const h = await harness();
    for (const extra of [{ token: "123:abc" }, { token_env: "AGEND_BOT_TOKEN" }, { platform: "telegram" }, { admin_user_id: "1" }, { group_id: "-100" }, { connection_only: true }]) {
      const r = await setupHttp(h.port, h.path + "api/settings/quickstart/commit", "POST", { ...WEB, ...extra }, h.cookie);
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await setupHttp(h.port, h.path + "api/settings/pending", "GET", undefined, h.cookie)).body).toEqual([]);
    expect(existsSync(join(h.dir, "fleet.yaml"))).toBe(false);
  });
});

describe("#2233 web-only validation and draft (pure)", () => {
  it("valid: name, backend and an absolute directory; anything else refused with what is wrong", () => {
    expect(validateWizardInput(WEB as never)).toBeNull();
    expect(validateWizardInput({ ...WEB, web_only: "yes" } as never)).toBe("web_only must be a boolean");
    expect(validateWizardInput({ ...WEB, working_directory: "relative" } as never)).toBe("working_directory must be an absolute path");
    expect(validateWizardInput({ ...WEB, backend: "gemini-cli" } as never)).toBe("backend must be a known backend");
    expect(validateWizardInput({ ...WEB, instance_name: "a b" } as never)).toBe("instance_name must be [A-Za-z0-9._-]");
    expect(validateWizardInput({ ...WEB, token_env: "X" } as never)).toBe("token_env does not apply to a web-only setup");
  });
  it("only while the fleet has no connection; the draft adds the agent bound to none and leaves everything else", () => {
    expect(webOnlyConflict({ instances: {}, defaults: {} } as never)).toBeNull();
    expect(webOnlyConflict({ instances: {}, defaults: {}, channel: { type: "telegram", bot_token_env: "T" } } as never)).toMatch(/already has a chat connection/);
    const cfg = { instances: { old: { working_directory: "/w", backend: "codex" } }, defaults: { model: "m" } } as never;
    expect(draftWebOnly(cfg, WEB as never)).toEqual({ instances: { old: { working_directory: "/w", backend: "codex" }, "agent-1": { working_directory: "/home/demo/project", backend: "claude-code" } }, defaults: { model: "m" } });
  });
  it("the confirmation's diff: the new agent, and no secret in it", () => {
    const cfg = { instances: {}, defaults: {} } as never;
    const effect = prepareSettingsEffect("POST", "/api/settings/quickstart/commit", WEB, { config: cfg, classic: {} }) as any;
    expect(JSON.stringify(effect.diff)).toContain("agent-1");
    expect(JSON.stringify(effect.diff)).not.toMatch(/secret|token/i);
  });
});
