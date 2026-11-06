/**
 * #3212 PR 1, the server side of choosing accounts in Settings:
 * - an agent moved onto a named credential profile that is signed out is refused (409, with the login command), as
 *   update_instance_config refuses it; a signed-in one is saved; null goes back to the fleet default;
 * - the fleet default's profile: per-backend merge (another CLI's default options are kept), the same refusal;
 * - FleetManager.accountsView(): profiles only on disk are listed, with who uses each (host scope).
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import { changedOutside } from "../src/yaml-shared-nodes.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agend-accounts-set-")); dirs.push(dir);
  const work = join(dir, "w"); mkdirSync(work);
  const path = join(dir, "fleet.yaml");
  writeFileSync(path, `defaults:\n  backend: claude-code\n  backend_options:\n    codex:\n      speed: fast\ninstances:\n  dev:\n    working_directory: ${work}\n  gpt:\n    working_directory: ${work}\n    backend: codex\n`);
  const profiles = join(dir, "credential-profiles", "claude-code");
  mkdirSync(join(profiles, "work"), { recursive: true }); mkdirSync(join(profiles, "off"));
  writeFileSync(join(profiles, "work", ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "00000000-0000-4000-8000-000000000001" } }));
  writeFileSync(join(profiles, "work", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "c".repeat(32), refreshToken: "c".repeat(32), expiresAt: Date.now() + 86400000 } }));
  const fm = new FleetManager(dir);
  fm.loadConfig(path);
  return { dir, path, fm };
}
function settingsRequest(fm: FleetManager, path: string, method = "GET", body?: Record<string, unknown>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as EventEmitter & { method: string; destroy(): void };
    req.method = method; req.destroy = () => undefined;
    let status = 0;
    const res = { writeHead(code: number) { status = code; }, end(payload: string) { resolve({ status, body: JSON.parse(payload) }); } };
    try {
      expect(handleSettingsRequest(req as never, res as never, new URL(`http://localhost${path}`), fm as unknown as Parameters<typeof handleSettingsRequest>[3])).toBe(true);
      if (body !== undefined) queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
    } catch (err) { reject(err); }
  });
}
const saved = (path: string) => yaml.load(readFileSync(path, "utf8")) as any;

describe("Settings: an agent's account (#3212)", () => {
  it("a signed-out profile is refused with its login command; a signed-in one is saved; null follows the default again", async () => {
    const { path, fm } = fixture();
    const off = await settingsRequest(fm, "/api/settings/fleet/instances/dev", "PATCH", { backend_options: { "claude-code": { credential_profile: "off" } } });
    expect([off.status, off.body.error, off.body.profile]).toEqual([409, "credential_profile_signed_out", "off"]);
    expect(off.body.loginCommand).toContain("off");
    expect(saved(path).instances.dev.backend_options).toBeUndefined();
    const ok = await settingsRequest(fm, "/api/settings/fleet/instances/dev", "PATCH", { backend_options: { "claude-code": { credential_profile: "work" } } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(saved(path).instances.dev.backend_options).toEqual({ "claude-code": { credential_profile: "work" } });
    const back = await settingsRequest(fm, "/api/settings/fleet/instances/dev", "PATCH", { backend_options: { "claude-code": { credential_profile: null } } });
    expect(back.status).toBe(200);
    expect(saved(path).instances.dev.backend_options?.["claude-code"]?.credential_profile).toBeUndefined();   // follows the default again
  });
  it("an unchanged profile is not checked again (a save of other fields still works when it was signed out meanwhile)", async () => {
    const { path, fm } = fixture();
    await settingsRequest(fm, "/api/settings/fleet/instances/dev", "PATCH", { backend_options: { "claude-code": { credential_profile: "work" } } });
    rmSync(join(fm.dataDir, "credential-profiles", "claude-code", "work", ".credentials.json"));
    rmSync(join(fm.dataDir, "credential-profiles", "claude-code", "work", ".claude.json"));
    expect((await settingsRequest(fm, "/api/settings/fleet/instances/dev", "PATCH", { auto_pause_after: 30 })).status).toBe(200);
    expect(saved(path).instances.dev.auto_pause_after).toBe(30);
  });
});

describe("Settings: the dialog sends only the changed key", () => {
  it("an agent's other backend options are kept when its account is set", async () => {
    const { path, fm } = fixture();
    expect((await settingsRequest(fm, "/api/settings/fleet/instances/dev", "PATCH", { backend_options: { "claude-code": { prompt_cache_ttl: "1h" } } })).status).toBe(200);
    expect((await settingsRequest(fm, "/api/settings/fleet/instances/dev", "PATCH", { backend_options: { "claude-code": { credential_profile: "work" } } })).status).toBe(200);
    expect(saved(path).instances.dev.backend_options).toEqual({ "claude-code": { prompt_cache_ttl: "1h", credential_profile: "work" } });
  });
});

describe("Settings: the fleet default account (#3212)", () => {
  it("backend_options is replaced whole (Accounts sends the whole map); a signed-out profile is refused; a key left out is removed", async () => {
    const { path, fm } = fixture();
    const ok = await settingsRequest(fm, "/api/settings/fleet/defaults", "PUT", { backend_options: { codex: { speed: "fast" }, "claude-code": { prompt_cache_ttl: "1h", credential_profile: "work" } } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(saved(path).defaults.backend_options).toEqual({ codex: { speed: "fast" }, "claude-code": { prompt_cache_ttl: "1h", credential_profile: "work" } });
    expect(saved(path).defaults.backend).toBe("claude-code");                                          // the top-level keys still merge
    const off = await settingsRequest(fm, "/api/settings/fleet/defaults", "PUT", { backend_options: { codex: { speed: "fast" }, "claude-code": { credential_profile: "off" } } });
    expect([off.status, off.body.error, off.body.profile]).toEqual([409, "credential_profile_signed_out", "off"]);
    expect(saved(path).defaults.backend_options["claude-code"]).toEqual({ prompt_cache_ttl: "1h", credential_profile: "work" });
    // The Advanced editor's Apply sends the whole defaults: a key the person deleted there is gone (not kept by a merge).
    const advanced = await settingsRequest(fm, "/api/settings/fleet/defaults", "PUT", { ...saved(path).defaults, backend_options: { codex: { speed: "fast" }, "claude-code": { prompt_cache_ttl: "1h" } } });
    expect(advanced.status).toBe(200);
    expect(saved(path).defaults.backend_options).toEqual({ codex: { speed: "fast" }, "claude-code": { prompt_cache_ttl: "1h" } });
  });
});

describe("FleetManager.accountsView (#3212)", () => {
  it("profiles on disk are listed even when no agent uses them; who uses each; host scope; no usage wait", async () => {
    const { fm } = fixture();
    await settingsRequest(fm, "/api/settings/fleet/instances/dev", "PATCH", { backend_options: { "claude-code": { credential_profile: "work" } } });
    vi.spyOn(fm as any, "refreshSignInIdentities").mockImplementation(() => {});
    const view = await fm.accountsView(1);
    const claude = view.clis.find((c) => c.backend === "claude-code")!;
    expect(claude.rows.map((r) => [r.profile, r.state, r.usedBy.agents, r.scope.kind])).toEqual([
      [null, claude.rows[0]!.state, [], "host"], ["off", "not_signed_in", [], "host"], ["work", "usable", ["dev"], "host"]]);
    const codex = view.clis.find((c) => c.backend === "codex");
    expect(codex?.agents).toEqual([{ name: "gpt", profile: null }]);
    expect(JSON.stringify(view)).not.toContain("c".repeat(32));
  });
});

describe("the shared-node guard on a map created for a write (#3212; also #3156's Codex speed)", () => {
  it("an agent's backend option under a fleet default that has backend_options of its own is saved (was refused as a whole)", async () => {
    const { path, fm } = fixture();
    const r = await settingsRequest(fm, "/api/settings/fleet/instances/gpt", "PATCH", { backend_options: { codex: { speed: "standard" } } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(saved(path).instances.gpt.backend_options).toEqual({ codex: { speed: "standard" } });
  });
  it("changedOutside: a new map holding only what is written is not a stray; anything else in it still is", () => {
    const before = { instances: { a: { x: 1 } } };
    const w = [["instances", "a", "opts", "codex", "speed"]];
    expect(changedOutside(before, { instances: { a: { x: 1, opts: { codex: { speed: "s" } } } } }, w)).toBeNull();
    expect(changedOutside(before, { instances: { a: { x: 1, opts: { codex: { speed: "s" }, other: { k: 1 } } } } }, w)).toBe("instances.a.opts.other");
    expect(changedOutside(before, { instances: { a: { x: 2, opts: { codex: { speed: "s" } } } } }, w)).toBe("instances.a.x");
    expect(changedOutside({ instances: { a: { opts: { codex: { speed: "s" } } } } }, { instances: { a: {} } }, w), "a map removed with its written key").toBeNull();
  });
});
