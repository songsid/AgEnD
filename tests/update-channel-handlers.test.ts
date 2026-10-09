/**
 * A chat `/update` (Discord slash, Telegram) runs a plain `agend update` and
 * leaves the channel to the installed CLI. It used to choose `--beta` from the
 * package.json next to its own code — a source checkout's 1.22.0 is "not a
 * beta" — and sent a beta install to @latest. Nothing here runs a process:
 * spawn is replaced and only its arguments are kept.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => [] as Array<{ cmd: string; args: string[] }>);
const registry = vi.hoisted(() => ({ tags: {} as Record<string, string>, views: [] as string[], prefix: null as string | null }));
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
      // `npm root -g` / `npm prefix -g`: the scratch global install (#1450 C5), or a failure when there is none.
      if (cmd === "npm" && args[1] === "-g" && (args[0] === "root" || args[0] === "prefix")) {
        if (!registry.prefix) return cb(new Error("npm: not found"));
        return cb(null, { stdout: `${args[0] === "root" ? join(registry.prefix, "lib", "node_modules") : registry.prefix}\n`, stderr: "" });
      }
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
import { DELAYED_UPDATE_SCRIPT } from "../src/update-dispatch.js";

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-update-channel-")); dirs.push(d); return d; };
afterEach(() => { spawned.length = 0; registry.tags = {}; registry.views = []; registry.prefix = null; installed.version = "2.1.11-beta.2"; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A global install the way npm lays it out: the package, and `<prefix>/bin/agend` linking to its bin. */
function globalInstall(opts: { linkElsewhere?: boolean; name?: string } = {}): string {
  const prefix = scratch();
  const pkg = join(prefix, "lib", "node_modules", "@songsid", "agend");
  mkdirSync(join(pkg, "launcher"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: opts.name ?? "@songsid/agend", version: "2.2.0-beta.1", bin: { agend: "./launcher/agend" } }));
  writeFileSync(join(pkg, "launcher", "agend"), "#!/bin/sh\n");
  mkdirSync(join(prefix, "bin"));
  const checkout = join(prefix, "checkout-agend");
  writeFileSync(checkout, "#!/bin/sh\n");
  symlinkSync(opts.linkElsewhere ? checkout : join("..", "lib", "node_modules", "@songsid", "agend", "launcher", "agend"), join(prefix, "bin", "agend"));
  registry.prefix = prefix;
  return prefix;
}
/** No channel flag: the installed CLI picks its channel; the path is data (positional), never spliced. */
const PLAIN = (prefix: string) => ["-c", DELAYED_UPDATE_SCRIPT, "sh", join(prefix, "bin", "agend")];

describe("a chat /update runs the installed `agend update`, by absolute path", () => {
  it("the command carries no channel flag", () => {
    expect(DELAYED_UPDATE_SCRIPT).toBe('sleep 2 && exec "$1" update');
  });

  it("Discord slash", async () => {
    const prefix = globalInstall();
    const fm = new FleetManager(scratch());
    try {
      Object.assign(fm, { fleetAdminGate: () => "ok" });
      const respond = vi.fn().mockResolvedValue(undefined);
      await (fm as any).handleUpdateSlash({ command: "update", channelId: "c1", userId: "admin", respond }, "discord-main");
      expect(spawned).toEqual([{ cmd: "sh", args: PLAIN(prefix) }]);
    } finally { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); }
  });

  it("Telegram", async () => {
    const prefix = globalInstall();
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
    expect(spawned).toEqual([{ cmd: "sh", args: PLAIN(prefix) }]);
  });

  // No unverified fallback (Prism v2-3): whatever `agend` is on PATH is never run instead.
  it.each([
    ["npm cannot say where AgEnD is installed", () => {}, "npm could not say"],
    ["its bin link leads elsewhere (a checkout)", () => { globalInstall({ linkElsewhere: true }); }, "not the installed package's"],
    ["what npm's root holds there is not @songsid/agend", () => { globalInstall({ name: "@suzuke/agend" }); }, "is not an installed AgEnD package"],
  ] as const)("refused, nothing dispatched: %s", async (_n, arrange, reason) => {
    arrange();
    const fm = new FleetManager(scratch());
    const failed: string[] = [];
    try {
      Object.assign(fm, { fleetAdminGate: () => "ok", failUpdateProgress: (m: string) => { failed.push(m); } });
      const respond = vi.fn().mockResolvedValue(undefined);
      await (fm as any).handleUpdateSlash({ command: "update", channelId: "c1", userId: "admin", respond }, "discord-main");
      expect(spawned).toEqual([]);
      expect(failed).toEqual([expect.stringContaining(reason)]);
      expect(failed[0]).toContain("Run `agend update` from a shell");
    } finally { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); }
  });

  it("Telegram refuses the same way: nothing dispatched", async () => {
    globalInstall({ linkElsewhere: true });
    const failed: string[] = [];
    const sendText = vi.fn().mockResolvedValue({ messageId: "p1", chatId: "chat", threadId: "1" });
    const adapter = { id: "telegram-main", type: "telegram", sendText };
    const commands = new TopicCommands({
      adapter, adapters: new Map([["telegram-main", adapter]]),
      fleetConfig: { channel: { access: { allowed_users: ["admin"] } } },
      hasFleetAdmins: () => true, isFleetAdmin: (u: string) => u === "admin",
      dataDir: scratch(), failUpdateProgress: (m: string) => { failed.push(m); },
    } as any);
    const msg = { text: "/update", chatId: "chat", threadId: "1", messageId: "m", userId: "admin", adapterId: "telegram-main", username: "op", timestamp: new Date() } as any;
    expect(await commands.handleGeneralCommand(msg)).toBe(true);
    expect(spawned).toEqual([]);
    expect(failed).toEqual([expect.stringContaining("not the installed package's")]);
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

  it("an alpha install (#1259) looks at @alpha and @latest, never @beta, and hears about the next alpha", async () => {
    const tags = { "@songsid/agend": "2.1.11", "@songsid/agend@beta": "2.1.12-beta.9", "@songsid/agend@alpha": "2.2.0-alpha.2" };
    const { posted, views } = await notice("2.2.0-alpha.1", tags);
    expect(views.sort()).toEqual(["@songsid/agend", "@songsid/agend@alpha"]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("v2.2.0-alpha.2");
  });

  it("an alpha install hears about a stable that passed it (with --stable), and nothing about an older beta", async () => {
    const newer = await notice("2.2.0-alpha.3", { "@songsid/agend": "2.2.1", "@songsid/agend@alpha": "2.2.0-alpha.3" });
    expect(newer.posted).toHaveLength(1);
    expect(newer.posted[0]).toContain("v2.2.1");
    expect(newer.posted[0]).toContain("--stable");
    // The rule beta installs already have: a stable of the SAME core is not offered (a prerelease may continue
    // after it). So when 2.2.0 ships, the release moves @alpha to it (see docs/cli.md).
    const sameCore = await notice("2.2.0-alpha.3", { "@songsid/agend": "2.2.0", "@songsid/agend@alpha": "2.2.0-alpha.3" });
    expect(sameCore.posted).toEqual([]);
    const quiet = await notice("2.2.0-alpha.3", { "@songsid/agend": "2.1.11", "@songsid/agend@beta": "2.1.12-beta.9", "@songsid/agend@alpha": "2.2.0-alpha.3" });
    expect(quiet.posted).toEqual([]);
  });

  it("a beta install still looks at @beta and @latest, never @alpha", async () => {
    const tags = { "@songsid/agend": "2.1.11", "@songsid/agend@beta": "2.1.12-beta.5", "@songsid/agend@alpha": "2.2.0-alpha.1" };
    const { posted, views } = await notice("2.1.12-beta.4", tags);
    expect(views.sort()).toEqual(["@songsid/agend", "@songsid/agend@beta"]);
    expect(posted[0]).toContain("v2.1.12-beta.5");
  });

  it("a stable install looks at @latest only", async () => {
    const { posted, views } = await notice("2.1.10", { "@songsid/agend": "2.1.11", "@songsid/agend@beta": "2.1.12-beta.1" });
    expect(views).toEqual(["@songsid/agend"]);
    expect(posted[0]).toContain("v2.1.11");
  });
});
