/**
 * S-51 (S5b): FleetManager's Hub hooks. While both switches are off the Hub runtime module is never imported; when a
 * switch turns on it is created once and follows every configuration change; stopping the fleet fences it
 * synchronously and closes it in the drain. The real FleetManager on a scratch home, with the runtime replaced by a
 * recorder.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

const hub = vi.hoisted(() => ({ imported: 0, created: 0, applied: [] as unknown[], events: [] as string[], options: null as any }));
vi.mock("../src/hub/runtime.js", () => {
  hub.imported += 1;
  return {
    HubRuntime: class {
      constructor(options: unknown) { hub.created += 1; hub.options = options; }
      refresh() { hub.events.push("refresh"); return Promise.resolve(); }
      apply(config: unknown) { hub.applied.push(config); hub.events.push("apply"); return Promise.resolve(); }
      fence() { hub.events.push("fence"); }
      close() { hub.events.push("close"); return Promise.resolve(); }
      currentHolds() { return []; }
    },
  };
});

const { FleetManager } = await import("../src/fleet-manager.js");

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  hub.created = 0; hub.applied = []; hub.events = [];
});

function harness(initial: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "agend-hubhooks-"));
  roots.push(root);
  const path = join(root, "fleet.yaml");
  writeFileSync(path, yaml.dump({ instances: {}, ...initial }));
  const fm = new FleetManager(root) as any;
  fm.loadConfig(path);
  const write = (cfg: Record<string, unknown>) => { writeFileSync(path, yaml.dump({ instances: {}, ...cfg })); fm.loadConfig(path); };
  return { fm, write };
}
// Real dynamic imports (the pairing API) run before the apply: wait until the work has settled, bounded.
const settle = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 10)); };

describe("FleetManager Hub hooks (S-51)", () => {
  it("off: nothing is imported, before or after the fleet starts, and through reloads", async () => {
    const before = hub.imported;
    const { fm, write } = harness({ hub: { enabled: false, name: "x" } });
    fm.hubEffectsReady = true; // what startAll sets once the web server is up
    fm.observeHubSwitches();
    await settle();
    write({ hub_member: { enabled: "true" } }); // not boolean true: still off
    await settle();
    expect(hub.imported).toBe(before);
    expect(hub.created).toBe(0);
    expect(fm.hubRuntime).toBeNull();
  });

  it("before the fleet has started, even an enabled Hub is left alone", async () => {
    harness({ hub_member: { enabled: true } });
    await settle();
    expect(hub.created).toBe(0);
  });

  it("on: created once, applied with the raw sections, and again on every configuration change; stop fences then closes", async () => {
    const { fm, write } = harness({ hub_member: { enabled: true, hubId: "h1" } });
    fm.hubEffectsReady = true;
    fm.observeHubSwitches();
    await settle();
    expect(hub.created).toBe(1);
    expect(hub.applied).toEqual([{ hub: undefined, hub_member: { enabled: true, hubId: "h1" } }]);
    write({ hub_member: { enabled: false } }); // switched off: the live runtime is told (it closes what it mounted)
    await settle();
    expect(hub.created).toBe(1);
    expect(hub.applied.at(-1)).toEqual({ hub: undefined, hub_member: { enabled: false } });

    const mark = hub.events.length;
    const stopping = fm.stopAll();
    // Fenced synchronously, in the same tick as the stop, and before the close the drain starts.
    expect(hub.events.slice(mark)[0]).toBe("fence");
    expect(fm.hubEffectsReady).toBe(false);
    await stopping;
    expect(hub.events.slice(mark)).toEqual(["fence", "close"]);
    expect(fm.hubRuntime).toBeNull();
    write({ hub_member: { enabled: true } }); // after stop: ignored
    await settle();
    expect(hub.created).toBe(1);
  }, 30_000);

  it("only dynamic imports of the Hub runtime in FleetManager", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(process.cwd(), "src/fleet-manager.ts"), "utf8");
    expect(src).not.toMatch(/^import[^;]*from\s+["']\.\/hub\//m);
    expect(src).toMatch(/await import\("\.\/hub\/runtime\.js"\)/);
  });
});

describe("review #3113 regression (single-flight runtime)", () => {
  it("P2: overlapping first observations create one runtime; Stop during creation closes it", async () => {
    const { fm } = harness({ hub_member: { enabled: true } });
    fm.hubEffectsReady = true;
    await Promise.all([fm.applyHubSwitches(), fm.applyHubSwitches(), fm.applyHubSwitches()]);
    expect(hub.created).toBe(1);
    await fm.stopAll();
    expect(hub.events.filter((e) => e === "close")).toHaveLength(1);

    const second = harness({ hub_member: { enabled: true } });
    second.fm.hubEffectsReady = true;
    const pending = second.fm.applyHubSwitches();
    const stopping = second.fm.stopAll(); // Stop while the import/creation is in flight
    await pending;
    await stopping;
    expect(hub.created).toBe(2);
    expect(hub.events.filter((e) => e === "close")).toHaveLength(2);
    expect(second.fm.hubRuntime).toBeNull();
  }, 30_000);
});

describe("S5b PR 2b: the member side's fleet hooks", () => {
  it("attaches S3c's pairing API only while the member switch is on; the member host reads the fresh binding", async () => {
    const { fm, write } = harness({ hub_member: { enabled: true } });
    fm.hubEffectsReady = true;
    fm.observeHubSwitches();
    await settle();
    expect(fm.hubMemberPairing()).not.toBeNull();
    expect(hub.options.member.boundHub()).toBeNull(); // nothing paired in this scratch home
    expect(hub.options.member.agents()).toEqual([]);
    write({ hub_member: { enabled: false } });
    await settle();
    expect(fm.hubMemberPairing()).toBeNull();
    await fm.stopAll();
  }, 30_000);
});

describe("M-2439: the representative-agent picker's agents", () => {
  it("every configured instance by its display name (General included); an old provider block changes nothing; no Hub daemon", async () => {
    const { fm } = harness({
      instances: { general: { working_directory: tmpdir(), display_name: "General" }, atlas: { working_directory: tmpdir(), display_name: "Atlas notes" }, scout: { working_directory: tmpdir() } },
      hub_member: { enabled: true, execution: { provider: { backend: "claude" } } },
    });
    fm.hubEffectsReady = true;
    fm.observeHubSwitches();
    await settle();
    expect(hub.options.member.agents()).toEqual([{ name: "general", display: "General" }, { name: "atlas", display: "Atlas notes" }, { name: "scout", display: "scout" }]);
    await fm.stopAll();
  }, 30_000);
});

describe("#3130 review: disconnect withdraws every published exposure", () => {
  it("through the running member's API: each published one, at the revision the owner saw; nothing else", async () => {
    const { fm } = harness({});
    const withdrawn: [string, number][] = [];
    fm.attachHubMemberExposures({
      list: () => [
        { exposureId: "e1", state: "published", revision: 3 },
        { exposureId: "e2", state: "withdrawn", revision: 1 },
        { exposureId: null, state: "withdrawn", revision: 0 },
        { exposureId: "e3", state: "published", revision: 1 },
      ],
      withdraw: async (id: string, rev: number) => { withdrawn.push([id, rev]); return { remote: "pending" }; },
    });
    await fm.hubMemberWithdrawAll();
    expect(withdrawn).toEqual([["e1", 3], ["e3", 1]]);
  });

  it("held or not composed: falls back to the member's own store (never composed: nothing to do)", async () => {
    const { fm } = harness({});
    fm.hubMemberPairingApi = { boundHub: () => ({ hubId: "11111111-2222-4333-8444-555555555555", binding: null }) };
    await expect(fm.hubMemberWithdrawAll()).resolves.toBeUndefined();
    fm.hubMemberPairingApi = null;
    await expect(fm.hubMemberWithdrawAll()).resolves.toBeUndefined();
    // The fallback really reaches the member's store: a partial member state fails the disconnect ("unsaved").
    const hubId = "22222222-3333-4444-8555-666666666666";
    const { mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
    chmodSync(fm.dataDir, 0o700);
    mkdirSync(join(fm.dataDir, "hub-member", hubId, "floors"), { recursive: true, mode: 0o700 });
    writeFileSync(join(fm.dataDir, "hub-member", hubId, "floors", "journal"), "0", { mode: 0o600 });
    fm.hubMemberPairingApi = { boundHub: () => ({ hubId, binding: null }) };
    await expect(fm.hubMemberWithdrawAll()).rejects.toThrow(/partial/);
  });
});


describe("host browser certificate Settings composition", () => {
  it("passes the running control through FleetManager and the real Settings baseline for exact-session preview", async () => {
    const { fm } = harness({});
    expect(fm.hubBrowserCertificate()).toBeNull();
    const control = { preview: vi.fn(() => ({ reference: "prepared", revision: "revision", certificate: { fingerprint256: "public" } })) };
    fm.hubRuntime = { browserCertificateSettings: () => control };
    expect(fm.hubBrowserCertificate()).toBe(control);
    fm.settingsGate();
    const baseline = await fm.settingsBaselineReader.read();
    expect(baseline.hubBrowserCertificate({ reference: "prepared" }, "owner-session")).toMatchObject({ certificate: { fingerprint256: "public" } });
    expect(control.preview).toHaveBeenCalledWith({ reference: "prepared" }, "owner-session");
    fm.hubRuntime = null;
    expect(() => baseline.hubBrowserCertificate({}, "owner-session")).toThrow("unavailable");
    await fm.stopAll();
  });
});
