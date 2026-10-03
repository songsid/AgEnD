/**
 * #1131: a rejected Discord slash command registration was swallowed without
 * a log line. Discord then keeps the previous command list, so a new command
 * (the user was looking for /install-cli) silently never appears. Every
 * outcome is now reported: logged, and General told once per failure streak.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Status, type Client } from "discord.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => { const d = join(tmpdir(), `agend-slashreg-${process.pid}-${Date.now()}-${dirs.length}`); mkdirSync(d, { recursive: true }); dirs.push(d); return d; };

class FakeClient extends EventEmitter {
  user = { id: "bot", username: "bot", setActivity: vi.fn() };
  application = { commands: { set: vi.fn(async (commands: unknown[]) => new Map(commands.map((_, i) => [String(i), {}]))) } };
  ws = { status: Status.Disconnected, shards: new Map([[0, { id: 0, status: Status.Disconnected, lastPingTimestamp: -1, ping: -1 }]]) };
  channels = { fetch: vi.fn() };
  guilds = { fetch: vi.fn() };
  rest = { put: vi.fn() };
  isReady() { return this.ws.status === Status.Ready; }
  async login() {
    this.ws.status = Status.Ready;
    for (const s of this.ws.shards.values()) s.status = Status.Ready;
    this.emit("clientReady", this);
    return "token";
  }
  destroy() { this.ws.status = Status.Disconnected; }
}

async function register(setImpl?: () => Promise<unknown>) {
  let client!: FakeClient;
  const adapter = new DiscordAdapter({
    id: "discord", botToken: "x", accessManager: {} as any, inboxDir: scratch(), guildId: "g", registerCommands: true,
    clientFactory: () => { client = new FakeClient(); if (setImpl) client.application.commands.set.mockImplementation(setImpl as any); return client as unknown as Client; },
  });
  const outcomes: unknown[] = [];
  adapter.on("slash_registration", o => outcomes.push(o));
  await adapter.start();
  await vi.waitFor(() => expect(outcomes).toHaveLength(1));
  await adapter.stop();
  return outcomes[0] as Record<string, unknown>;
}

describe("the Discord adapter reports every registration", () => {
  it("success, with how many commands Discord now has", async () => {
    const outcome = await register();
    expect(outcome.ok).toBe(true);
    expect(outcome.count).toBeGreaterThan(20);
  });

  it("a rejection, with Discord's code and message", async () => {
    const outcome = await register(async () => { throw Object.assign(new Error("Invalid Form Body\n18.options[0].description[BASE_TYPE_BAD_LENGTH]"), { code: 50035, status: 400 }); });
    expect(outcome).toMatchObject({ ok: false, code: 50035, status: 400 });
    expect(String(outcome.message)).toContain("BASE_TYPE_BAD_LENGTH");
  });
});

describe("the fleet logs it and tells General once per failure streak", () => {
  it("failure → warn + one General notice; repeats stay in the log; success resets", () => {
    const fm = new FleetManager(scratch());
    const adapter = new EventEmitter() as any;
    (fm.adapters as Map<string, unknown>).set("discord", adapter);
    const notify = vi.spyOn(fm, "notifyFleetError").mockReturnValue(true);
    const warn = vi.spyOn(fm.logger, "warn");
    const info = vi.spyOn(fm.logger, "info");
    (fm as any).bindAdapterHealth(adapter, "discord");

    const failure = { ok: false, code: 50035, status: 400, message: "Invalid Form Body" };
    adapter.emit("slash_registration", failure);
    adapter.emit("slash_registration", failure);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ adapterId: "discord", code: 50035 }), expect.stringContaining("rejected the slash command registration"));
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0]).toContain("50035 Invalid Form Body");

    adapter.emit("slash_registration", { ok: true, count: 26 });
    expect(info).toHaveBeenCalledWith({ adapterId: "discord", count: 26 }, "Registered Discord slash commands");
    adapter.emit("slash_registration", failure);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  /** The real notifier, with General reachable or not; returns the bodies General got. */
  function realNotifier(fm: FleetManager) {
    fm.fleetConfig = { defaults: {}, instances: { general: { working_directory: "/tmp/g", general_topic: true } } } as any;
    const received: string[] = [];
    let reachable = true;
    vi.spyOn(fm, "notifyInstanceTopic").mockImplementation(((_name: string, text: string) => {
      if (!reachable) return false;
      received.push(text);
      return true;
    }) as any);
    return { received, setReachable: (v: boolean) => { reachable = v; } };
  }

  it("a second failure streak is told too, within the shared ten-minute throttle (real notifier)", () => {
    const fm = new FleetManager(scratch());
    const adapter = new EventEmitter() as any;
    (fm.adapters as Map<string, unknown>).set("discord", adapter);
    const { received } = realNotifier(fm);
    (fm as any).bindAdapterHealth(adapter, "discord");
    const failure = { ok: false, code: 50035, message: "Invalid Form Body" };
    adapter.emit("slash_registration", failure);
    adapter.emit("slash_registration", failure);            // same streak: no repeat
    adapter.emit("slash_registration", { ok: true, count: 26 });
    adapter.emit("slash_registration", failure);            // a new streak, minutes later
    expect(received).toHaveLength(2);
    expect(received[1]).toContain("50035 Invalid Form Body");
  });

  it("a failure nobody could be told about yet is told once General is reachable (real notifier)", () => {
    const fm = new FleetManager(scratch());
    const secondary = new EventEmitter() as any;
    (fm.adapters as Map<string, unknown>).set("persona", secondary);
    const { received, setReachable } = realNotifier(fm);
    (fm as any).bindAdapterHealth(secondary, "persona");
    setReachable(false);
    secondary.emit("slash_registration", { ok: false, message: "Missing Access" });
    expect(received).toHaveLength(0);
    setReachable(true);
    secondary.emit("slash_registration", { ok: false, message: "Missing Access" });
    expect(received).toHaveLength(1);
    expect(received[0]).toContain("persona");
  });

  it("adapters keep separate streaks", () => {
    const fm = new FleetManager(scratch());
    const a = new EventEmitter() as any;
    const b = new EventEmitter() as any;
    (fm.adapters as Map<string, unknown>).set("discord", a);
    (fm.adapters as Map<string, unknown>).set("persona", b);
    const { received } = realNotifier(fm);
    (fm as any).bindAdapterHealth(a, "discord");
    (fm as any).bindAdapterHealth(b, "persona");
    a.emit("slash_registration", { ok: false, message: "x" });
    b.emit("slash_registration", { ok: false, message: "x" });
    a.emit("slash_registration", { ok: false, message: "x" });
    expect(received).toHaveLength(2);
  });

  it("a replaced adapter's late report is ignored", () => {
    const fm = new FleetManager(scratch());
    const stale = new EventEmitter() as any;
    (fm.adapters as Map<string, unknown>).set("discord", new EventEmitter());
    const notify = vi.spyOn(fm, "notifyFleetError").mockReturnValue(true);
    (fm as any).bindAdapterHealth(stale, "discord");
    stale.emit("slash_registration", { ok: false, message: "x" });
    expect(notify).not.toHaveBeenCalled();
  });
});
