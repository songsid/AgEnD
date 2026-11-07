import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { SettingsBaselines } from "../src/settings-baseline.js";
import { settingsChangeDiff } from "../src/settings-change.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { handleSettingsRequest } from "../src/settings-api.js";

const fixtures: Array<{ dir: string; fm: FleetManager; store: SettingsConfirmationStore }> = [];
afterEach(() => {
  for (const { dir, fm, store } of fixtures.splice(0)) {
    store.close(); fm.stormWindow.shutdown(); fm.spawnGate.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "accounts-3335-"));
  vi.stubEnv("HOME", dir); vi.stubEnv("AGEND_HOME", dir);
  const path = join(dir, "fleet.yaml");
  writeFileSync(path, yaml.dump({ defaults: { backend: "claude-code" }, instances: { worker: { working_directory: dir } } }));
  for (const profile of ["personal", "signed-out"]) mkdirSync(join(dir, "credential-profiles/claude-code", profile), { recursive: true });
  writeFileSync(join(dir, "credential-profiles/claude-code/personal/.claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "fixture" } }));
  writeFileSync(join(dir, "credential-profiles/claude-code/personal/.credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-access", expiresAt: Date.now() + 86400000 } }));
  const fm = new FleetManager(dir); fm.loadConfig(path);
  (fm as unknown as { startupComplete: boolean }).startupComplete = true;
  const runtime = structuredClone(fm.fleetConfig!.instances.worker!);
  fm.lifecycle.daemons.set("worker", { getConfigSnapshot: () => runtime } as never);
  const stop = vi.spyOn(fm, "stopInstance").mockResolvedValue({ backgroundWorkEnded: false });
  const start = vi.spyOn(fm as unknown as { startInstanceUnattended(...args: unknown[]): Promise<void> }, "startInstanceUnattended").mockResolvedValue(undefined);
  const notify = vi.fn();
  const store = new SettingsConfirmationStore({ audit: vi.fn(), notify });
  const baselines = new SettingsBaselines({ dataDir: dir, configPath: () => path, config: () => fm.fleetConfig!, current: () => 0 });
  const gate = new SettingsHttpConfirmation(store, {
    principal: () => ({ id: "owner", label: "Owner browser", source: "web_session", current: () => true }),
    baseline: () => baselines.read(), snapshot: () => baselines.snapshot(),
  });
  fixtures.push({ dir, fm, store });
  async function request(body: unknown, method = "PATCH", target = "/api/settings/fleet/instances/worker") {
    return new Promise<{ status: number; body: any }>((resolve) => {
      const req = Object.assign(new EventEmitter(), { method, url: target, headers: { cookie: "owner" }, destroy() {} });
      let status = 0;
      const res = { headersSent: false, destroyed: false, setHeader() {}, writeHead(code: number) { status = code; this.headersSent = true; }, end(raw: string) { resolve({ status, body: JSON.parse(raw) }); } };
      const next = (r: any, s: any, u: URL) => handleSettingsRequest(r, s, u, fm as never);
      expect(gate.handle(req as never, res as never, new URL(req.url, "http://localhost"), next)).toBe(true);
      queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
    });
  }
  const patch = (profile: unknown) => request({ backend_options: { "claude-code": { credential_profile: profile } } });
  return { fm, path, request, patch, stop, start, notify, store, dir };
}

describe("Accounts Save through the HTTP confirmation gate (#3335)", () => {
  it("saves a signed-in profile with no confirmation, then the existing Apply restarts the moved agent", async () => {
    const h = harness();
    const response = await h.patch("personal");
    expect(response, "base returns400 unsupported_sensitive_effect before the account handler").toMatchObject({ status: 200, body: { ok: true } });
    expect((yaml.load(readFileSync(h.path, "utf8")) as any).instances.worker.backend_options["claude-code"].credential_profile).toBe("personal");
    expect(h.store.list("owner")).toEqual([]); expect(h.notify).not.toHaveBeenCalled();
    expect(h.fm.planConfigApply()).toEqual([{ target: "worker", kind: "restart" }]);
    const result = h.fm.startSettingsApply("account-move-3335");
    expect("job" in result).toBe(true);
    if (!("job" in result)) throw Error("Apply unexpectedly busy");
    await vi.waitFor(() => expect(h.fm.applyJobs.get(result.job.id)?.status).toBe("done"));
    expect(h.stop).toHaveBeenCalledExactlyOnceWith("worker"); expect(h.start).toHaveBeenCalledOnce();
  });
  it("still refuses a signed-out profile without persisting or restarting", async () => {
    const h = harness(), response = await h.patch("signed-out");
    expect(response).toMatchObject({ status: 409, body: { error: "credential_profile_signed_out" } });
    expect(h.fm.fleetConfig!.instances.worker!.backend_options).toBeUndefined();
    expect(h.stop).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled();
  });
  it("can move back to inherited account with null, without another confirmation", async () => {
    const h = harness();
    expect((await h.patch("personal")).status).toBe(200);
    expect((await h.patch(null)).status).toBe(200);
    expect(h.fm.fleetConfig!.instances.worker!.backend_options?.["claude-code"]?.credential_profile).toBeUndefined();
    expect(h.store.list("owner")).toEqual([]);
  });
  it("checks the new CLI's login even when its profile has the same name", async () => {
    const h = harness();
    expect((await h.patch("personal")).status).toBe(200);
    mkdirSync(join(h.dir, "credential-profiles/codex/personal"), { recursive: true });
    const response = await h.request({ backend: "codex", backend_options: { codex: { credential_profile: "personal" } } });
    expect(response).toMatchObject({ status: 409, body: { error: "credential_profile_signed_out", backend: "codex", profile: "personal" } });
    expect(h.fm.fleetConfig!.instances.worker!.backend).toBe("claude-code");
    expect(h.stop).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled();
  });
  it("also accepts the Accounts fleet default without a confirmation; malformed profiles still cannot write", async () => {
    const h = harness();
    for (const profile of ["../outside", "", { name: "personal" }, ["personal"]]) {
      expect((await h.patch(profile)).status).toBe(400);
      expect(h.fm.fleetConfig!.instances.worker!.backend_options).toBeUndefined();
    }
    expect((await h.request({ backend_options: { "claude-code": { credential_profile: "personal" } } }, "PUT", "/api/settings/fleet/defaults")).status).toBe(200);
    expect((yaml.load(readFileSync(h.path, "utf8")) as any).defaults.backend_options["claude-code"].credential_profile).toBe("personal");
    expect(h.store.list("owner")).toEqual([]); expect(h.notify).not.toHaveBeenCalled();
  });
});

describe("only supported account-reference leaves are immediate", () => {
  const diff = (before: unknown, after: unknown) => settingsChangeDiff(before, after, { operation: "account-boundary" });
  const fleet = (options: unknown, defaults = false) => ({ fleet: defaults ? { defaults: { backend_options: options } } : { instances: { worker: { backend_options: options } } } });
  for (const cli of ["claude-code", "codex", "kiro-cli"]) {
    it(`${cli}: agent and fleet-default profile names can change or be cleared`, () => {
      for (const defaults of [false, true]) for (const from of [undefined, "old-work", null]) for (const to of ["personal", undefined, null]) {
        expect(diff(fleet({ [cli]: { credential_profile: from } }, defaults), fleet({ [cli]: { credential_profile: to } }, defaults))).toBeNull();
      }
    });
  }
  it("does not make credential_profile a global immediate key or bypass sibling secrets/permissions", () => {
    for (const options of [{ other: { credential_profile: "personal" } }, { constructor: { credential_profile: "personal" } }, { "claude-code": { credential_profile: "../outside" } }, { "claude-code": { credential_profile: ["personal"] } }]) {
      expect(() => diff(fleet({}), fleet(options))).toThrow();
    }
    for (const before of [{ fleet: { defaults: {} } }, { fleet: { instances: { worker: {} } } }]) {
      const after = structuredClone(before) as any;
      (after.fleet.defaults ?? after.fleet.instances.worker).credential_profile = "personal";
      expect(() => diff(before, after)).toThrow();
    }
    expect(() => diff({ fleet: { defaults: { nested: {} } } }, { fleet: { defaults: { nested: { backend_options: { "claude-code": { credential_profile: "personal" } } } } } })).toThrow();
    expect(() => diff({ other: { defaults: {} } }, { other: { defaults: { backend_options: { "claude-code": { credential_profile: "personal" } } } } })).toThrow();
    expect(() => diff(fleet({ "claude-code": { credential_profile: "../invalid-old" } }), fleet({ "claude-code": { credential_profile: "personal" } }))).toThrow();
    const secret = diff(fleet({}), fleet({ "claude-code": { credential_profile: "personal", api_key: "SECRET-CANARY" } }));
    expect(secret).not.toBeNull(); expect(JSON.stringify(secret)).not.toContain("SECRET-CANARY");
    expect(() => diff(fleet({}), fleet({ "claude-code": { credential_profile: "personal", permissions: "full" } }))).toThrow();
  });
});
