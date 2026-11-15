import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
const homes: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
it("native-pane menus depend on configured policy, never Hub connection state", async () => {
 vi.stubEnv("AGEND_WINDOWS_CLI", "1"); vi.stubEnv("AGEND_REMOTE_RUNTIME", "1");
 const home = mkdtempSync(join(tmpdir(), "agend-native-catalog-")); homes.push(home);
 const fm: any = new FleetManager(home); let online = false;
 fm.fleetConfig = { defaults: {}, instances: { desk: { runtime: "windows", native_adapter: "pane", native_agent_id: "12345678-1234-4321-abcd-123456789012", working_directory: "C:\\work", backend: "codex", tool_set: "worker" } } };
 fm.hubRoomToolsAvailable = () => online;
 try {
  const options = (await fm.nativePanes()).options;
  const names = () => options.menu("desk").map((t: { name: string }) => t.name);
  const first = names(); expect(first).toEqual(expect.arrayContaining(["hub_room_list", "hub_room_post", "hub_room_members", "hub_people_search"]));
  online = true; expect(names()).toEqual(first); online = false; expect(names()).toEqual(first);
  for (const name of ["hub_room_list", "hub_room_post", "hub_room_members", "hub_people_search"]) expect(options.allowed("desk", name)).toBe(true);
  fm.fleetConfig.instances.desk.tool_set = "minimal";
  expect(names()).not.toContain("hub_room_post"); expect(options.allowed("desk", "hub_room_post")).toBe(false);
 } finally { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); }
});
