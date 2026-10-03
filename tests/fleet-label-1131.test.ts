/**
 * Several AgEnD fleets' bots can share one Discord guild, each registering its
 * own `/login`: the slash menu listed identical commands, and a user picked
 * the wrong fleet's picker without any way to tell (#1131 follow-up). The
 * fleet's label now names the fleet in those commands and in both pickers.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Status, type Client } from "discord.js";
import { fleetLabel, FLEET_LABEL_MAX } from "../src/fleet-label.js";
import { DiscordAdapter, withFleetLabel } from "../src/channel/adapters/discord.js";
import { createAdapter } from "../src/channel/factory.js";
import { FleetManager } from "../src/fleet-manager.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { t } from "../src/locale.js";

const realHome = join(userInfo().homedir || homedir(), ".agend");
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => { const d = join(tmpdir(), `agend-label-${process.pid}-${Date.now()}-${dirs.length}`); mkdirSync(d, { recursive: true }); dirs.push(d); return d; };

describe("fleetLabel", () => {
  it("fleet_label wins; otherwise the host name, plus the home's name when it is not the default one", () => {
    expect(fleetLabel({ fleet_label: "  lab-box  " }, realHome, "han-pc")).toBe("lab-box");
    expect(fleetLabel({}, realHome, "han-pc")).toBe("han-pc");
    expect(fleetLabel({ fleet_label: "   " }, realHome, "han-pc")).toBe("han-pc");
    expect(fleetLabel(null, "/srv/agend-team", "han-pc")).toBe("han-pc · agend-team");
  });

  it("is short enough for a slash command description", () => {
    const label = fleetLabel({ fleet_label: "x".repeat(80) }, realHome, "h");
    expect(label.length).toBe(FLEET_LABEL_MAX);
    expect(label.endsWith("…")).toBe(true);
  });

  it("the description keeps its label within Discord's 100 characters", () => {
    expect(withFleetLabel("🔒 Re-login", "han-pc")).toBe("🔒 Re-login · han-pc");
    expect(withFleetLabel("🔒 Re-login", undefined)).toBe("🔒 Re-login");
    const long = withFleetLabel("d".repeat(95), "han-pc");
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.endsWith(" · han-pc")).toBe(true);
  });

  it("fleet.yaml: fleet_label must be a non-empty string", () => {
    const base = { instances: { general: { working_directory: "/tmp/g", general_topic: true } } };
    const paths = (c: Record<string, unknown>) => validateFleetConfig({ ...base, ...c }).errors.map(e => e.path);
    expect(paths({ fleet_label: "lab-box" })).not.toContain("fleet_label");
    expect(paths({ fleet_label: "" })).toContain("fleet_label");
    expect(paths({ fleet_label: 7 })).toContain("fleet_label");
  });
});

class FakeClient extends EventEmitter {
  user = { id: "bot", username: "bot", setActivity: vi.fn() };
  application = { commands: { set: vi.fn(async () => []) } };
  ws = { status: Status.Disconnected, shards: new Map([[0, { id: 0, status: Status.Disconnected, lastPingTimestamp: -1, ping: -1 }]]) };
  channels = { fetch: vi.fn() };
  guilds = { fetch: vi.fn() };
  rest = { put: vi.fn() };
  isReady() { return true; }
  async login() {
    this.ws.status = Status.Ready;
    for (const s of this.ws.shards.values()) s.status = Status.Ready;
    this.emit("clientReady", this);
    return "token";
  }
  destroy() { this.ws.status = Status.Disconnected; }
}

describe("Discord names the fleet in /login and /install-cli", () => {
  it("both descriptions carry the label the factory passes", async () => {
    const clients: FakeClient[] = [];
    const adapter = await createAdapter(
      { type: "discord", bot_token_env: "T", group_id: "guild" } as any,
      { id: "discord", botToken: "x", accessManager: {} as any, inboxDir: scratch(), registerCommands: true, fleetLabel: "han-pc" },
    ) as DiscordAdapter;
    (adapter as any).clientFactory = () => { const c = new FakeClient(); clients.push(c); return c as unknown as Client; };
    (adapter as any).client = (adapter as any).clientFactory();
    await adapter.start();
    const client = clients.at(-1)!;
    await vi.waitFor(() => expect(client.application.commands.set).toHaveBeenCalled());
    const commands = (client.application.commands.set.mock.calls[0] as any)[0] as Array<{ name: string; description: string }>;
    const description = (name: string) => commands.find(c => c.name === name)!.description;
    expect(description("login")).toBe(`🔒 ${t("slash.login")} · han-pc`);
    expect(description("install-cli")).toBe(`🔒 ${t("slash.install_cli")} · han-pc`);
    await adapter.stop();
  });
});

describe("the pickers say which fleet they belong to", () => {
  it("/login and /install-cli choosers end with the fleet line", async () => {
    const fm = new FleetManager(scratch());
    fm.fleetConfig = { defaults: {}, instances: {}, fleet_label: "lab-box" } as any;
    vi.spyOn(fm as any, "configuredBackendInstanceNames").mockReturnValue([]);
    vi.spyOn(fm as any, "probeInstalledBackends").mockReturnValue(new Set(["codex"]));
    const messages: string[] = [];
    const adapter = {
      id: "discord", type: "discord",
      notifyAlert: vi.fn(async (chatId: string, alert: { message: string }) => { messages.push(alert.message); return { messageId: "m", chatId }; }),
      sendText: vi.fn(async () => ({ messageId: "t", chatId: "c" })),
    } as any;
    await fm.promptLoginBackends({ adapter, adapterId: "discord", chatId: "c" });
    await fm.promptInstallBackends({ adapter, adapterId: "discord", chatId: "c" });
    expect(messages).toEqual([
      `${t("login.choose_backend")}\n${t("fleet.label_line", "lab-box")}`,
      `${t("install.choose_backend")}\n${t("fleet.label_line", "lab-box")}`,
    ]);
  });
});
