/**
 * M-2682: the sealed-settings writer as FleetManager wires it — the real FleetManager on a scratch home with real Hub keys
 * and a sealed fleet.yaml; the Hub runtime is a recorder (it is handed the writer and receives every apply).
 * - a rename saves hub.name through the fleet's own lossless writer (the rest of fleet.yaml, comments included, untouched),
 *   the pair on disk verifies, and the next apply carries the new name;
 * - clearing removes the key from fleet.yaml;
 * - an interrupted commit (a crash past the commit point) is finished by the fleet before it applies the Hub again.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provisionHubIdentity } from "../src/hub/tls.js";
import { sealHubInitialization, verifyHubInitialization } from "../src/hub/initialization.js";
import { hubPlanDigest } from "../src/hub/init/plan-digest.js";
import { createHubSettingsWriter } from "../src/hub/settings-commit.js";

const hub = vi.hoisted(() => ({ applied: [] as any[], options: null as any }));
vi.mock("../src/hub/runtime.js", () => ({
  HubRuntime: class {
    constructor(options: unknown) { hub.options = options; }
    refresh() { return Promise.resolve(); }
    apply(config: unknown) { hub.applied.push(structuredClone(config)); return Promise.resolve(); }
    fence() {} close() { return Promise.resolve(); }
    currentHolds() { return []; }
    serverHealth() { return "ready"; }
  },
}));
const { FleetManager } = await import("../src/fleet-manager.js");

const MEMBER = "https://hub.example.test:8443", ADMIN = { realm: "corp", objectId: "0f1e2d3c-4b5a-4968-8776-655443322110" };
const actor = { person: ADMIN, sessionId: "s1", requestId: "r1" };
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); hub.applied = []; hub.options = null; });
const settle = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 10)); };

async function harness() {
  const root = mkdtempSync(join(tmpdir(), "agend-hubname-")); roots.push(root); chmodSync(root, 0o700);
  const identity = await provisionHubIdentity({ home: root, memberOrigin: MEMBER });
  const block = { enabled: true, name: "AgEnD Hub pilot", hubId: identity.hubId, webOrigin: "https://hub.example.test", memberOrigin: MEMBER,
    webListen: { host: "127.0.0.1", port: 8444 }, memberListen: { host: "127.0.0.1", port: 8443 },
    webTls: { certificateFile: "hub/web-tls/cert.pem", keyFile: "hub/web-tls/key.pem" },
    directory: { realm: "corp", url: "ldaps://dc.example.test", baseDn: "DC=example,DC=test", bindDn: "CN=svc", profile: "ad", bindPasswordRef: "agend-hub-secret:bind" },
    administrator: ADMIN, retention: { contentDays: 30, eventDays: 90 }, coexistence: "dedicated" };
  const planDigest = hubPlanDigest(block), committedAt = "2026-11-08T00:00:00.000Z", confirmationId = "c".repeat(32);
  const signature = sealHubInitialization({ home: root, planDigest, confirmationId, committedAt });
  writeFileSync(join(root, "hub/init-manifest.json"), `${JSON.stringify({ v: 1, hubId: identity.hubId, planDigest, committedAt, confirmationId, signature }, null, 2)}\n`, { mode: 0o600 });
  const path = join(root, "fleet.yaml");
  writeFileSync(path, `# the owner's own note\n${yaml.dump({ instances: {}, hub: block })}`);
  const fm = new FleetManager(root) as any;
  fm.loadConfig(path);
  fm.hubEffectsReady = true;
  await fm.applyHubSwitches(); await settle();
  const verifies = () => { const h = fm.rawFleetConfig.hub; try { verifyHubInitialization({ home: root, hubId: h.hubId, memberOrigin: MEMBER, planDigest: hubPlanDigest(h) }); return true; } catch { return false; } };
  return { root, path, fm, verifies };
}

describe("FleetManager's sealed-settings writer (M-2682)", () => {
  it("the runtime is handed the writer; a rename saves hub.name losslessly, the pair verifies, and the Hub is applied with it", async () => {
    const { path, fm, verifies } = await harness();
    const writer = hub.options.settingsWriter;
    expect(writer).toBeTruthy();
    expect(hub.options.version === null || typeof hub.options.version === "string").toBe(true);
    writer.commit(writer.prepare({ kind: "rename", name: "Design Hub" }, actor).ref, actor, () => true);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# the owner's own note");
    expect((yaml.load(text) as any).hub.name).toBe("Design Hub");
    expect(fm.rawFleetConfig.hub.name).toBe("Design Hub");
    expect(verifies()).toBe(true);
    await settle();
    expect(hub.applied.at(-1).hub.name).toBe("Design Hub");
  });
  it("clearing removes hub.name from fleet.yaml, and the cleared pair verifies", async () => {
    const { path, verifies } = await harness();
    const writer = hub.options.settingsWriter;
    writer.commit(writer.prepare({ kind: "rename", name: null }, actor).ref, actor, () => true);
    expect(Object.hasOwn((yaml.load(readFileSync(path, "utf8")) as any).hub, "name")).toBe(false);
    expect(verifies()).toBe(true);
  });
  it("a commit interrupted past its commit point is finished before the next Hub apply", async () => {
    const { root, fm, verifies } = await harness();
    // Another process's writer on the same home, stopped right after the commit point (as a crash would).
    const crashed = createHubSettingsWriter({ home: root, readHub: () => fm.rawFleetConfig.hub, saveHub: (p) => fm.saveFleetConfig(p),
      step: (s) => { if (s === "committed") throw new Error("crash"); } });
    expect(() => crashed.commit(crashed.prepare({ kind: "rename", name: "After" }, actor).ref, actor, () => true)).toThrow("crash");
    expect(fm.rawFleetConfig.hub.name).toBe("AgEnD Hub pilot");
    hub.applied = [];
    await fm.applyHubSwitches(); await settle();
    expect(fm.rawFleetConfig.hub.name).toBe("After");
    expect(verifies()).toBe(true);
    expect(hub.applied.length).toBeGreaterThan(0);
    expect(hub.applied.every((c: any) => c.hub.name === "After")).toBe(true);   // never applied with the half-written pair
  });
});
