/** Private files, injected process identities and clock; real probes use only owned loopback sockets. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type AddressInfo } from "node:net";
import { waitForHubServiceStart, assertHubServiceInstallIdle, type HubServiceStartDeps } from "../src/hub/service-start.js";
import type { ServiceProcessState } from "../src/service-drain.js";
import type { HubInitListeners } from "../src/hub/init/network.js";
import { FLEET_STOP_TIMEOUT_MS } from "../src/fleet-stop-budget.js";

const roots: string[] = [], sockets: Server[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) if (s.listening) await new Promise<void>(resolve => s.close(() => resolve()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function rig() {
  const home = mkdtempSync(join(tmpdir(), "agend-hub-start-")); roots.push(home);
  const file = join(home, "fleet.yaml"), pid = join(home, "fleet.pid");
  const listeners: HubInitListeners = { webListen: { host: "127.0.0.1", port: 18443 }, memberListen: { host: "127.0.0.1", port: 19443 } };
  const config = (enabled = true) => JSON.stringify({ hub: { enabled, ...listeners } });
  writeFileSync(file, config());
  let clock = 0;
  const inspect = vi.fn(() => "gone" as ServiceProcessState), check = vi.fn(async () => []);
  const deps: HubServiceStartDeps = { inspectProcess: inspect, checkListeners: check, now: () => clock,
    sleep: async ms => { clock += ms; expect(clock, "stop budget is bounded").toBeLessThanOrEqual(FLEET_STOP_TIMEOUT_MS); } };
  return { home, file, pid, config, listeners, deps, check, inspect, time: () => clock };
}
async function bind(port = 0) {
  const server = createServer(s => s.destroy()); sockets.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return { server, port: (server.address() as AddressInfo).port };
}
describe("Hub replacement admission before any runtime exists", () => {
  it("does no PID or socket work for an off Hub", async () => {
    const r = rig(); writeFileSync(r.file, r.config(false)); writeFileSync(r.pid, "not a PID");
    await expect(waitForHubServiceStart(r.home, r.deps)).resolves.toBeUndefined();
    expect(r.inspect).not.toHaveBeenCalled(); expect(r.check).not.toHaveBeenCalled();
  });
  it("passes an idle plan unchanged and preserves its old PID record", async () => {
    const r = rig(); writeFileSync(r.pid, "40\n");
    await waitForHubServiceStart(r.home, r.deps);
    expect(r.check).toHaveBeenCalledExactlyOnceWith(r.listeners); expect(r.inspect).toHaveBeenCalledExactlyOnceWith(40);
    expect(readFileSync(r.pid, "utf8")).toBe("40\n"); expect(readFileSync(r.file, "utf8")).toBe(r.config());
  });
  it("waits for the captured birth to exit before touching listeners", async () => {
    const r = rig(); writeFileSync(r.pid, "40"); let running = true;
    r.deps.inspectProcess = () => running ? { birth: "old-birth" } : "gone";
    r.deps.sleep = async ms => { expect(ms).toBeLessThanOrEqual(250); expect(r.check).not.toHaveBeenCalled(); running = false; };
    await waitForHubServiceStart(r.home, r.deps); expect(r.check).toHaveBeenCalledOnce(); expect(readFileSync(r.pid, "utf8")).toBe("40");
  });
  it("refuses uncertain process identity before probing or changing any file", async () => {
    const r = rig(); writeFileSync(r.pid, "40"); r.deps.inspectProcess = () => "unknown";
    await expect(waitForHubServiceStart(r.home, r.deps)).rejects.toMatchObject({ reason: "process" });
    expect(r.check).not.toHaveBeenCalled(); expect(readFileSync(r.pid, "utf8")).toBe("40");
  });
  it.each(["", "1", "-2", "two", "0", "9".repeat(33)])("refuses invalid PID record %j", async pid => {
    const r = rig(); writeFileSync(r.pid, pid);
    await expect(waitForHubServiceStart(r.home, r.deps)).rejects.toMatchObject({ reason: "process" }); expect(r.check).not.toHaveBeenCalled();
  });
  it("refuses a PID-file symlink and leaves its target unchanged", async () => {
    const r = rig(), target = join(r.home, "owner-file"); writeFileSync(target, "40"); symlinkSync(target, r.pid);
    await expect(waitForHubServiceStart(r.home, r.deps)).rejects.toMatchObject({ reason: "process" });
    expect(readFileSync(target, "utf8")).toBe("40"); expect(r.inspect).not.toHaveBeenCalled();
  });
  it("refuses a record owned by another UID without inspecting its process", async () => {
    const r = rig(); writeFileSync(r.pid, "40");
    const uid = process.getuid!(), declared = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      await expect(waitForHubServiceStart(r.home, r.deps)).rejects.toMatchObject({ reason: "process" });
      expect(r.inspect).not.toHaveBeenCalled(); expect(r.check).not.toHaveBeenCalled();
    } finally { declared.mockRestore(); }
  });
  it("withholds admission for occupied ports until the same stop grace expires", async () => {
    const r = rig(); r.deps.checkListeners = async () => [{ listener: "member", reason: "occupied" }];
    await expect(waitForHubServiceStart(r.home, r.deps)).rejects.toMatchObject({ reason: "timeout" }); expect(r.time()).toBe(FLEET_STOP_TIMEOUT_MS);
  });
  it("refuses a changed plan after the asynchronous bind check", async () => {
    const r = rig(); r.deps.checkListeners = async () => { writeFileSync(r.file, r.config(false)); return []; };
    await expect(waitForHubServiceStart(r.home, r.deps)).rejects.toMatchObject({ reason: "config" });
  });
  it("refuses invalid listener settings before process inspection", async () => {
    const r = rig(); writeFileSync(r.file, JSON.stringify({ hub: { enabled: true } }));
    await expect(waitForHubServiceStart(r.home, r.deps)).rejects.toMatchObject({ reason: "config" }); expect(r.inspect).not.toHaveBeenCalled();
  });
  it("refuses non-occupancy errors and thrown bind errors without spending the stop grace", async () => {
    const r = rig(); r.deps.checkListeners = async () => [{ listener: "web", reason: "interface" }];
    await expect(waitForHubServiceStart(r.home, r.deps)).rejects.toMatchObject({ reason: "listeners" }); expect(r.time()).toBe(0);
    r.deps.checkListeners = async () => { throw Error("SENSITIVE SENTINEL"); };
    await expect(waitForHubServiceStart(r.home, r.deps)).rejects.toMatchObject({ reason: "listeners", message: "hub_service_start_listeners" });
  });
  it("waits for an owned socket to close, using the real default bind checker and releasing its probes", async () => {
    const r = rig(), a = await bind(), b = await bind();
    const listeners = { webListen: { host: "127.0.0.1", port: a.port }, memberListen: { host: "127.0.0.1", port: b.port } };
    await new Promise<void>(resolve => a.server.close(() => resolve()));
    writeFileSync(r.file, JSON.stringify({ hub: { enabled: true, ...listeners } }));
    let waited = 0;
    await waitForHubServiceStart(r.home, { now: () => 0, sleep: async () => { expect(++waited).toBe(1); await new Promise<void>(resolve => b.server.close(() => resolve())); } });
    expect(waited).toBe(1); expect(b.server.listening).toBe(false);
    expect((await bind(a.port)).port).toBe(a.port); expect((await bind(b.port)).port).toBe(b.port);
  });
});
describe("Hub install observes PID claims without signals or deletion", () => {
  it("accepts no old record or a positively gone old process, preserving the file", () => {
    const r = rig(); expect(() => assertHubServiceInstallIdle(r.home, r.inspect)).not.toThrow(); expect(r.inspect).not.toHaveBeenCalled();
    writeFileSync(r.pid, "40"); expect(() => assertHubServiceInstallIdle(r.home, r.inspect)).not.toThrow(); expect(readFileSync(r.pid, "utf8")).toBe("40");
  });
  it.each(["unknown", { birth: "live" }] as ServiceProcessState[])("refuses %j without removing its claim", state => {
    const r = rig(); writeFileSync(r.pid, "40");
    expect(() => assertHubServiceInstallIdle(r.home, () => state)).toThrow("hub_service_start_process"); expect(readFileSync(r.pid, "utf8")).toBe("40");
  });
});
