import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import {
  draftQuickstart,
  newConnectionConflict,
  nextChannelId,
  planQuickstart,
  runProviderProbe,
  upsertEnvLine,
  writeQuickstartSecret,
  type WizardEnvironment,
  type WizardPlanInput,
} from "../src/quickstart-api.js";
import { awaitTelegramGroupStart, detectInstalledBackends, TelegramPollConflictError } from "../src/provider-probe.js";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-wizard-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const EMPTY_ENV: WizardEnvironment = { backends: ["claude-code"], channels: [], has_fleet: false };
const BASE: WizardPlanInput = {
  platform: "telegram", token_env: "AGEND_BOT_TOKEN", backend: "claude-code",
  working_directory: "/tmp/app", instance_name: "agent-1",
};

describe("the plan the last step shows", () => {
  it("asks only for the id the chosen platform has", () => {
    const telegram = planQuickstart({ ...BASE, group_id: "-100123" }, EMPTY_ENV);
    const discord = planQuickstart({
      ...BASE, platform: "discord", guild_id: "999", general_channel_id: "888",
    }, EMPTY_ENV);

    expect(telegram.channel).toMatchObject({ type: "telegram", group_id: "-100123" });
    expect(telegram.channel).not.toHaveProperty("general_channel_id");
    expect(discord.channel).toMatchObject({ type: "discord", group_id: "999", general_channel_id: "888" });
  });

  it("never carries the token, only the variable name", () => {
    const plan = planQuickstart({ ...BASE, group_id: "-100123" }, EMPTY_ENV);

    expect(plan.env_keys).toEqual(["AGEND_BOT_TOKEN"]);
    expect(JSON.stringify(plan)).not.toContain("123456:");
  });

  it("#1519 P1 (S1): a token env another connection holds is refused — the wizard never replaces a connection", () => {
    const env = { channels: [{ id: "telegram", type: "telegram", token_env: "AGEND_BOT_TOKEN", group_id: null, allowed_users: ["42", "77"] }] };
    expect(newConnectionConflict({ token_env: "AGEND_BOT_TOKEN" }, env) ?? "").toMatch(/already holds the token of the "telegram" connection/);
    expect(newConnectionConflict({ token_env: "AGEND_TG_2_TOKEN", channel_id: "telegram" }, env) ?? "").toMatch(/already exists/);
    expect(newConnectionConflict({ token_env: "PATH" }, env) ?? "").toMatch(/reserved|UPPER_SNAKE/);
    expect(newConnectionConflict({ token_env: "AGEND_TG_2_TOKEN", channel_id: "telegram-2" }, env)).toBeNull();
  });

  it("says nothing about the allow list when nobody is dropped", () => {
    const plan = planQuickstart({ ...BASE, admin_user_id: "42" }, {
      ...EMPTY_ENV,
      channels: [{ id: "telegram", type: "telegram", token_env: "AGEND_BOT_TOKEN", group_id: null, allowed_users: ["42"] }],
    });

    expect(plan.warnings.join(" ")).not.toContain("no longer be able");
  });

  it("warns about an empty allow list and a missing backend", () => {
    const noAdmin = planQuickstart(BASE, EMPTY_ENV);
    const missing = planQuickstart({ ...BASE, admin_user_id: "7", backend: "codex" }, EMPTY_ENV);

    expect(noAdmin.warnings.join(" ")).toContain("nobody can drive the bot");
    expect(missing.warnings.join(" ")).toContain("not found on this host");
  });

  it("locks access to the admin who ran the wizard", () => {
    const plan = planQuickstart({ ...BASE, admin_user_id: "42" }, EMPTY_ENV);

    expect(plan.channel.access).toEqual({ mode: "locked", allowed_users: ["42"] });
  });
});

describe("the draft (what is confirmed and what is written) only ever adds", () => {
  const cfg = () => ({ defaults: {}, instances: { keep: { working_directory: "/k" } },
    channels: [{ id: "telegram", type: "telegram", bot_token_env: "AGEND_BOT_TOKEN", group_id: "-1", mode: "topic", access: { mode: "locked", allowed_users: ["9"] } }] }) as never;
  it("#1519 P1 (S1): even a body naming another connection's env leaves that connection exactly as it was", () => {
    const base = cfg(), before = structuredClone((base as any).channels[0]);
    const draft = draftQuickstart(base, BASE, planQuickstart(BASE, { ...EMPTY_ENV, channels: [{ id: "telegram", type: "telegram", token_env: "AGEND_BOT_TOKEN", group_id: "-1" }] })) as any;
    expect(draft.channels[0]).toEqual(before);
    expect(draft.channels).toHaveLength(2);
  });
  it("#1519 P1: connection_only adds no agent and leaves the agents as they were", () => {
    const base = cfg();
    const input = { platform: "discord", connection_only: true, token_env: "AGEND_DISCORD_TOKEN" } as WizardPlanInput;
    const draft = draftQuickstart(base, input, planQuickstart(input, EMPTY_ENV)) as any;
    expect(draft.instances).toEqual({ keep: { working_directory: "/k" } });
    expect(draft.channels.map((c: any) => c.id)).toEqual(["telegram", "discord"]);
  });
});

describe("naming a new connection", () => {
  it("takes the platform name when it is free, then numbers it — never an existing connection's id", () => {
    expect(nextChannelId("telegram", [])).toBe("telegram");
    expect(nextChannelId("telegram", [{ id: "telegram" }])).toBe("telegram-2");
    expect(nextChannelId("telegram", [{ id: "telegram" }, { id: "telegram-2" }, { id: "discord" }])).toBe("telegram-3");
  });

  it("#1519 P1: a plan without a token env gets a generated one, unique against connections, providers and .env", () => {
    const env = { ...EMPTY_ENV, channels: [{ id: "telegram", type: "telegram", token_env: "AGEND_TELEGRAM_TOKEN", group_id: null }] };
    const { token_env: _drop, ...noEnv } = BASE;
    const second = planQuickstart(noEnv as WizardPlanInput, env);
    expect([second.channel_id, second.token_env, second.channel.bot_token_env]).toEqual(["telegram-2", "AGEND_TELEGRAM_2_TOKEN", "AGEND_TELEGRAM_2_TOKEN"]);
    const taken = new Set(["AGEND_TELEGRAM_TOKEN", "AGEND_TELEGRAM_2_TOKEN"]);
    expect(planQuickstart(noEnv as WizardPlanInput, { ...env, taken_env: taken }).token_env).toBe("AGEND_TELEGRAM_2_2_TOKEN");
    expect(planQuickstart({ ...noEnv, platform: "discord", channel_id: "persona1" } as WizardPlanInput, EMPTY_ENV).token_env).toBe("AGEND_DISCORD_PERSONA1_TOKEN");
  });
});

describe("writing the token", () => {
  it("replaces the line for an existing variable and keeps the rest", () => {
    const before = "OTHER=1\nAGEND_BOT_TOKEN=old\nTHIRD=3\n";

    expect(upsertEnvLine(before, "AGEND_BOT_TOKEN", "new")).toBe("OTHER=1\nAGEND_BOT_TOKEN=new\nTHIRD=3\n");
    expect(upsertEnvLine(before, "SECOND_BOT", "x")).toContain("SECOND_BOT=x");
  });

  it("lands owner-only", () => {
    const dir = tempDir();

    const result = writeQuickstartSecret(dir, "AGEND_BOT_TOKEN", "123456:ABC");

    expect(result.ok).toBe(true);
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("AGEND_BOT_TOKEN=123456:ABC");
  });
});

describe("the provider probes", () => {
  it("refuses to poll a token the running fleet is already polling", async () => {
    // getUpdates has one consumer: a second poller makes both miss messages, so
    // the wizard must not quietly break the live bot while it waits.
    const result = await runProviderProbe(
      { action: "await-telegram-start", token: "live-token" },
      { isTokenInUse: token => token === "live-token" },
    );

    expect(result).toMatchObject({ ok: false, conflict: true });
    expect((result as { error: string }).error).toContain("stop AgEnD");
  });

  it("reports Telegram's own conflict answer as a conflict", async () => {
    const doFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, description: "Conflict: terminated by other getUpdates request" }),
    })) as unknown as typeof fetch;

    await expect(awaitTelegramGroupStart("t", { deadlineMs: 100, doFetch }))
      .rejects.toBeInstanceOf(TelegramPollConflictError);
  });

  it("returns the group and the user who posted", async () => {
    let call = 0;
    const doFetch = vi.fn(async () => {
      call++;
      if (call === 1) return { ok: true, json: async () => ({ ok: true, result: [] }) };
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: [{ update_id: 7, message: { chat: { id: -100999, type: "supergroup" }, from: { id: 42 } } }],
        }),
      };
    }) as unknown as typeof fetch;

    const slice = await awaitTelegramGroupStart("t", { deadlineMs: 5_000, doFetch });

    expect(slice.found).toEqual({ groupId: -100999, userId: 42 });
    expect(slice.offset).toBe(8);
  });

  it("gives up within its deadline instead of holding the request open", async () => {
    // Updates keep arriving and none of them is a group message, so only the
    // deadline can end this. A browser is waiting on the other end.
    let update = 0;
    let clock = 1_000;
    const doFetch = vi.fn(async () => {
      clock += 10;
      update++;
      return {
        ok: true,
        json: async () => ({ ok: true, result: [{ update_id: update, message: { chat: { id: 5, type: "private" }, from: { id: 1 } } }] }),
      };
    }) as unknown as typeof fetch;

    const slice = await awaitTelegramGroupStart("t", { deadlineMs: 50, offset: 1, now: () => clock, doFetch });

    expect(slice.found).toBeNull();
    // Bounded: a handful of slices, not an open-ended loop.
    expect(vi.mocked(doFetch).mock.calls.length).toBeLessThan(20);
  });

  it("stops when the conflict shows up mid-poll, not only on the first call", async () => {
    const doFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, description: "Conflict: terminated by other getUpdates request" }),
    })) as unknown as typeof fetch;

    // offset > 0 skips the stale drain, so the conflict can only be noticed by
    // the check inside the polling loop.
    await expect(awaitTelegramGroupStart("t", { deadlineMs: 5_000, offset: 3, doFetch }))
      .rejects.toBeInstanceOf(TelegramPollConflictError);
  });

  it("lists only the backends actually installed", () => {
    const installed = detectInstalledBackends(
      [{ name: "claude-code", binary: "claude" }, { name: "codex", binary: "codex" }],
      binary => { if (binary !== "claude") throw new Error("not found"); },
    );

    expect(installed).toEqual(["claude-code"]);
  });
});

describe("a bot token already in use", () => {
  it("is recognised by its value, not by the variable that holds it", async () => {
    // The same token can be reached through a differently named variable, and a
    // variable name is not a token. Comparing names would both miss the real
    // clash and match a request that merely sent the name.
    const { FleetManager } = await import("../src/fleet-manager.js");
    const dir = tempDir();
    const fm = new FleetManager(dir);
    (fm as unknown as { fleetConfig: unknown }).fleetConfig = {
      defaults: {}, instances: {},
      channels: [{ id: "telegram", type: "telegram", bot_token_env: "TG_MAIN" }],
    };
    const previous = process.env.TG_MAIN;
    process.env.TG_MAIN = "123456:LIVE-TOKEN";
    try {
      expect(fm.isBotTokenInUse("123456:LIVE-TOKEN")).toBe(true);
      expect(fm.isBotTokenInUse("TG_MAIN")).toBe(false);
      expect(fm.isBotTokenInUse("123456:OTHER")).toBe(false);
      expect(fm.isBotTokenInUse("")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.TG_MAIN;
      else process.env.TG_MAIN = previous;
    }
  });
});

// ── HTTP ────────────────────────────────────────────────────────────────────

function request(
  path: string,
  ctx: SettingsApiContext,
  method = "POST",
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as EventEmitter & { method: string; headers: Record<string, string>; destroy(): void };
    req.method = method;
    req.headers = {};
    req.destroy = () => undefined;
    let status = 0;
    const res = {
      setHeader() {},
      writeHead(code: number) { status = code; },
      end(payload: string) { resolve({ status, body: JSON.parse(payload) as Record<string, unknown> }); },
    };
    try {
      expect(handleSettingsRequest(req as never, res as never, new URL(`http://localhost${path}`), ctx)).toBe(true);
      queueMicrotask(() => {
        if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
        req.emit("end");
      });
    } catch (err) { reject(err); }
  });
}

function context(dir: string) {
  const saveFleetConfig = vi.fn();
  const ctx = {
    fleetConfig: { defaults: {}, instances: {}, channels: [] },
    configPath: join(dir, "fleet.yaml"),
    dataDir: dir,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    getRawFleetConfig: () => ({}),
    saveFleetConfig,
    lifecycle: { isPaused: () => false, pause: vi.fn(), wake: vi.fn() },
  } as unknown as SettingsApiContext;
  return { ctx, saveFleetConfig };
}

describe("POST /api/settings/quickstart/probe", () => {
  it("never writes the token to the log", async () => {
    const dir = tempDir();
    const { ctx } = context(dir);
    const token = "123456:SECRET-TOKEN";

    await request("/api/settings/quickstart/probe", ctx, "POST", {
      action: "verify", platform: "telegram", token,
    });

    const logged = (ctx.logger.info as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(logged.length).toBeGreaterThan(0);
    for (const call of logged) {
      expect(JSON.stringify(call), "a probe log line carries the bot token").not.toContain(token);
    }
  });
});

describe("POST /api/settings/quickstart/commit", () => {
  const valid = {
    platform: "telegram", token_env: "AGEND_BOT_TOKEN", backend: "claude-code",
    working_directory: "/tmp/app", instance_name: "agent-1",
    group_id: "-100123", admin_user_id: "42", token: "123456:ABC",
  };

  it("writes the config and the token, and applies nothing", async () => {
    const dir = tempDir();
    const { ctx, saveFleetConfig } = context(dir);

    const res = await request("/api/settings/quickstart/commit", ctx, "POST", valid);

    expect(res.status).toBe(200);
    expect(saveFleetConfig).toHaveBeenCalledTimes(1);
    expect(ctx.fleetConfig!.instances["agent-1"]).toMatchObject({ working_directory: "/tmp/app", backend: "claude-code" });
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("AGEND_BOT_TOKEN=123456:ABC");
    // Starting is the apply job's business, not the wizard's.
    expect(res.body).not.toHaveProperty("job_id");
    expect(JSON.stringify(res.body)).not.toContain("123456:ABC");
  });

  it("adds a second bot on the same platform under its own id", async () => {
    // The platform name is taken by the first connection, so a second one has
    // to be numbered — otherwise validation rejects a duplicate channel id and
    // the wizard can never add a second Telegram bot at all.
    const dir = tempDir();
    const { ctx } = context(dir);
    (ctx.fleetConfig as unknown as { channels: unknown[] }).channels = [
      { id: "telegram", type: "telegram", bot_token_env: "TG_MAIN", group_id: "-1", mode: "topic", access: { mode: "locked", allowed_users: ["1"] } },
    ];

    const res = await request("/api/settings/quickstart/commit", ctx, "POST", {
      ...valid, token_env: "TG_SECOND", token: "999:SECOND",
    });

    expect(res.status).toBe(200);
    const channels = (ctx.fleetConfig as unknown as { channels: Array<Record<string, unknown>> }).channels;
    expect(channels).toHaveLength(2);
    expect(channels.map(channel => channel.id)).toEqual(["telegram", "telegram-2"]);
  });

  it("writes nothing at all when the assembled config turns out invalid", async () => {
    const dir = tempDir();
    const { ctx, saveFleetConfig } = context(dir);
    (ctx.fleetConfig as unknown as { channels: unknown[] }).channels = [
      { id: "telegram", type: "telegram", bot_token_env: "TG_MAIN", group_id: "-1", mode: "topic", access: { mode: "locked", allowed_users: ["1"] } },
    ];
    const before = structuredClone(ctx.fleetConfig);
    // Capture what was handed to the validator: it has to be the assembled
    // result, not the config that is still running. Validating the live object
    // would pass (it is valid) and then write anyway.
    let validated: unknown = null;
    vi.spyOn(await import("../src/config-validator.js"), "validateFleetConfig")
      .mockImplementation(config => {
        validated = config;
        return { valid: false, errors: [{ path: "channels", message: "duplicate channel id" }], warnings: [] };
      });

    const res = await request("/api/settings/quickstart/commit", ctx, "POST", {
      ...valid, token_env: "TG_SECOND", token: "999:SECOND",
    });

    expect(res.status).toBe(400);
    expect(saveFleetConfig).not.toHaveBeenCalled();
    const checked = validated as { channels: Array<Record<string, unknown>>; instances: Record<string, unknown> };
    expect(checked.channels, "the validator saw the old config, not the new one").toHaveLength(2);
    expect(checked.instances).toHaveProperty("agent-1");
    // Neither half may have moved: not the file, not the in-memory config, and
    // not the .env — validating after writing made that promise only half true.
    expect(ctx.fleetConfig).toEqual(before);
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it("puts the running config back when the save fails", async () => {
    const dir = tempDir();
    const { ctx, saveFleetConfig } = context(dir);
    (ctx.fleetConfig as unknown as { channels: unknown[] }).channels = [];
    const before = structuredClone(ctx.fleetConfig);
    saveFleetConfig.mockImplementation(() => { throw new Error("disk full"); });

    const res = await request("/api/settings/quickstart/commit", ctx, "POST", valid);

    expect(res.status).toBe(500);
    // The file is the authority; the running config must not keep a change it
    // refused.
    expect(ctx.fleetConfig).toEqual(before);
  });

  it("#1519 P1 (S1): never replaces the connection that owns the variable — refused, and nothing moves", async () => {
    const dir = tempDir();
    const { ctx, saveFleetConfig } = context(dir);
    (ctx.fleetConfig as unknown as { channels: unknown[] }).channels = [
      { id: "telegram", type: "telegram", bot_token_env: "AGEND_BOT_TOKEN", group_id: "-1" },
    ];
    const before = structuredClone(ctx.fleetConfig);

    const res = await request("/api/settings/quickstart/commit", ctx, "POST", valid);

    expect(res.status).toBe(409);
    expect(String(res.body?.error ?? "")).toMatch(/already holds the token of the "telegram" connection/);
    expect([saveFleetConfig.mock.calls.length, existsSync(join(dir, ".env"))]).toEqual([0, false]);
    expect(ctx.fleetConfig).toEqual(before);
  });

  it("#1519 P1: the same server, a second bot of the same platform — both connections stay (plan → commit)", async () => {
    const dir = tempDir();
    const { ctx } = context(dir);
    const first = { id: "discord", type: "discord", bot_token_env: "AGEND_DISCORD_TOKEN", group_id: "555", mode: "topic", access: { mode: "locked", allowed_users: ["1"] } };
    (ctx.fleetConfig as unknown as { channels: unknown[] }).channels = [first];
    writeFileSync(join(dir, ".env"), "AGEND_DISCORD_TOKEN=first\n");
    const { token_env: _drop, ...noEnv } = valid;
    const input = { ...noEnv, platform: "discord", guild_id: "555", group_id: undefined };

    const plan = await request("/api/settings/quickstart/plan", ctx, "POST", input);
    expect(plan.status).toBe(200);
    expect([plan.body.channel_id, plan.body.token_env]).toEqual(["discord-2", "AGEND_DISCORD_2_TOKEN"]);
    const res = await request("/api/settings/quickstart/commit", ctx, "POST", { ...input, token_env: plan.body.token_env, token: "999:SECOND" });

    expect(res.status).toBe(200);
    const channels = (ctx.fleetConfig as unknown as { channels: Array<Record<string, unknown>> }).channels;
    expect(channels.map(c => [c.id, c.bot_token_env, c.group_id])).toEqual([["discord", "AGEND_DISCORD_TOKEN", "555"], ["discord-2", "AGEND_DISCORD_2_TOKEN", "555"]]);
    expect(channels[0]).toEqual(first);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("AGEND_DISCORD_TOKEN=first\nAGEND_DISCORD_2_TOKEN=999:SECOND\n");
  });

  it("#1529 review: a generated name taken after the plan is refused at the commit — the value written meanwhile stays", async () => {
    const dir = tempDir();
    const { ctx, saveFleetConfig } = context(dir);
    const { token_env: _drop, ...noEnv } = valid;
    const plan = await request("/api/settings/quickstart/plan", ctx, "POST", noEnv);
    expect(plan.body.token_env).toBe("AGEND_TELEGRAM_TOKEN");
    writeFileSync(join(dir, ".env"), "AGEND_TELEGRAM_TOKEN=written-by-another-operation\n");
    const res = await request("/api/settings/quickstart/commit", ctx, "POST", { ...noEnv, channel_id: plan.body.channel_id, token_env: plan.body.token_env, token_env_generated: true });
    expect([res.status, String(res.body?.error ?? "")]).toEqual([409, expect.stringMatching(/no longer free/)]);
    expect([saveFleetConfig.mock.calls.length, readFileSync(join(dir, ".env"), "utf8")]).toEqual([0, "AGEND_TELEGRAM_TOKEN=written-by-another-operation\n"]);
    // Control: an explicit name (the pre-fleet form's own) keeps its old meaning — it may set a key .env already has.
    const explicit = await request("/api/settings/quickstart/commit", ctx, "POST", { ...valid, token_env: "AGEND_TELEGRAM_TOKEN" });
    expect(explicit.status).toBe(200);
  });

  it("#1529 review: an unreadable .env is never 'free' — the plan and a generated commit refuse, nothing written", async () => {
    const dir = tempDir();
    const { ctx, saveFleetConfig } = context(dir);
    mkdirSync(join(dir, ".env"));                                 // a directory: reading it fails (EISDIR), not ENOENT
    const { token_env: _drop, ...noEnv } = valid;
    expect((await request("/api/settings/quickstart/plan", ctx, "POST", noEnv)).status).toBe(503);
    const res = await request("/api/settings/quickstart/commit", ctx, "POST", { ...noEnv, token_env: "AGEND_TELEGRAM_TOKEN", token_env_generated: true });
    expect([res.status, saveFleetConfig.mock.calls.length]).toEqual([503, 0]);
  });

  it("#1529 review: the plan's connection id taken before the commit is refused (409), never quietly renumbered", async () => {
    const dir = tempDir();
    const { ctx, saveFleetConfig } = context(dir);
    const { token_env: _drop, ...noEnv } = valid;
    const plan = await request("/api/settings/quickstart/plan", ctx, "POST", noEnv);
    (ctx.fleetConfig as unknown as { channels: unknown[] }).channels = [
      { id: plan.body.channel_id, type: "telegram", bot_token_env: "OTHER_TOKEN", group_id: "-9", mode: "topic", access: { mode: "locked", allowed_users: [] } }];
    const res = await request("/api/settings/quickstart/commit", ctx, "POST", { ...noEnv, channel_id: plan.body.channel_id, token_env: plan.body.token_env, token_env_generated: true });
    expect([res.status, String(res.body?.error ?? ""), saveFleetConfig.mock.calls.length]).toEqual([409, expect.stringMatching(/already exists/), 0]);
  });

  it("#1529 review: the wizard's agent is the new connection's — bound by channel_id, as the running fleet resolves it", async () => {
    const dir = tempDir();
    const { ctx } = context(dir);
    (ctx.fleetConfig as unknown as { channels: unknown[] }).channels = [
      { id: "telegram", type: "telegram", bot_token_env: "AGEND_TELEGRAM_TOKEN", group_id: "-1", mode: "topic", access: { mode: "locked", allowed_users: ["1"] } }];
    const { token_env: _drop, ...noEnv } = valid;
    for (const [name, guild] of [["agent-dc", "555"], ["agent-dc2", "555"]] as const) {
      const input = { ...noEnv, platform: "discord", group_id: undefined, guild_id: guild, instance_name: name };
      const plan = await request("/api/settings/quickstart/plan", ctx, "POST", input);
      expect((plan.body.instance as { channel_id: string }).channel_id, "the preview names the binding").toBe(plan.body.channel_id);
      const res = await request("/api/settings/quickstart/commit", ctx, "POST", { ...input, channel_id: plan.body.channel_id, token_env: plan.body.token_env, token_env_generated: true });
      expect(res.status).toBe(200);
    }
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(dir) as any; fm.fleetConfig = ctx.fleetConfig;
    expect(["agent-dc", "agent-dc2"].map(n => [ctx.fleetConfig!.instances[n]!.channel_id, fm.getInstanceAdapterId(n)])).toEqual([["discord", "discord"], ["discord-2", "discord-2"]]);
  });

  it("#1519 P1: New connection — connection_only adds the connection and writes no agent", async () => {
    const dir = tempDir();
    const { ctx } = context(dir);
    const instancesBefore = structuredClone(ctx.fleetConfig!.instances);
    const res = await request("/api/settings/quickstart/commit", ctx, "POST", {
      platform: "telegram", connection_only: true, token_env: "AGEND_TELEGRAM_TOKEN", group_id: "-100777", token: "123456:NEW",
    });
    expect(res.status).toBe(200);
    expect(ctx.fleetConfig!.instances).toEqual(instancesBefore);
    const channels = (ctx.fleetConfig as unknown as { channels: Array<Record<string, unknown>> }).channels;
    expect(channels.at(-1)).toMatchObject({ id: "telegram", bot_token_env: "AGEND_TELEGRAM_TOKEN", group_id: "-100777", access: { mode: "locked", allowed_users: [] } });
    expect(JSON.stringify(res.body)).not.toContain("123456:NEW");
  });

  it.each([
    ["platform", { platform: "irc" }],
    ["token_env", { token_env: "lower case" }],
    ["backend", { backend: "not-a-backend" }],
    ["working_directory", { working_directory: "relative/path" }],
    ["instance_name", { instance_name: "bad name/../" }],
    ["group_id", { group_id: "not-a-number" }],
  ])("rejects a bad %s before anything is written", async (_field, override) => {
    const dir = tempDir();
    const { ctx, saveFleetConfig } = context(dir);

    const res = await request("/api/settings/quickstart/commit", ctx, "POST", { ...valid, ...override });

    expect(res.status).toBe(400);
    expect(saveFleetConfig).not.toHaveBeenCalled();
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it("needs a token", async () => {
    const dir = tempDir();
    const { ctx } = context(dir);

    const res = await request("/api/settings/quickstart/commit", ctx, "POST", { ...valid, token: undefined });

    expect(res.status).toBe(400);
  });
});

describe("the CLI quickstart", () => {
  const cli = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "quickstart.ts"),
    "utf8",
  );

  it("explains a polling conflict instead of dying on it", () => {
    // Structural, not behavioural — the flow is a readline conversation. It
    // pins the exact regression: the shared probe throws where the old inline
    // copy polled on silently, and an uncaught throw ends the command.
    expect(cli).toContain("if (err instanceof TelegramPollConflictError) {");
    expect(cli).toContain("Another process is already reading this bot's updates.");
    expect(cli).toContain("agend stop");
  });
});

describe("the wizard in the panel", () => {
  // Ported to the app shell: the wizard is settings-wizard.js (SetupWizard), mounted in the fake DOM against scripted
  // answers. Finishing hands over to the app's Apply runner (settings-apply.js), which posts the apply and watches it.
  let p: AppPage;
  let wizard: any, runner: any, store: any, tr: (k: string, ...a: unknown[]) => string;
  const tn = (k: string, ...a: unknown[]) => tr(`settings.${k}`, ...a);
  const JOB = "44444444-4444-4444-8444-444444444444";
  let env: { backends: string[]; channels: unknown[]; has_fleet: boolean };
  const sent: Array<{ path: string; method: string; headers: Record<string, string>; body: any }> = [];
  let commitAnswer: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: { ok: true, secret_mode_ok: true } };
  let applyStatus = 202;

  beforeAll(async () => {
    p = page({ url: "http://127.0.0.1:19280/settings/general" });
    (globalThis as any).fetch = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
      const method = init.method ?? "GET";
      sent.push({ path, method, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
      const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
      if (path === "/api/settings/quickstart/environment") return json(env);
      if (path === "/api/settings/quickstart/probe") {
        const answer = json({ identity: { valid: true, username: "bot_one" } });
        return probeHold ? probeHold.then(() => answer) : answer;
      }
      if (path === "/api/settings/quickstart/plan" && planHold) { const hold = planHold; return hold.then(() => json({
        channel: { type: "telegram" }, instance: { name: "agent-1", working_directory: "/tmp/app", backend: "claude-code", channel_id: "telegram" },
        channel_id: "telegram", token_env: "AGEND_TELEGRAM_TOKEN", env_keys: ["AGEND_TELEGRAM_TOKEN"], warnings: [] })); }
      if (path === "/api/settings/quickstart/plan") return json({
        channel: { type: "telegram", group_id: "-100123", access: { mode: "locked", allowed_users: ["42"] } },
        instance: { name: "agent-1", working_directory: "/tmp/app", backend: "claude-code" },
        channel_id: "telegram", token_env: "AGEND_TELEGRAM_TOKEN", env_keys: ["AGEND_TELEGRAM_TOKEN"], warnings: [],
      });
      if (path === "/api/settings/quickstart/commit") return json(commitAnswer.body, commitAnswer.status);
      if (method === "POST" && path === "/api/settings/apply") return json({ id: JOB, key: "k", status: "done", startedAt: 1, deadlineMs: 1, pid: 1, elapsed_ms: 1, overdue: false, message: "", targets: [] }, applyStatus);
      return json(null, 404);
    };
    ({ t: tr } = await import("/assets/app-i18n.js"));
    wizard = await import("/ui/js/settings-wizard.js");
    runner = await import("/ui/js/settings-apply.js");
    store = await import("/assets/app-store.js");
  });
  afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
  beforeEach(async () => {
    sent.length = 0; env = { backends: ["claude-code"], channels: [], has_fleet: false };
    commitAnswer = { ok: true, status: 200, body: { ok: true, secret_mode_ok: true } }; applyStatus = 202;
    runner.resetOperation(); await p.unmount();
  });
  afterEach(async () => { runner.resetOperation(); await p.unmount(); });

  let probeHold: Promise<void> | null = null;
  let planHold: Promise<void> | null = null;
  afterEach(() => { probeHold = null; planHold = null; });                 // a test that stopped early leaves none behind
  const mountWizard = async () => {
    const onClose = vi.fn();
    await p.mount(h(wizard.SetupWizard, { onClose }));
    await vi.waitFor(() => expect(p.root.querySelector("#wz-wd")).not.toBeNull());
    return onClose;
  };
  const button = (label: string) => (p.root.querySelectorAll("button") as any[]).find(b => b.textContent === label)!;
  const field = (id: string) => p.root.querySelector(`#${id}`) as any;
  const type = async (id: string, value: string) => { field(id).value = value; fire(field(id), "input"); await settle(); };
  const next = async () => { button(tn("wizardNext")).click(); await settle(); };
  const finish = async () => { button(tn("wizardFinish")).click(); await settle(); };
  /** Step 1 → 2 → 3, with a verified token, so Next reaches the plan. */
  async function toStepThree() {
    await type("wz-wd", "/tmp/app");
    await next();
    await next();                                             // Telegram is the default platform
    await type("wz-token", "123456:ABC");
    button(tn("wizardVerify")).click(); await settle();
    await vi.waitFor(() => expect(p.root.querySelector(".feedback")?.textContent).toBe("This is @bot_one."));   // #1519 P1: the bot is named
  }

  it("is four steps, with one flow whether or not a fleet exists", async () => {
    await mountWizard();
    expect(p.root.textContent).toContain(tn("wizardStep", 1, 4));
    expect(p.root.textContent).not.toContain(tn("wizardRerun"));
    await p.unmount();

    env = { ...env, has_fleet: true };
    await mountWizard();
    // No second menu for "a fleet already exists" — the same dialog, with the note.
    expect(p.root.textContent).toContain(tn("wizardRerun"));
    expect(p.root.textContent).toContain(tn("wizardStep", 1, 4));
  });

  it("finishes through the ordinary apply job, not a silent write", async () => {
    const onClose = await mountWizard();
    await toStepThree();
    await next();                                             // to the plan
    await vi.waitFor(() => expect(p.root.textContent).toContain(tn("wizardWillWrite")));
    await finish();

    await vi.waitFor(() => expect(sent.some(c => c.path === "/api/settings/apply")).toBe(true));
    const commit = sent.findIndex(c => c.path === "/api/settings/quickstart/commit");
    const apply = sent.findIndex(c => c.path === "/api/settings/apply");
    expect(commit).toBeGreaterThanOrEqual(0);
    expect(commit).toBeLessThan(apply);
    expect(sent[apply]!.method).toBe("POST");
    expect(sent[apply]!.headers["Idempotency-Key"]).toBeTruthy();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("a reconcile that owns the slot is said so, not silently ignored", async () => {
    applyStatus = 409;
    await mountWizard();
    await toStepThree();
    await next();
    await vi.waitFor(() => expect(p.root.textContent).toContain(tn("wizardWillWrite")));
    await finish();

    await vi.waitFor(() => expect(sent.some(c => c.path === "/api/settings/apply")).toBe(true));
    // The operation in hand says it was refused as busy: the card shows the "try Apply again" note.
    await vi.waitFor(() => expect(store.appStore.get().settingsOp).toMatchObject({ phase: "failed", error: "busy" }));
    expect(runner.operationActive()).toBe(false);
  });

  it("asks each platform only for the ids it has", async () => {
    await mountWizard();
    await toStepThree();
    expect(p.root.textContent).toContain(tn("groupIdField"));
    expect(p.root.textContent).toContain(tn("wizardDetect"));
    expect(field("wz-guild")).toBeNull();

    // Discord: its own ids, and no Telegram group field.
    await p.unmount();
    await mountWizard();
    await type("wz-wd", "/tmp/app");
    await next();
    button("Discord").click(); await settle();
    await next();
    await type("wz-token", "123456:ABC");
    button(tn("wizardVerify")).click(); await settle();
    await vi.waitFor(() => expect(p.root.textContent).toContain(tn("guildIdField")));
    expect(p.root.textContent).toContain(tn("wizardGeneralChannel"));
    expect(p.root.textContent).not.toContain(tn("groupIdField"));
  });

  it("verifies the token with the provider before letting the user continue", async () => {
    await mountWizard();
    await type("wz-wd", "/tmp/app");
    await next(); await next();
    await type("wz-token", "123456:ABC");
    await next();                                             // Next without Verify

    expect(p.root.textContent).toContain(tn("wizardNeedVerify"));
    expect(sent.some(c => c.path === "/api/settings/quickstart/plan")).toBe(false);
    expect(sent.some(c => c.path === "/api/settings/quickstart/probe" && c.body.action === "verify")).toBe(false);
    button(tn("wizardVerify")).click(); await settle();
    expect(sent.some(c => c.path === "/api/settings/quickstart/probe" && c.body.action === "verify")).toBe(true);
  });

  it("shows what will be written before writing it", async () => {
    await mountWizard();
    await toStepThree();
    await next();

    await vi.waitFor(() => expect(p.root.textContent).toContain(tn("wizardWillWrite")));
    expect(sent.some(c => c.path === "/api/settings/quickstart/plan")).toBe(true);
    expect(sent.some(c => c.path === "/api/settings/quickstart/commit")).toBe(false);   // a preview writes nothing
    // #1519 P1: no env-name question; the plan's generated name is shown under Advanced, read-only.
    const plan = sent.find(c => c.path === "/api/settings/quickstart/plan")!;
    expect(plan.body).not.toHaveProperty("token_env");
    expect([...p.root.querySelectorAll("details.drawer code")].map((c: any) => c.textContent)).toEqual(["AGEND_TELEGRAM_TOKEN"]);
    expect(p.root.querySelectorAll("input").some((i: any) => i.value === "AGEND_TELEGRAM_TOKEN"), "not an editable field").toBe(false);
  });

  it("#1529 review: a Verify still on its way for an old token never names the new one or lets it reach the plan", async () => {
    await mountWizard();
    await type("wz-wd", "/tmp/app"); await next(); await next();
    await type("wz-token", "token-A");
    let release!: () => void; probeHold = new Promise<void>(r => { release = r; });
    button(tn("wizardVerify")).click(); await settle();
    expect(field("wz-token").disabled, "locked while Verify runs").toBe(true);
    await type("wz-token", "token-B");                    // an input that still arrives is the form now
    release(); probeHold = null; await settle(); await settle();
    expect(p.root.querySelector(".token-field .feedback")?.textContent ?? null, "token-B is not named by A's answer").toBeNull();
    await next();
    expect(sent.some(c => c.path === "/api/settings/quickstart/plan"), "no plan for an unverified token").toBe(false);
    expect(p.root.textContent).toContain(tn("wizardNeedVerify"));
  });

  it("#1529 review: a plan still on its way when the token changes is dropped — the review step never shows it", async () => {
    await mountWizard();
    await toStepThree();
    let release!: () => void; planHold = new Promise<void>(r => { release = r; });
    await next();
    await type("wz-token", "token-B");
    release(); planHold = null; await settle(); await settle();
    expect(p.root.textContent, "still on step 3").toContain(tn("wizardStep", 3, 4));
    expect(p.root.textContent).not.toContain(tn("wizardWillWrite"));
  });

  it("#1529 review: Finish carries the plan's whole target — connection id, generated token env, and that it was generated", async () => {
    await mountWizard();
    await toStepThree(); await next();
    await vi.waitFor(() => expect(p.root.textContent).toContain(tn("wizardWillWrite")));
    await finish();
    await vi.waitFor(() => expect(sent.some(c => c.path === "/api/settings/quickstart/commit")).toBe(true));
    const commit = sent.find(c => c.path === "/api/settings/quickstart/commit")!;
    expect([commit.body.channel_id, commit.body.token_env, commit.body.token_env_generated]).toEqual(["telegram", "AGEND_TELEGRAM_TOKEN", true]);
  });

  it("keeps the token out of the URL and out of the page after use", async () => {
    await mountWizard();
    await toStepThree();
    expect(field("wz-token").getAttribute("type")).toBe("password");
    expect(field("wz-env"), "#1519 P1: no env name to type").toBeNull();
    expect(field("wz-token").value).toBe("123456:ABC");
    await next();
    await vi.waitFor(() => expect(p.root.textContent).toContain(tn("wizardWillWrite")));
    await finish();

    await vi.waitFor(() => expect(sent.some(c => c.path === "/api/settings/quickstart/commit")).toBe(true));
    // Sent in a body, never a query string.
    const commit = sent.find(c => c.path === "/api/settings/quickstart/commit")!;
    expect(commit.method).toBe("POST");
    expect(commit.body.token).toBe("123456:ABC");
    expect(commit.body.token_env, "the commit carries the plan's generated name").toBe("AGEND_TELEGRAM_TOKEN");
    expect(sent.every(c => !c.path.includes("123456:ABC"))).toBe(true);
  });
});
