/**
 * #1137 wiring: with no test seams, the controller asks the real installer for
 * a cloudflared in AgEnD's data directory, and the provider it builds runs
 * exactly that binary.
 */
import { describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ providers: [] as Array<Record<string, unknown>>, ensures: [] as Array<Record<string, unknown>> }));
vi.mock("../src/tunnel/cloudflared.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/tunnel/cloudflared.js")>();
  class RecordingProvider extends real.CloudflaredProvider {
    constructor(opts: ConstructorParameters<typeof real.CloudflaredProvider>[0] = {}) { super(opts); seen.providers.push(opts as Record<string, unknown>); }
  }
  return { ...real, CloudflaredProvider: RecordingProvider };
});
vi.mock("../src/tunnel/cloudflared-install.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/tunnel/cloudflared-install.js")>();
  return { ...real, ensureCloudflared: vi.fn(async (opts: Record<string, unknown>) => { seen.ensures.push(opts); return { path: "/data/bin/cloudflared", source: "agend" }; }) };
});

import { LoginController, type LoginControllerDeps } from "../src/login-controller.js";

describe("default cloudflared wiring", () => {
  it("installs into tunnelDataDir() and hands that binary to the provider", async () => {
    const controller = new LoginController({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      tunnelDataDir: () => "/data",
    } as unknown as LoginControllerDeps);
    const chat = { adapter: { sendText: vi.fn(async () => ({})) }, chatId: "c" } as never;
    expect(await (controller as any).obtainCloudflared(chat, "kiro-cli")).toEqual({ ok: true, path: "/data/bin/cloudflared" });
    expect(seen.ensures[0]).toMatchObject({ dataDir: "/data" });
    (controller as any).tunnelPort({ web_terminal: { tunnel: { protocol: "quic" } } }, "/data/bin/cloudflared");
    expect(seen.providers[0]).toMatchObject({ binaryName: "/data/bin/cloudflared", protocol: "quic" });
  });
});

describe("Telegram parity: the public-link confirmation fits Telegram's callback_data", () => {
  it("every action's callback id is at most 64 bytes (posted through the fleet's real prompt)", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const fm = new FleetManager(mkdtempSync(join(tmpdir(), "agend-tg-cb-")));
    const ids: string[] = [];
    const adapter = { id: "telegram", type: "telegram", notifyAlert: vi.fn(async (chatId: string, alert: { choices: Array<{ id: string }> }) => { ids.push(...alert.choices.map(c => c.id)); return { messageId: "m", chatId }; }) } as never;
    await (fm as any).webLogin.deps.postButtons({
      prefix: "login-confirm:", instanceName: "kiro-cli",
      chat: { adapter, adapterId: "telegram", chatId: "-100123", threadId: "5" },
      message: "Sign in?",
      choices: ["go-relogin-tunnel", "go-tunnel", "go-relogin", "go", "cancel"].map(action => ({ action, label: action })),
      expiredText: "expired",
    });
    expect(ids).toHaveLength(5);
    for (const id of ids) expect(Buffer.byteLength(id, "utf8"), id).toBeLessThanOrEqual(64);
  });
});

describe("the fleet's /login cancel reaches a public-link start that is still downloading (#1141 review)", () => {
  it("cancelLoginSession → cancelled; the start opens nothing", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { t } = await import("../src/locale.js");
    const fm = new FleetManager(mkdtempSync(join(tmpdir(), "agend-cancel-dl-")));
    fm.fleetConfig = { defaults: {}, instances: {} } as never;
    vi.spyOn(fm, "isFleetAdmin").mockReturnValue(true);
    const controller = (fm as any).webLogin;
    let signal: AbortSignal | null = null;
    controller.deps.ensureCloudflared = (_on: unknown, s: AbortSignal) => new Promise((_, reject) => {
      signal = s;
      s.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { kind: "cancelled" })));
    });
    const createSession = vi.fn();
    controller.deps.createSession = createSession;
    const adapter = { id: "discord", type: "discord", sendText: vi.fn(async () => ({})) } as never;
    const starting = controller.start("kiro-cli", { adapter, adapterId: "discord", chatId: "c", threadId: "t", userId: "admin" }, { skipAuthCheck: true, tunnel: true });
    await vi.waitFor(() => expect(signal).not.toBeNull());
    expect(await fm.cancelLoginSession()).toBe(t("login.cancelled", "kiro-cli"));
    expect(await starting).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect((fm as any).loginWindow.isHeld).toBe(false);
  });
});
