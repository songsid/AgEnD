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

// These existing channel/auth fixtures model a detached fleet outside a service cgroup.
// Native service launch selection is exercised separately in update-launch-1490.test.ts.
vi.mock("../src/update-launch.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/update-launch.js")>();
  return { ...real, resolveUpdateLaunch: (agend: string) => real.resolveUpdateLaunch(agend,
    { ...real.defaultUpdateLaunchDeps, platform: "linux", cgroup: async () => "0::/\n" }) };
});

import { FleetManager } from "../src/fleet-manager.js";
import { TopicCommands } from "../src/topic-commands.js";
import { DELAYED_UPDATE_SCRIPT } from "../src/update-dispatch.js";

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-update-channel-")); dirs.push(d); return d; };
afterEach(() => { spawned.length = 0; registry.tags = {}; registry.views = []; registry.prefix = null; installed.version = "2.1.11-beta.2"; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A global install the way npm lays it out: the package, and `<prefix>/bin/agend` linking to its bin. */
function globalInstall(opts: { linkElsewhere?: boolean; name?: string; manifest?: string } = {}): string {
  const prefix = scratch();
  const pkg = join(prefix, "lib", "node_modules", "@songsid", "agend");
  mkdirSync(join(pkg, "launcher"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), opts.manifest ?? JSON.stringify({ name: opts.name ?? "@songsid/agend", version: "2.2.0-beta.1", bin: { agend: "./launcher/agend" } }));
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
    expect(DELAYED_UPDATE_SCRIPT).toBe('sleep 2 && PATH="${1%/*}:$PATH" && export PATH && exec "$1" update');
  });

  it("Discord slash", async () => {
    const prefix = globalInstall();
    const fm = new FleetManager(scratch());
    try {
      Object.assign(fm, { fleetAdminGate: () => "ok" });
      const respond = vi.fn().mockResolvedValue(undefined);
      await (fm as any).handleUpdateSlash({ command: "update", channelId: "c1", userId: "admin", options: { now: true }, respond }, "discord-main");
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
      hasFleetAdmins: () => true, isFleetAdmin: (u: string) => u === "admin", isFleetStopping: () => false,
      dataDir: scratch(),
    } as any);
    const msg = { text: "/update now", chatId: "chat", threadId: "1", messageId: "m", userId: "admin", adapterId: "telegram-main", username: "op", timestamp: new Date() } as any;
    expect(await commands.handleGeneralCommand(msg)).toBe(true);
    expect(spawned).toEqual([{ cmd: "sh", args: PLAIN(prefix) }]);
  });

  it("bare /update and a bare slash do not launch", async () => {
    globalInstall();
    const fm = new FleetManager(scratch());
    const respond = vi.fn().mockResolvedValue(undefined);
    try {
      Object.assign(fm, { fleetAdminGate: () => "ok", runningAgendVersion: () => "2.2.0" });
      await (fm as any).handleUpdateSlash({ command: "update", channelId: "c1", userId: "admin", respond }, "discord-main");
      expect(spawned).toEqual([]);
      expect(String(respond.mock.calls[0]?.[0])).toContain("already current");
    } finally {
      try { (fm as any).updateCard?.close(); } catch { /* already closed */ }
      fm.stormWindow.shutdown(); fm.spawnGate.shutdown();
    }
    const sendText = vi.fn().mockResolvedValue({ messageId: "p1", chatId: "chat", threadId: "1" });
    const adapter = { id: "telegram-main", type: "telegram", sendText };
    const commands = new TopicCommands({
      adapter, adapters: new Map([["telegram-main", adapter]]),
      fleetConfig: { channel: { access: { allowed_users: ["admin"] } } },
      hasFleetAdmins: () => true, isFleetAdmin: (u: string) => u === "admin", isFleetStopping: () => false,
      dataDir: scratch(), describeUpdateOffer: () => "card words",
    } as any);
    const msg = { text: "/update", chatId: "chat", threadId: "1", messageId: "m", userId: "admin", adapterId: "telegram-main", username: "op", timestamp: new Date() } as any;
    expect(await commands.handleGeneralCommand(msg)).toBe(true);
    expect(sendText).toHaveBeenCalledWith("chat", "card words", { threadId: "1" });
    expect(spawned).toEqual([]);
    const stray = { ...msg, text: "/update nowhere" };
    expect(await commands.handleGeneralCommand(stray)).toBe(false);
  });

  // No unverified fallback (Prism v2-3): whatever `agend` is on PATH is never run instead.
  it.each([
    ["npm cannot say where AgEnD is installed", () => {}, "npm could not say"],
    ["its bin link leads elsewhere (a checkout)", () => { globalInstall({ linkElsewhere: true }); }, "not the installed package's"],
    ["what npm's root holds there is not @songsid/agend", () => { globalInstall({ name: "@suzuke/agend" }); }, "is not an installed AgEnD package"],
    // #1472 review: JSON that parses but is no manifest — judged by shape, never dereferenced (no TypeError escapes).
    ["its package.json is JSON null", () => { globalInstall({ manifest: "null" }); }, "is not an installed AgEnD package"],
    ["its package.json is an array", () => { globalInstall({ manifest: "[1]" }); }, "is not an installed AgEnD package"],
    ["its bin is null", () => { globalInstall({ manifest: JSON.stringify({ name: "@songsid/agend", version: "2.2.0", bin: null }) }); }, "is not an installed AgEnD package"],
  ] as const)("refused, nothing dispatched: %s", async (_n, arrange, reason) => {
    arrange();
    const fm = new FleetManager(scratch());
    const failed: string[] = [];
    try {
      Object.assign(fm, { fleetAdminGate: () => "ok", failUpdateProgress: (m: string) => { failed.push(m); } });
      const respond = vi.fn().mockResolvedValue(undefined);
      await (fm as any).handleUpdateSlash({ command: "update", channelId: "c1", userId: "admin", options: { now: true }, respond }, "discord-main");
      expect(spawned).toEqual([]);
      expect(failed).toEqual([expect.stringContaining(reason)]);
      expect(failed[0]).toContain("AgEnD could not finish the update automatically. Manual repair is not available here.");
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
      hasFleetAdmins: () => true, isFleetAdmin: (u: string) => u === "admin", isFleetStopping: () => false,
      dataDir: scratch(), failUpdateProgress: (m: string) => { failed.push(m); },
    } as any);
    const msg = { text: "/update now", chatId: "chat", threadId: "1", messageId: "m", userId: "admin", adapterId: "telegram-main", username: "op", timestamp: new Date() } as any;
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
    let card: { version: string; channel: string; installable: boolean } | null = null;
    try {
      // M-2738: the version this fleet runs is read once as it loads (RUNNING_AGEND_VERSION), not the file on disk at each check.
      Object.assign(fm, { runningAgendVersion: () => version, findGeneralInstance: () => "general", notifyInstanceTopic: (_n: string, text: string) => { posted.push(text); } });
      await (fm as any).checkForUpdates();
      card = (fm as any).updateOfferView();
    } finally {
      try { (fm as any).updateCard?.close(); } catch { /* already closed */ }
      fm.stormWindow.shutdown(); fm.spawnGate.shutdown();
    }
    return { posted, views: [...registry.views], card };
  }

  it("an rc install is on @beta: the card records a newer rc, and General is not posted", async () => {
    const { posted, views, card } = await notice("2.1.11-rc.1", { "@songsid/agend": "2.1.10", "@songsid/agend@beta": "2.1.11-rc.2" });
    expect(views).toContain("@songsid/agend@beta");
    expect(posted).toEqual([]);
    expect(card).toMatchObject({ version: "2.1.11-rc.2", channel: "beta", installable: true });
  });

  it("an alpha install (#1259) looks at @alpha and @latest, never @beta, and the card records the next alpha", async () => {
    const tags = { "@songsid/agend": "2.1.11", "@songsid/agend@beta": "2.1.12-beta.9", "@songsid/agend@alpha": "2.2.0-alpha.2" };
    const { posted, views, card } = await notice("2.2.0-alpha.1", tags);
    expect(views.sort()).toEqual(["@songsid/agend", "@songsid/agend@alpha"]);
    expect(posted).toEqual([]);
    expect(card).toMatchObject({ version: "2.2.0-alpha.2", channel: "alpha", installable: true });
  });

  it("an alpha install records a newer stable as not installable, and a same-core stable is no offer", async () => {
    const newer = await notice("2.2.0-alpha.3", { "@songsid/agend": "2.2.1", "@songsid/agend@alpha": "2.2.0-alpha.3" });
    expect(newer.posted).toEqual([]);
    expect(newer.card).toMatchObject({ version: "2.2.1", channel: "stable", installable: false });
    // The rule beta installs already have: a stable of the SAME core is not offered (a prerelease may continue
    // after it). So when 2.2.0 ships, the release moves @alpha to it (see docs/cli.md).
    const sameCore = await notice("2.2.0-alpha.3", { "@songsid/agend": "2.2.0", "@songsid/agend@alpha": "2.2.0-alpha.3" });
    expect(sameCore.posted).toEqual([]);
    expect(sameCore.card).toBeNull();
    const quiet = await notice("2.2.0-alpha.3", { "@songsid/agend": "2.1.11", "@songsid/agend@beta": "2.1.12-beta.9", "@songsid/agend@alpha": "2.2.0-alpha.3" });
    expect(quiet.posted).toEqual([]);
    expect(quiet.card).toBeNull();
  });

  // #1926: beta users stay on the beta line after a stable ships — their notice comes from @beta only. With 2.2.0
  // as @latest and beta.17 as @beta, a beta.16 install used to be told nothing (2.2.0 became the target, and the
  // same-core guard dropped it).
  describe("a beta install hears about @beta only (#1926)", () => {
    it("beta.16 with 2.2.0 out records beta.17 as installable, and General is not posted", async () => {
      const { posted, card } = await notice("2.2.0-beta.16", { "@songsid/agend": "2.2.0", "@songsid/agend@beta": "2.2.0-beta.17" });
      expect(posted).toEqual([]);
      expect(card).toMatchObject({ version: "2.2.0-beta.17", channel: "beta", installable: true });
    });
    it("beta.17 (the newest beta) with 2.2.0 out is silent", async () => {
      const { posted, card } = await notice("2.2.0-beta.17", { "@songsid/agend": "2.2.0", "@songsid/agend@beta": "2.2.0-beta.17" });
      expect(posted).toEqual([]);
      expect(card).toBeNull();
    });
    // #2775: no switch-to-stable offer for a beta install, whatever @latest holds.
    it("2.3.2-beta.16 with 2.3.3 on @latest: no offer while @beta has nothing newer, then only the next beta", async () => {
      const quiet = await notice("2.3.2-beta.16", { "@songsid/agend": "2.3.3", "@songsid/agend@beta": "2.3.2-beta.16" });
      expect(quiet.posted).toEqual([]);
      expect(quiet.card).toBeNull();
      const next = await notice("2.3.2-beta.16", { "@songsid/agend": "2.3.3", "@songsid/agend@beta": "2.3.3-beta.1" });
      expect(next.posted).toEqual([]);
      expect(next.card).toMatchObject({ version: "2.3.3-beta.1", channel: "beta", installable: true });
    });
    it("a stable of a higher core (2.2.1) does not reach a beta install either", async () => {
      const { posted, card } = await notice("2.2.0-beta.17", { "@songsid/agend": "2.2.1", "@songsid/agend@beta": "2.2.0-beta.17" });
      expect(posted).toEqual([]);
      expect(card).toBeNull();
    });
  });

  // #1928 review: once the release points the install's own channel tag at the new stable, /update installs it.
  it.each([
    ["an alpha, after the release points @alpha at 2.2.0", "2.2.0-alpha.4", { "@songsid/agend": "2.2.0", "@songsid/agend@alpha": "2.2.0" }, "alpha"],
    ["a beta, if @beta is pointed at 2.2.0", "2.2.0-beta.17", { "@songsid/agend": "2.2.0", "@songsid/agend@beta": "2.2.0" }, "beta"],
  ] as const)("%s: the card is installable on that channel", async (_n, version, tags, channel) => {
    const { posted, card } = await notice(version, tags);
    expect(posted).toEqual([]);
    expect(card).toMatchObject({ version: "2.2.0", channel, installable: true });
  });

  it("an alpha install is not left without an offer by a same-core stable: the newer alpha is the card (#1926)", async () => {
    const { posted, card } = await notice("2.2.0-alpha.3", { "@songsid/agend": "2.2.0", "@songsid/agend@alpha": "2.2.0-alpha.4" });
    expect(posted).toEqual([]);
    expect(card).toMatchObject({ version: "2.2.0-alpha.4", channel: "alpha", installable: true });
  });

  it("a beta install still looks at @beta and @latest, never @alpha", async () => {
    const tags = { "@songsid/agend": "2.1.11", "@songsid/agend@beta": "2.1.12-beta.5", "@songsid/agend@alpha": "2.2.0-alpha.1" };
    const { posted, views, card } = await notice("2.1.12-beta.4", tags);
    expect(views.sort()).toEqual(["@songsid/agend", "@songsid/agend@beta"]);
    expect(posted).toEqual([]);
    expect(card).toMatchObject({ version: "2.1.12-beta.5", channel: "beta", installable: true });
  });

  it("a stable install looks at @latest only", async () => {
    const { posted, views, card } = await notice("2.1.10", { "@songsid/agend": "2.1.11", "@songsid/agend@beta": "2.1.12-beta.1" });
    expect(views).toEqual(["@songsid/agend"]);
    expect(posted).toEqual([]);
    expect(card).toMatchObject({ version: "2.1.11", channel: "stable", installable: true });
  });
});
