/**
 * #3440 (#3442 review F2): both production `/update` callers hand the proved npm's directory (`npmDir`) to the launch —
 * dropping it at either call site would launch the updater without it, and a custom-prefix install would fall back to
 * whatever npm is first on PATH. The real handlers (slash `/update` in FleetManager, General's `/update` in
 * TopicCommands) with a resolver that returns an npmDir; spawn is replaced and its argv kept.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => [] as Array<{ cmd: string; args: string[] }>);
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real, spawn: ((cmd: string, args: string[]) => { spawned.push({ cmd, args }); return Object.assign(new EventEmitter(), { unref: () => {}, pid: 0 }); }) as never };
});
const AGEND = "/home/u/.npm-global/bin/agend", NPM_DIR = "/opt/node/bin";
vi.mock("../src/update-dispatch.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/update-dispatch.js")>();
  return { ...real, resolveInstalledAgend: vi.fn(async () => ({ ok: true, agend: AGEND, version: "2.3.5-beta.1", npmDir: NPM_DIR })) };
});
// The launch decision as on a host: outside a service, or under the user manager (systemd 255 → a --scope).
const host = vi.hoisted(() => ({ scope: false }));
vi.mock("../src/update-launch.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/update-launch.js")>();
  return { ...real, resolveUpdateLaunch: (agend: string, _deps: unknown, npmDir?: string) => real.resolveUpdateLaunch(agend, {
    ...real.defaultUpdateLaunchDeps, platform: "linux", uid: () => 1000, nonce: () => "b".repeat(32), version: async () => "systemd 255 (255.4-1)",
    cgroup: async () => host.scope ? "0::/user.slice/user-1000.slice/user@1000.service/app.slice/com.agend.fleet.service\n" : "0::/\n",
  }, npmDir) };
});

import { FleetManager } from "../src/fleet-manager.js";
import { TopicCommands } from "../src/topic-commands.js";
import { DELAYED_UPDATE_SCRIPT_NPM } from "../src/update-dispatch.js";

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-3440-callers-")); dirs.push(d); return d; };
afterEach(() => { spawned.length = 0; host.scope = false; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const TAIL = ["sh", "-c", DELAYED_UPDATE_SCRIPT_NPM, "sh", AGEND, NPM_DIR];

async function slash(): Promise<void> {
  const fm = new FleetManager(scratch());
  try {
    Object.assign(fm, { fleetAdminGate: () => "ok" });
    await (fm as any).handleUpdateSlash({ command: "update", channelId: "c1", userId: "admin", respond: vi.fn().mockResolvedValue(undefined) }, "discord-main");
  } finally { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); }
}
async function general(): Promise<void> {
  const sendText = vi.fn().mockResolvedValue({ messageId: "p1", chatId: "chat", threadId: "1" });
  const adapter = { id: "telegram-main", type: "telegram", sendText };
  const commands = new TopicCommands({
    adapter, adapters: new Map([["telegram-main", adapter]]), fleetConfig: { channel: { access: { allowed_users: ["admin"] } } },
    hasFleetAdmins: () => true, isFleetAdmin: (u: string) => u === "admin", isFleetStopping: () => false, dataDir: scratch(),
  } as any);
  expect(await commands.handleGeneralCommand({ text: "/update", chatId: "chat", threadId: "1", messageId: "m", userId: "admin", adapterId: "telegram-main", username: "op", timestamp: new Date() } as any)).toBe(true);
}

describe("#3440 F2: each /update caller carries the proved npm's directory into the launch", () => {
  for (const [name, run] of [["slash /update (FleetManager)", slash], ["General /update (TopicCommands)", general]] as const) {
    it(`${name}: outside a service, the updater's argv ends with <agend> <npmDir>`, async () => {
      await run();
      expect(spawned).toEqual([{ cmd: "sh", args: TAIL.slice(1) }]);
    });
    it(`${name}: under the user manager, the --scope argv carries it the same`, async () => {
      host.scope = true;
      await run();
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.cmd).toBe("systemd-run");
      expect(spawned[0]!.args.slice(-TAIL.length)).toEqual(TAIL);
    });
  }
});
