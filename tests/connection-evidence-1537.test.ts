/**
 * #1537 review: a connection is "Connected" only on evidence that its adapter logged in — through the real start paths.
 * A start skipped for a missing token, a Telegram adapter whose polling has not started (start() resolves before getMe),
 * and a Telegram 401 caught by the polling loop each read as what they are. And "rejected" comes only from an explicit
 * auth error, never a "401" inside a URL. createAdapter hands back a REAL TelegramAdapter whose bot.start is a stub (no
 * getUpdates/getMe) and whose API calls are answered locally; fetch is stubbed; nothing reaches Telegram.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrammyError } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelConfig, FleetConfig } from "../src/types.js";
import type { ChannelAdapter } from "../src/channel/types.js";

const made = vi.hoisted(() => ({ next: null as null | (() => ChannelAdapter), calls: 0 }));
vi.mock("../src/channel/factory.js", () => ({
  createAdapter: vi.fn(async () => { made.calls++; return made.next!(); }),
}));
import { FleetManager } from "../src/fleet-manager.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
// @ts-expect-error — a JS module of the app, with no types
import { connectionState } from "../src/ui/settings-model.js";
import { isRejectedTokenError } from "../src/discord-permissions.js";

const TOKEN_ENV = "AGEND_TEST_EVIDENCE_TOKEN";
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  made.next = null; made.calls = 0;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tg = (id: string): ChannelConfig => ({ id, type: "telegram", mode: "topic", bot_token_env: TOKEN_ENV, group_id: "-100", access: { mode: "locked", allowed_users: [] } } as unknown as ChannelConfig);
function fleet(channels: ChannelConfig[]) {
  const dir = mkdtempSync(join(tmpdir(), "agend-evidence-")); dirs.push(dir);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: true }) })));
  const fm = new FleetManager(dir) as any;
  fm.fleetConfig = { channels, defaults: {}, instances: {} } as FleetConfig;
  cleanups.push(() => clearInterval(fm.sessionPruneTimer));
  return { fm, dir };
}
/** A real TelegramAdapter whose polling is `start` (no network); its API answered locally. */
function realTelegram(dir: string, start: (opts: { onStart?: (info: { username: string; id: number }) => void }) => Promise<void>) {
  const adapter = new TelegramAdapter({ id: "tg", botToken: "123456:test-only", accessManager: { isAllowed: () => ({ allowed: true }) } as never, inboxDir: join(dir, "inbox") });
  cleanups.push(() => { void adapter.stop().catch(() => {}); (adapter as any).httpAgent?.destroy(); (adapter as any).httpsAgent?.destroy(); });
  (adapter.getBot() as any).api.config.use(async () => ({ ok: true, result: true }));
  vi.spyOn(adapter.getBot(), "start").mockImplementation(start as never);
  return adapter;
}
const rowOf = (fm: any, id: string) => {
  const meta = fm.listSecureConnections().find((c: any) => c.id === id);
  return { status: meta.status, problem: meta.problem ?? null, row: connectionState(meta, true).key };
};

describe("Connected only on evidence of a login", () => {
  it("a start skipped for a token that is only in .env (not this process): no adapter — Not running, never Connected", async () => {
    const { fm, dir } = fleet([tg("tg")]);
    writeFileSync(join(dir, ".env"), `${TOKEN_ENV}=from-the-file-only\n`);
    delete process.env[TOKEN_ENV];
    await fm.startSharedAdapter(fm.fleetConfig);
    expect([made.calls, fm.adapters.size]).toEqual([0, 0]);
    expect(rowOf(fm, "tg")).toEqual({ status: "stopped", problem: null, row: "connNotRunning" });
  });

  it("Telegram: start() resolved but polling not started (getMe pending) — Starting; onStart — Connected · @bot", async () => {
    const { fm, dir } = fleet([tg("primary-x"), tg("tg")]);
    vi.stubEnv(TOKEN_ENV, "123456:test-only");
    let onStart: ((info: { username: string; id: number }) => void) | undefined;
    made.next = () => realTelegram(dir, async (opts) => { onStart = opts.onStart; await new Promise(() => {}); });
    await fm.startSharedAdapter({ ...fm.fleetConfig, channels: [fm.fleetConfig.channels[1]] } as FleetConfig);
    expect(fm.adapters.has("tg"), "the adapter object exists").toBe(true);
    expect(rowOf(fm, "tg")).toEqual({ status: "starting", problem: null, row: "connStarting" });
    onStart!({ username: "control_bot", id: 42 });
    expect(rowOf(fm, "tg")).toEqual({ status: "connected", problem: null, row: "connConnectedAs" });
    expect(fm.listSecureConnections().find((c: any) => c.id === "tg").identity.username).toBe("control_bot");
  });

  it("Telegram: logged in, then its polling fails (a network error) — Reconnecting, not Connected", async () => {
    const { fm, dir } = fleet([tg("primary-x"), tg("tg")]);
    vi.stubEnv(TOKEN_ENV, "123456:test-only");
    let fail!: (err: Error) => void;
    let calls = 0;
    made.next = () => realTelegram(dir, async (opts) => {
      calls++;
      if (calls > 1) return new Promise(() => {});
      opts.onStart?.({ username: "control_bot", id: 42 });
      return new Promise((_, reject) => { fail = reject; });
    });
    await fm.startSharedAdapter({ ...fm.fleetConfig, channels: [fm.fleetConfig.channels[1]] } as FleetConfig);
    await vi.waitFor(() => expect(rowOf(fm, "tg").status).toBe("connected"));
    fail(new Error("request to https://api.telegram.org/bot123456:AA-401-ZZ/getUpdates failed, reason: connect ETIMEDOUT"));
    await new Promise(r => setImmediate(r));
    expect(rowOf(fm, "tg")).toEqual({ status: "retrying", problem: null, row: "connReconnecting" });
  });

  it("Telegram: a 401 caught by the polling loop — Token rejected, not Connected", async () => {
    const { fm, dir } = fleet([tg("primary-x"), tg("tg")]);
    vi.stubEnv(TOKEN_ENV, "123456:test-only");
    let thrown = false;
    made.next = () => realTelegram(dir, async () => {
      if (thrown) return new Promise(() => {});
      thrown = true;
      throw new GrammyError("Call to 'getMe' failed!", { ok: false, error_code: 401, description: "Unauthorized" }, "getMe", {});
    });
    vi.spyOn(globalThis, "setTimeout");
    await fm.startSharedAdapter({ ...fm.fleetConfig, channels: [fm.fleetConfig.channels[1]] } as FleetConfig);
    await vi.waitFor(() => expect(thrown).toBe(true));
    await new Promise(r => setImmediate(r));
    expect(rowOf(fm, "tg")).toEqual({ status: "failed", problem: "rejected", row: "connRejected" });
  });
});

describe("#1537 review r2: a past login is not lent to a stopped or restarting adapter", () => {
  it("logged in, then told to stop (its bot.stop still running): Not running — then started again (onStart pending): not Connected; its own onStart: Connected", async () => {
    const { fm, dir } = fleet([tg("primary-x"), tg("tg")]);
    vi.stubEnv(TOKEN_ENV, "123456:test-only");
    let onStart: ((info: { username: string; id: number }) => void) | undefined;
    let adapter!: TelegramAdapter;
    made.next = () => (adapter = realTelegram(dir, async (opts) => { onStart = opts.onStart; await new Promise(() => {}); }));
    await fm.startSharedAdapter({ ...fm.fleetConfig, channels: [fm.fleetConfig.channels[1]] } as FleetConfig);
    onStart!({ username: "control_bot", id: 42 });
    expect(rowOf(fm, "tg").row, "control: logged in").toBe("connConnectedAs");
    vi.spyOn(adapter.getBot(), "stop").mockImplementation(() => new Promise(() => {}));   // the stop is held
    void adapter.stop();
    expect(rowOf(fm, "tg")).toEqual({ status: "stopped", problem: null, row: "connNotRunning" });
    onStart = undefined;
    void adapter.start();                                                                     // a new start: its onStart held
    await new Promise(r => setImmediate(r));
    expect(rowOf(fm, "tg").row, "the old login is not this start's").not.toMatch(/^conn(ConnectedAs|ected)$/);
    expect(rowOf(fm, "tg").status).toBe("retrying");
    onStart!({ username: "control_bot", id: 42 });
    expect(rowOf(fm, "tg").row, "control: its own onStart").toBe("connConnectedAs");
  });
});

describe("rejected only from an explicit auth error", () => {
  it("real refusals are named; a 401 inside a URL or any transport detail is not", () => {
    expect(["An invalid token was provided.", "Error [TokenInvalid]: An invalid token was provided.", "Call to 'getMe' failed! (401: Unauthorized)", "401: Unauthorized"].map(isRejectedTokenError))
      .toEqual([true, true, true, true]);
    expect(["request to https://api.telegram.org/bot123456:AA-401-ZZ/getUpdates failed, reason: connect ETIMEDOUT", "getaddrinfo ENOTFOUND gateway.discord.gg",
      "HTTP 401 from a proxy", null].map(isRejectedTokenError)).toEqual([false, false, false, false]);
  });
  it("listSecureConnections: a transport error whose URL carries 401 is not 'rejected'", () => {
    const { fm } = fleet([tg("tg")]);
    vi.stubEnv(TOKEN_ENV, "123456:test-only");
    fm.adapterState.set("tg", { status: "retrying", retryCount: 1, lastError: "request to https://api.telegram.org/bot123456:AA-401-ZZ/getUpdates failed, reason: connect ETIMEDOUT" });
    expect(rowOf(fm, "tg")).toEqual({ status: "retrying", problem: null, row: "connReconnecting" });
  });
});
