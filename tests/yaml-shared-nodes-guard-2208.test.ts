/**
 * #2208: the save's own check, by itself. With the unsharing of a written place switched off (detachForWrite a no-op),
 * a Settings save through a shared node must refuse — naming the other place — and leave fleet.yaml as it was, never
 * write the other connection's change.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "agend-2208-guard-"));
process.env.AGEND_HOME = home;
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));
vi.mock("../src/yaml-shared-nodes.js", async original => ({ ...await original<typeof import("../src/yaml-shared-nodes.js")>(), detachForWrite: vi.fn() }));

let FleetManager: typeof import("../src/fleet-manager.js").FleetManager;
beforeAll(async () => { ({ FleetManager } = await import("../src/fleet-manager.js")); });
afterAll(() => rmSync(home, { recursive: true, force: true }));

it("a save that would also change the place sharing the node refuses, and fleet.yaml is untouched", () => {
  const path = join(home, "fleet.yaml");
  const text = `channels:
  - id: main
    type: telegram
    bot_token_env: MAIN_BOT_TOKEN
    group_id: "-1001"
    access:
      mode: locked
      allowed_users: &admins ["111"]
  - id: side
    type: telegram
    bot_token_env: SIDE_BOT_TOKEN
    group_id: "-1002"
    access:
      mode: locked
      allowed_users: *admins
instances:
  general:
    working_directory: /tmp
    general_topic: true
`;
  writeFileSync(path, text);
  const fm = new FleetManager(home) as any;
  fm.loadConfig(path);
  const list = JSON.parse(JSON.stringify(fm.fleetConfig.channels)); list[0].access.allowed_users = ["111", "222"]; fm.fleetConfig.channels = list;
  expect(() => fm.saveFleetConfig()).toThrow(/Refusing to save fleet\.yaml: this change would also change channels\.1\.access\.allowed_users/);
  expect(readFileSync(path, "utf8")).toBe(text);
});
