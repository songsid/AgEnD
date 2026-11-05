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

const hub = vi.hoisted(() => ({ imported: 0, created: 0, applied: [] as unknown[], events: [] as string[] }));
vi.mock("../src/hub/runtime.js", () => {
  hub.imported += 1;
  return {
    HubRuntime: class {
      constructor() { hub.created += 1; }
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
const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

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
