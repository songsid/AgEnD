/** Real private initializer/files and inert service inspection; fake directory/identity, never real lifecycle changes. */
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import { createHubInitializer } from "../src/hub/init/initializer.js";
import type { HubInitPlan } from "../src/hub/init/types.js";
import { HUB_INVENTORY_REL, readHubInstallationInventory } from "../src/hub/init/inventory.js";
import { hubHandoffLines, runHubHandoffCommand } from "../src/hub/init/handoff.js";
import { setLocale } from "../src/locale.js";
import { ADMIN, FakeIdentity, makeTestCerts, tempDir } from "./support/hub-init-fixtures.js";

const service = vi.hoisted(() => ({ inspect: vi.fn(() => ({ installed: true, path: "/inert/service", manager: "systemd-user" })) }));
vi.mock("../src/service-installer.js", () => ({ inspectService: service.inspect }));
let certs: ReturnType<typeof makeTestCerts> | undefined;
const homes: string[] = [];
beforeAll(() => { certs = makeTestCerts(); });
afterAll(() => { if (certs) rmSync(certs.dir, { recursive: true, force: true }); });
afterEach(() => { for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); service.inspect.mockClear(); setLocale("en"); });
const home = () => { const p = tempDir("agend-hub-handoff-"); homes.push(p); return p; };
function plan(coexistence: HubInitPlan['coexistence'] = "dedicated"): HubInitPlan {
  return { name: "Example Hub", webOrigin: "https://hub.example.test:8443", memberOrigin: "https://hub.example.test:9443",
    webListen: { host: "192.0.2.10", port: 8443 }, memberListen: { host: "192.0.2.10", port: 9443 },
    directory: { realm: "corp", url: "ldaps://directory.example.test", profile: "openldap", baseDn: "DC=example,DC=test", bindDn: "CN=Reader,DC=example,DC=test", caPem: readFileSync(certs!.caCert, "utf8") },
    bindPasswordRef: "file:hub/secrets/directory-bind", administrator: ADMIN.key,
    retention: { contentDays: 7, eventDays: 30 }, coexistence, webTls: { certFile: certs!.cert, keyFile: certs!.key } };
}
async function initialized(root: string, p = plan()) {
  const identity = new FakeIdentity(), init = createHubInitializer({ home: root, identity, probe: { pidAlive: () => false } });
  const confirmation = await init.prepareConfirmation(p, { bindPassword: "Dummy-bind-secret-only" });
  const result = await init.commit(p, confirmation.reference);
  return { init, result, identity };
}
it.each(["dedicated", "same-user-pilot"] as const)("records only selected setup metadata privately, keeping the existing fleet (%s)", async coexistence => {
  const root = home(); if (coexistence === "same-user-pilot") writeFileSync(join(root, "fleet.yaml"), "instances:\n  general:\n    working_directory: /inert/work\n");
  const { result } = await initialized(root, plan(coexistence)), inventory = readHubInstallationInventory(root), text = readFileSync(join(root, HUB_INVENTORY_REL), "utf8");
  expect(inventory).toMatchObject({ hubId: result.hubId, spkiSha256: result.spkiSha256, coexistence, purpose: "installation-record", paths: ["fleet.yaml", "hub/", "fleet.log"] });
  expect(Object.keys(inventory).sort()).toEqual(["v", "purpose", "recordedAt", "hubId", "webOrigin", "memberOrigin", "spkiSha256", "coexistence", "serviceLabel", "paths"].sort());
  expect(statSync(join(root, HUB_INVENTORY_REL)).mode & 0o777).toBe(0o600);
  for (const sensitive of ["Dummy-bind-secret-only", "CN=Reader", ADMIN.key.objectId, "BEGIN", certs!.cert, certs!.key]) expect(text).not.toContain(sensitive);
  const cfg = yaml.load(readFileSync(join(root, "fleet.yaml"), "utf8")) as { hub: { enabled: boolean }; instances?: unknown };
  expect(cfg.hub.enabled).toBe(true); if (coexistence === "same-user-pilot") expect(cfg.instances).toEqual({ general: { working_directory: "/inert/work" } });
  const sealed = JSON.parse(readFileSync(join(root, "hub/init-manifest.json"), "utf8")); expect(sealed.signature).toBeTruthy(); expect(inventory).not.toHaveProperty("signature");
});
it("keeps the Hub off if inventory persistence fails, then resumes an already-sealed operation without replacing identity", async () => {
  const root = home(), p = plan(), identity = new FakeIdentity();
  const first = createHubInitializer({ home: root, identity, probe: { pidAlive: () => false }, afterStage: stage => {
    if (stage === "manifest") mkdirSync(join(root, HUB_INVENTORY_REL));
  } });
  const confirmed = await first.prepareConfirmation(p, { bindPassword: "Dummy-bind-secret-only" });
  await expect(first.commit(p, confirmed.reference)).rejects.toThrow();
  const cfg = () => yaml.load(readFileSync(join(root, "fleet.yaml"), "utf8")) as { hub: { enabled: boolean } };
  expect(cfg().hub.enabled).toBe(false); expect((await first.inspect()).incomplete?.stage).toBe("manifest");
  const sealed = readFileSync(join(root, "hub/init-manifest.json")); rmSync(join(root, HUB_INVENTORY_REL), { recursive: true });
  const resumed = createHubInitializer({ home: root, identity, probe: { pidAlive: () => false } }), next = await resumed.prepareConfirmation(p, { bindPassword: "Dummy-bind-secret-only" });
  await expect(resumed.commit(p, next.reference)).resolves.toHaveProperty("hubId");
  expect(cfg().hub.enabled).toBe(true); expect(identity.provisions).toBe(1); expect(readFileSync(join(root, "hub/init-manifest.json"))).toEqual(sealed);
  expect(readHubInstallationInventory(root).hubId).toBe((await identity.read(root))!.hubId);
});
it.each(["en", "zh-TW"] as const)("shows scoped commands and retained-data/pairing guidance without mutation (%s)", async locale => {
  const root = home(); await initialized(root); setLocale(locale);
  const before = readFileSync(join(root, "fleet.yaml")), secret = readFileSync(join(root, "hub/secrets/directory-bind"));
  vi.stubEnv("AGEND_HOME", root); const output = vi.spyOn(console, "log").mockImplementation(() => {}), previous = process.exitCode;
  try { await runHubHandoffCommand(); expect(process.exitCode).toBe(previous); } finally { process.exitCode = previous; }
  const text = output.mock.calls.flat().join("\n");
  for (const command of ["stop", "restart", "uninstall", "hub handoff"]) expect(text).toContain(`AGEND_HOME='${root}' agend ${command}`);
  expect(text).toContain("/inert/service"); expect(text).toContain("https://hub.example.test:8443/web");
  expect(text).toContain(locale === "en" ? "every agent" : "所有 agent"); expect(text).toContain(locale === "en" ? "does not erase" : "不會抹除");
  expect(text).not.toContain("Dummy-bind-secret-only"); expect(text).not.toContain("--force");
  expect(readFileSync(join(root, "fleet.yaml"))).toEqual(before); expect(readFileSync(join(root, "hub/secrets/directory-bind"))).toEqual(secret);
  expect(service.inspect).toHaveBeenCalledExactlyOnceWith("com.agend.fleet");
});
it("keeps the handoff available when optional service inspection fails", async () => {
  const root = home(); await initialized(root); vi.stubEnv("AGEND_HOME", root);
  service.inspect.mockImplementationOnce(() => { throw Error("inert manager unavailable"); });
  const output = vi.spyOn(console, "log").mockImplementation(() => {}), previous = process.exitCode;
  try { await runHubHandoffCommand(); expect(process.exitCode).toBe(previous); } finally { process.exitCode = previous; }
  expect(output.mock.calls.flat().join("\n")).toContain("Hub installation record");
  expect(output.mock.calls.flat().join("\n")).toContain("agend uninstall");
});
it("quotes a non-default home so copying a displayed command reaches that exact home", async () => {
  const root = home(); await initialized(root); const named = join(root, "space ' quote $(printf unexpected) `printf unexpected`"); mkdirSync(named, { mode: 0o700 });
  const bin = join(root, "bin"); mkdirSync(bin); writeFileSync(join(bin, "agend"), '#!/bin/sh\nprintf "%s\\n" "$AGEND_HOME" "$@"\n', { mode: 0o700 });
  const line = hubHandoffLines(named, readHubInstallationInventory(root)).find(x => x.endsWith(" agend stop"))!, command = line.slice(line.indexOf("AGEND_HOME="));
  const ran = spawnSync("/bin/sh", ["-c", command], { env: { PATH: bin }, encoding: "utf8" });
  expect(ran.status).toBe(0); expect(ran.stdout).toBe(named + "\nstop\n"); expect(ran.stderr).toBe("");
  expect(() => hubHandoffLines(root + "\nunsafe", readHubInstallationInventory(root))).toThrow("invalid_hub_handoff_home");
});
it("refuses missing, nonprivate, linked, foreign-purpose or altered-path records before inspecting a service", async () => {
  const root = home(); vi.stubEnv("AGEND_HOME", root); const output = vi.spyOn(console, "error").mockImplementation(() => {}), previous = process.exitCode;
  try { await runHubHandoffCommand(); expect(process.exitCode).toBe(1); } finally { process.exitCode = previous; }
  expect(output).toHaveBeenCalled(); expect(service.inspect).not.toHaveBeenCalled();
  await initialized(root); const path = join(root, HUB_INVENTORY_REL), original = readFileSync(path, "utf8"), parsed = JSON.parse(original);
  for (const bad of [{ ...parsed, v: 2 }, { ...parsed, purpose: "authorization" }, { ...parsed, recordedAt: "not-a-date" }, { ...parsed, hubId: "bad\u001b[2J" },
    { ...parsed, paths: ["../other"] }, { ...parsed, webOrigin: "https://user:pw@hub.example.test" }, { ...parsed, memberOrigin: "http://member.example.test" },
    { ...parsed, spkiSha256: "not-a-pin" }, { ...parsed, coexistence: "unknown" }, { ...parsed, serviceLabel: "another-service" }, { ...parsed, padding: "a".repeat(8192) }]) {
    writeFileSync(path, JSON.stringify(bad)); expect(() => readHubInstallationInventory(root)).toThrow();
  }
  writeFileSync(path, original); chmodSync(path, 0o644); expect(() => readHubInstallationInventory(root)).toThrow(); chmodSync(path, 0o600);
  rmSync(path); symlinkSync(join(root, "hub/init-manifest.json"), path); expect(() => readHubInstallationInventory(root)).toThrow();
  expect(existsSync(join(root, "hub/init-manifest.json"))).toBe(true); expect(readdirSync(root)).toContain("fleet.yaml");
});
