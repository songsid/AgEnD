/**
 * A chat `/update` (Discord slash, Telegram) runs a plain `agend update` and
 * leaves the channel to the installed CLI. It used to choose `--beta` from the
 * package.json next to its own code — a source checkout's 1.22.0 is "not a
 * beta" — and sent a beta install to @latest. Nothing here runs a process:
 * spawn is replaced and only its arguments are kept.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => [] as Array<{ cmd: string; args: string[] }>);
const registry = vi.hoisted(() => ({ tags: {} as Record<string, string>, views: [] as string[] }));
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: ((cmd: string, args: string[]) => {
      spawned.push({ cmd, args });
      return Object.assign(new EventEmitter(), { unref: () => {}, pid: 0 });
    }) as never,
    // `npm view <spec> version`, answered from `registry.tags`.
    execFile: ((cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void) => {
      const spec = args[1];
      registry.views.push(spec);
      const version = registry.tags[spec];
      if (cmd !== "npm" || version === undefined) cb(new Error(`no such tag: ${spec}`));
      else cb(null, { stdout: `${version}\n`, stderr: "" });
    }) as never,
  };
});

// Whatever version the code next to the handlers claims — here a beta — must not change what they run.
const installed = vi.hoisted(() => ({ version: "2.1.11-beta.2" }));
const pkgJson = () => JSON.stringify({ name: "@songsid/agend", version: installed.version });
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    readFileSync: ((path: unknown, ...rest: unknown[]) => String(path).endsWith("/package.json")
      ? pkgJson()
      : (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)) as typeof real.readFileSync,
  };
});
vi.mock("node:module", async importOriginal => {
  const real = await importOriginal<typeof import("node:module")>();
  return {
    ...real,
    createRequire: ((from: string | URL) => {
      const req = real.createRequire(from);
      return Object.assign((id: string) => id.endsWith("package.json") ? JSON.parse(pkgJson()) : req(id), req);
    }) as typeof real.createRequire,
  };
});

import { FleetManager } from "../src/fleet-manager.js";
import { TopicCommands } from "../src/topic-commands.js";
import { UPDATE_COMMAND } from "../src/update-check.js";

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-update-channel-")); dirs.push(d); return d; };
afterEach(() => { spawned.length = 0; registry.tags = {}; registry.views = []; installed.version = "2.1.11-beta.2"; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const PLAIN = ["-c", `sleep 2 && ${UPDATE_COMMAND}`];

describe("a chat /update runs a plain `agend update`", () => {
  it("the command carries no channel flag", () => {
    expect(UPDATE_COMMAND).toBe("agend update");
  });

  it("Discord slash", async () => {
    const fm = new FleetManager(scratch());
    try {
      Object.assign(fm, { fleetAdminGate: () => "ok" });
      const respond = vi.fn().mockResolvedValue(undefined);
      await (fm as any).handleUpdateSlash({ command: "update", channelId: "c1", userId: "admin", respond }, "discord-main");
      expect(spawned).toEqual([{ cmd: "sh", args: PLAIN }]);
    } finally { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); }
  });

  it("Telegram", async () => {
    const sendText = vi.fn().mockResolvedValue({ messageId: "p1", chatId: "chat", threadId: "1" });
    const adapter = { id: "telegram-main", type: "telegram", sendText };
    const commands = new TopicCommands({
      adapter, adapters: new Map([["telegram-main", adapter]]),
      fleetConfig: { channel: { access: { allowed_users: ["admin"] } } },
      hasFleetAdmins: () => true, isFleetAdmin: (u: string) => u === "admin",
      dataDir: scratch(),
    } as any);
    const msg = { text: "/update", chatId: "chat", threadId: "1", messageId: "m", userId: "admin", adapterId: "telegram-main", username: "op", timestamp: new Date() } as any;
    expect(await commands.handleGeneralCommand(msg)).toBe(true);
    expect(spawned).toEqual([{ cmd: "sh", args: PLAIN }]);
  });
});

describe("the update notice follows the same channel rule (#1182 review)", () => {
  async function notice(version: string, tags: Record<string, string>) {
    installed.version = version;
    registry.tags = tags;
    const fm = new FleetManager(scratch());
    const posted: string[] = [];
    try {
      Object.assign(fm, { findGeneralInstance: () => "general", notifyInstanceTopic: (_n: string, text: string) => { posted.push(text); } });
      await (fm as any).checkForUpdates();
    } finally { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); }
    return { posted, views: [...registry.views] };
  }

  it("an rc install is on @beta: it hears about a newer rc", async () => {
    const { posted, views } = await notice("2.1.11-rc.1", { "@songsid/agend": "2.1.10", "@songsid/agend@beta": "2.1.11-rc.2" });
    expect(views).toContain("@songsid/agend@beta");
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("v2.1.11-rc.2");
  });

  it("a stable install looks at @latest only", async () => {
    const { posted, views } = await notice("2.1.10", { "@songsid/agend": "2.1.11", "@songsid/agend@beta": "2.1.12-beta.1" });
    expect(views).toEqual(["@songsid/agend"]);
    expect(posted[0]).toContain("v2.1.11");
  });
});
