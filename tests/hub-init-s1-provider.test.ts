/** Actual S1 keys + S5 confirmed files in scratch; no directory, CLI, service or trust-store action. */
import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { createHubInitializer } from "../src/hub/init/initializer.js";
import { hubPlanDigest } from "../src/hub/init/plan-digest.js";
import { HubMount } from "../src/hub/mount.js";
import { verifyHubInitialization } from "../src/hub/initialization.js";
import { ADMIN, makeTestCerts } from "./support/hub-init-fixtures.js";
const roots: string[] = [];
afterEach(() => { vi.doUnmock("../src/hub/tls.js"); vi.resetModules(); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function home() { mkdirSync(".artifacts", { recursive: true }); const p = mkdtempSync(join(process.cwd(), ".artifacts/hub-provider-")); chmodSync(p, 0o700); roots.push(p); return p; }
it("checking availability while off loads no TLS/key/filesystem provider and performs no initialization", async () => {
  let imported = 0; vi.doMock("../src/hub/tls.js", () => { imported++; return {}; }); vi.resetModules();
  const { hubIdentityProvider } = await import("../src/hub/init/identity.js");
  expect(hubIdentityProvider().available).toBe(process.platform !== "win32"); expect(imported).toBe(0);
});
it.skipIf(process.platform === "win32")("distinguishes wholly missing keys from an incomplete existing identity without overwriting it", async () => {
  const { hubIdentityProvider } = await import("../src/hub/init/identity.js"), provider = hubIdentityProvider(), root = home();
  expect(await provider.read(root)).toBeUndefined(); expect(existsSync(join(root, "hub"))).toBe(false);
  const keys = join(root, "hub/keys"); mkdirSync(keys, { recursive: true, mode: 0o700 });
  writeFileSync(join(keys, "identity.json"), "{}", { mode: 0o600 });
  await expect(provider.read(root)).rejects.toThrow();
  await expect(provider.provision({ home: root, memberOrigin: "https://hub.example.test:9443" })).rejects.toThrow("already exists");
  expect(readFileSync(join(keys, "identity.json"), "utf8")).toBe("{}");
});
it.skipIf(process.platform === "win32")("resumes a confirmed initializer with actual keys and verifies its exact sealed configuration at the mount", async () => {
  const { hubIdentityProvider } = await import("../src/hub/init/identity.js"), provider = hubIdentityProvider(), root = home(), certs = makeTestCerts();
  const plan = { name: "Test Hub", webOrigin: "https://hub.example.test:8443", memberOrigin: "https://hub.example.test:9443",
    memberListen: { host: "192.0.2.10", port: 9443 }, webListen: { host: "192.0.2.10", port: 8443 }, webTls: { certFile: certs.cert, keyFile: certs.key },
    directory: { realm: "corp", url: "ldaps://directory.example.test", baseDn: "dc=example,dc=test", bindDn: "cn=reader,dc=example,dc=test", profile: "openldap" as const },
    bindPasswordRef: "file:hub/secrets/directory-bind", administrator: ADMIN.key, retention: { contentDays: 1, eventDays: 7 }, coexistence: "dedicated" as const };
  const interrupted = createHubInitializer({ home: root, identity: provider, probe: { pidAlive: () => false }, afterStage: stage => { if (stage === "identity") throw Error("inert interruption"); } });
  const first = await interrupted.prepareConfirmation(plan, { bindPassword: "scratch-only-secret" });
  await expect(interrupted.commit(plan, first.reference)).rejects.toThrow("inert interruption");
  const before = await provider.read(root); expect(before).toBeDefined(); expect(existsSync(join(root, "fleet.yaml"))).toBe(false);
  const resumed = createHubInitializer({ home: root, identity: provider, probe: { pidAlive: () => false } });
  const next = await resumed.prepareConfirmation(plan, { bindPassword: "scratch-only-secret" }); await resumed.commit(plan, next.reference);
  expect(await provider.read(root)).toEqual(before);
  const config = yaml.load(readFileSync(join(root, "fleet.yaml"), "utf8")) as { hub: Record<string, unknown> };
  expect(config.hub.enabled).toBe(true);
  const manifest = verifyHubInitialization({ home: root, hubId: before!.hubId, memberOrigin: plan.memberOrigin, planDigest: hubPlanDigest(config.hub) });
  expect(manifest.committedAt).toMatch(/Z$/); expect(manifest.confirmationId).toHaveLength(32);
  const service = { start: vi.fn(async () => {}), fence: vi.fn(), close: vi.fn(async () => {}) }, factory = vi.fn(async () => service), hold = vi.fn();
  const mount = new HubMount({ home: root, planDigest: hubPlanDigest, createServer: factory, createMember: vi.fn(), hold });
  await mount.apply(config); expect(factory).toHaveBeenCalledOnce(); expect(service.start).toHaveBeenCalledOnce();
  await mount.apply({ hub: { ...config.hub, name: "Changed after confirmation" } });
  expect(factory).toHaveBeenCalledOnce(); expect(hold).toHaveBeenCalledWith("initialization"); expect(mount.serverEnabled()).toBe(false);
  await mount.close();
});
