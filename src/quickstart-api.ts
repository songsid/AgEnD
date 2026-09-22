/**
 * The Settings setup wizard's server side.
 *
 * Four steps, the same four `agend quickstart` walks: pick a backend and a
 * working directory, pick a platform, prove the bot credentials, then write the
 * files and start. The probes are the CLI's own (`provider-probe.ts`), so the
 * wizard cannot drift into asking the providers different questions.
 *
 * What it deliberately does not do: apply. The last step writes the
 * configuration and hands back, and the page then starts a normal apply job —
 * the same one the panel uses everywhere else, with the same progress, the same
 * idempotency key and the same disk-backed recovery across a restart.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeSecretFile, type SecretWriteResult } from "./secret-file.js";
import { KNOWN_BACKENDS, validateFleetConfig } from "./config-validator.js";
import type { FleetConfig } from "./types.js";
import {
  awaitTelegramGroupStart,
  detectInstalledBackends,
  listDiscordGuilds,
  TelegramPollConflictError,
  verifyDiscordToken,
  verifyTelegramToken,
  type BotIdentity,
  type DiscordGuild,
} from "./provider-probe.js";

/** One slice of Telegram long polling, so the browser gets an answer. */
export const TELEGRAM_WAIT_SLICE_MS = 25_000;

export const WIZARD_BACKENDS = [
  { name: "claude-code", binary: "claude" },
  { name: "codex", binary: "codex" },
  { name: "opencode", binary: "opencode" },
  { name: "kiro-cli", binary: "kiro-cli" },
  { name: "antigravity", binary: "agy" },
  { name: "grok", binary: "grok" },
  { name: "muse", binary: "muse" },
] as const;

export interface WizardEnvironment {
  backends: string[];
  /** Channels already configured, so the wizard can pre-fill and warn. */
  channels: Array<{
    id: string;
    type: string;
    token_env: string | null;
    group_id: string | null;
    /** Who can currently drive that connection, so a replacement can say who
     * it is about to remove. */
    allowed_users?: string[];
  }>;
  has_fleet: boolean;
}

export interface WizardPlanInput {
  platform: "telegram" | "discord";
  token_env: string;
  backend: string;
  working_directory: string;
  instance_name: string;
  group_id?: string;
  guild_id?: string;
  general_channel_id?: string;
  admin_user_id?: string;
}

/** What the last step shows before anything is written. */
export interface WizardPlan {
  /** The channel entry that will be merged into fleet.yaml. */
  channel: Record<string, unknown>;
  instance: { name: string; working_directory: string; backend: string };
  /** Env var names only — never the value. */
  env_keys: string[];
  warnings: string[];
}

/**
 * A channel id that is free, or the id of the connection being replaced.
 *
 * The platform name is the obvious id and the first bot gets it. A second bot on
 * the same platform cannot have it — `duplicate channel id` — so it is
 * qualified by the variable that holds its token. Without this the wizard can
 * never add a second Telegram bot at all.
 */
export function nextChannelId(
  platform: string,
  tokenEnv: string,
  existing: ReadonlyArray<{ id: string; token_env: string | null }>,
): string {
  const owner = existing.find(channel => channel.token_env === tokenEnv);
  if (owner) return owner.id;
  const taken = new Set(existing.map(channel => channel.id));
  if (!taken.has(platform)) return platform;
  const qualified = `${platform}-${tokenEnv.toLowerCase()}`;
  if (!taken.has(qualified)) return qualified;
  for (let n = 2; ; n++) {
    const candidate = `${qualified}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function planQuickstart(input: WizardPlanInput, env: WizardEnvironment): WizardPlan {
  const warnings: string[] = [];
  const channel: Record<string, unknown> = {
    type: input.platform,
    bot_token_env: input.token_env,
    mode: "topic",
    access: { mode: "locked", allowed_users: input.admin_user_id ? [input.admin_user_id] : [] },
  };
  // Only the id that platform has — Discord has a guild, Telegram a group.
  if (input.platform === "discord") {
    if (input.guild_id) channel.group_id = input.guild_id;
    if (input.general_channel_id) channel.general_channel_id = input.general_channel_id;
  } else if (input.group_id) {
    channel.group_id = input.group_id;
  }

  if (!input.admin_user_id) {
    warnings.push("No admin user id: access stays locked with an empty allow list, so nobody can drive the bot until you add one.");
  }
  const clash = env.channels.find(existing => existing.token_env === input.token_env);
  if (clash) {
    warnings.push(`${input.token_env} is already used by the "${clash.id}" connection — its token will be overwritten.`);
    // Re-running the wizard rewrites that connection's access block, so anyone
    // else on its allow list stops being able to drive the bot. That is a
    // lockout, and it must not happen without the user reading it first.
    const previous = clash.allowed_users ?? [];
    const dropped = previous.filter(user => user !== input.admin_user_id);
    if (dropped.length) {
      warnings.push(`Its allow list is replaced: ${dropped.join(", ")} will no longer be able to use the bot.`);
    }
  }
  if (!env.backends.includes(input.backend)) {
    warnings.push(`${input.backend} was not found on this host; the agent will fail to start until it is installed.`);
  }

  return {
    channel,
    instance: { name: input.instance_name, working_directory: input.working_directory, backend: input.backend },
    env_keys: [input.token_env],
    warnings,
  };
}

/** Upsert one `KEY=value` line, preserving everything else in the file. */
export function upsertEnvLine(existing: string, key: string, value: string): string {
  const lines = existing.split("\n").filter(line => line !== "");
  const index = lines.findIndex(line => line.startsWith(`${key}=`));
  if (index >= 0) lines[index] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  return lines.join("\n") + "\n";
}

export function writeQuickstartSecret(dataDir: string, key: string, value: string): SecretWriteResult {
  const path = join(dataDir, ".env");
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  return writeSecretFile(path, upsertEnvLine(existing, key, value));
}

export type ProbeRequest =
  | { action: "verify"; platform: "telegram" | "discord"; token: string }
  | { action: "guilds"; token: string }
  | { action: "await-telegram-start"; token: string; offset?: number };

export type ProbeResult =
  | { ok: true; identity: BotIdentity }
  | { ok: true; guilds: DiscordGuild[] }
  | { ok: true; found: { groupId: number; userId: number } | null; offset: number }
  | { ok: false; error: string; conflict?: true };

/**
 * Run one probe.
 *
 * `isTokenInUse` exists for the Telegram wait: `getUpdates` has exactly one
 * consumer, so polling a token the running fleet already polls makes the two
 * take turns and both miss messages. Refusing is the only honest answer — the
 * alternative silently breaks the live bot while the wizard waits.
 */
export async function runProviderProbe(
  request: ProbeRequest,
  opts: { isTokenInUse?: (token: string) => boolean; deadlineMs?: number } = {},
): Promise<ProbeResult> {
  if (request.action === "verify") {
    const identity = request.platform === "discord"
      ? await verifyDiscordToken(request.token)
      : await verifyTelegramToken(request.token);
    return { ok: true, identity };
  }
  if (request.action === "guilds") {
    return { ok: true, guilds: await listDiscordGuilds(request.token) };
  }
  if (opts.isTokenInUse?.(request.token)) {
    return {
      ok: false,
      conflict: true,
      error: "This bot token is already being polled by the running fleet. Enter the group id by hand, or stop AgEnD first.",
    };
  }
  try {
    const slice = await awaitTelegramGroupStart(request.token, {
      deadlineMs: opts.deadlineMs ?? TELEGRAM_WAIT_SLICE_MS,
      offset: request.offset ?? 0,
    });
    return { ok: true, found: slice.found, offset: slice.offset };
  } catch (err) {
    if (err instanceof TelegramPollConflictError) {
      return { ok: false, conflict: true, error: "Another process is already reading this bot's updates. Stop it, or enter the group id by hand." };
    }
    return { ok: false, error: (err as Error).message };
  }
}

export function detectWizardBackends(): string[] {
  return detectInstalledBackends(WIZARD_BACKENDS);
}


// ── HTTP routes ─────────────────────────────────────────────────────────────

/**
 * What the wizard's routes need from their host.
 *
 * Five fields, and none of them is a fleet: this is the whole "ConfigVerbs +
 * ProviderProbeVerbs" surface. A running fleet supplies it from FleetManager; a
 * pre-fleet setup host supplies it from a file. `tests/prefleet-host.test.ts`
 * asserts this module's import graph reaches neither fleet-manager, daemon nor
 * instance-lifecycle, so the host cannot grow a path to them by accident.
 */
export interface QuickstartApiContext {
  fleetConfig: FleetConfig | null;
  dataDir: string;
  logger: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void };
  saveFleetConfig(): void;
  /** Only a running fleet can answer this; without one, nothing is polling. */
  isBotTokenInUse?(token: string): boolean;
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** The channels as the wizard sees them, from either config shape. */
export function wizardChannels(cfg: FleetConfig | null): WizardEnvironment["channels"] {
  const channels = (cfg?.channels ?? (cfg?.channel ? [cfg.channel] : [])) as unknown as Array<Record<string, unknown>>;
  return channels.map((channel, index) => ({
    id: String(channel.id ?? channel.type ?? `channel-${index}`),
    type: String(channel.type ?? ""),
    token_env: channel.bot_token_env ? String(channel.bot_token_env) : null,
    group_id: channel.group_id != null ? String(channel.group_id) : null,
    allowed_users: ((channel.access as { allowed_users?: unknown[] } | undefined)?.allowed_users ?? []).map(String),
  }));
}

/** Reject anything that would land in fleet.yaml or a shell env file unchecked. */
export function validateWizardInput(input: Partial<WizardPlanInput>): string | null {
  if (input.platform !== "telegram" && input.platform !== "discord") return "platform must be telegram or discord";
  if (!input.token_env || !/^[A-Z][A-Z0-9_]{2,63}$/.test(input.token_env)) return "token_env must be an UPPER_SNAKE env var name";
  if (!input.backend || !KNOWN_BACKENDS.includes(input.backend)) return "backend must be a known backend";
  if (!input.working_directory || !input.working_directory.startsWith("/")) return "working_directory must be an absolute path";
  if (!input.instance_name || !/^[A-Za-z0-9._-]{1,128}$/.test(input.instance_name)) return "instance_name must be [A-Za-z0-9._-]";
  for (const [field, value] of Object.entries({
    group_id: input.group_id, guild_id: input.guild_id,
    general_channel_id: input.general_channel_id, admin_user_id: input.admin_user_id,
  })) {
    if (value !== undefined && value !== "" && !/^-?\d{1,20}$/.test(String(value))) return `${field} must be numeric`;
  }
  return null;
}

/** Handle one wizard route. Returns false when the path is not one of ours. */
export function handleQuickstartRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: QuickstartApiContext,
): boolean {
  const path = url.pathname;
  const method = req.method ?? "GET";
  const cfg = ctx.fleetConfig;
  if (!path.startsWith("/api/settings/quickstart/")) return false;

  if (method === "GET" && path === "/api/settings/quickstart/environment") {
    json(res, 200, {
      backends: detectWizardBackends(),
      has_fleet: !!cfg && Object.keys(cfg.instances ?? {}).length > 0,
      channels: wizardChannels(cfg),
    } satisfies WizardEnvironment);
    return true;
  }

  if (method === "POST" && path === "/api/settings/quickstart/probe") {
    readBody(req, 16 * 1024).then(async buf => {
      let body: Record<string, unknown>;
      try { body = JSON.parse(buf.toString("utf-8") || "{}") as Record<string, unknown>; }
      catch { return json(res, 400, { error: "invalid JSON" }); }
      const token = typeof body.token === "string" ? body.token : "";
      if (!token) return json(res, 400, { error: "token required" });
      const action = String(body.action ?? "");
      if (action !== "verify" && action !== "guilds" && action !== "await-telegram-start") {
        return json(res, 400, { error: "unknown probe" });
      }
      const platform = body.platform === "discord" ? "discord" : "telegram";
      // The token is read, used for one outbound call, and dropped. It is never
      // logged and never echoed back in the response.
      ctx.logger.info({ action, platform }, "settings: quickstart probe");
      const result = await runProviderProbe(
        { action, platform, token, offset: typeof body.offset === "number" ? body.offset : 0 } as never,
        { isTokenInUse: candidate => ctx.isBotTokenInUse?.(candidate) ?? false },
      );
      json(res, result.ok ? 200 : 409, result);
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  if (method === "POST" && path === "/api/settings/quickstart/plan") {
    if (!cfg) { json(res, 503, { error: "fleet not loaded" }); return true; }
    readBody(req, 16 * 1024).then(buf => {
      let body: WizardPlanInput;
      try { body = JSON.parse(buf.toString("utf-8") || "{}") as WizardPlanInput; }
      catch { return json(res, 400, { error: "invalid JSON" }); }
      const invalid = validateWizardInput(body);
      if (invalid) return json(res, 400, { error: invalid });
      json(res, 200, planQuickstart(body, {
        backends: detectWizardBackends(),
        has_fleet: Object.keys(cfg.instances ?? {}).length > 0,
        channels: wizardChannels(cfg),
      }));
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  if (method === "POST" && path === "/api/settings/quickstart/commit") {
    if (!cfg) { json(res, 503, { error: "fleet not loaded" }); return true; }
    readBody(req, 16 * 1024).then(buf => {
      let body: WizardPlanInput & { token?: string };
      try { body = JSON.parse(buf.toString("utf-8") || "{}") as WizardPlanInput & { token?: string }; }
      catch { return json(res, 400, { error: "invalid JSON" }); }
      const invalid = validateWizardInput(body);
      if (invalid) return json(res, 400, { error: invalid });
      if (!body.token) return json(res, 400, { error: "token required" });

      const summary = wizardChannels(cfg);
      const plan = planQuickstart(body, {
        backends: detectWizardBackends(),
        has_fleet: Object.keys(cfg.instances ?? {}).length > 0,
        channels: summary,
      });

      // Everything is assembled and validated on a copy. Nothing on disk and
      // nothing in memory moves until the whole result is known to be valid —
      // the previous order wrote the token first and left the running config
      // rewritten when validation then failed.
      const draft = structuredClone(cfg) as FleetConfig;
      const channels = (draft.channels ?? (draft.channel ? [draft.channel] : [])) as unknown as Array<Record<string, unknown>>;
      const existingIndex = channels.findIndex(channel => channel.bot_token_env === body.token_env);
      const entry = { id: nextChannelId(body.platform, body.token_env, summary), ...plan.channel };
      if (existingIndex >= 0) channels[existingIndex] = { ...channels[existingIndex], ...entry };
      else channels.push(entry);
      draft.channels = channels as unknown as typeof draft.channels;
      delete (draft as { channel?: unknown }).channel;
      draft.instances[body.instance_name] = {
        ...(draft.instances[body.instance_name] ?? {}),
        working_directory: body.working_directory,
        backend: body.backend,
      } as typeof draft.instances[string];

      const validation = validateFleetConfig(draft);
      if (!validation.valid) {
        return json(res, 400, { error: validation.errors.map(e => `${e.path}: ${e.message}`).join("; ") });
      }

      const secret = writeQuickstartSecret(ctx.dataDir, body.token_env, body.token);
      const before = {
        channels: cfg.channels,
        channel: (cfg as { channel?: unknown }).channel,
        instance: cfg.instances[body.instance_name],
        hadInstance: Object.prototype.hasOwnProperty.call(cfg.instances, body.instance_name),
      };
      cfg.channels = draft.channels;
      delete (cfg as { channel?: unknown }).channel;
      cfg.instances[body.instance_name] = draft.instances[body.instance_name]!;
      try { ctx.saveFleetConfig(); }
      catch (err) {
        // The file is the authority. If it did not take the change, the running
        // config must not keep it either.
        cfg.channels = before.channels;
        if (before.channel !== undefined) (cfg as { channel?: unknown }).channel = before.channel;
        if (before.hadInstance) cfg.instances[body.instance_name] = before.instance!;
        else delete cfg.instances[body.instance_name];
        return json(res, 500, { error: (err as Error).message });
      }
      ctx.logger.info({ instance: body.instance_name, platform: body.platform }, "settings: quickstart committed");
      // No apply here: the page starts the ordinary job so the wizard's last
      // step has the same progress, deadline and restart recovery as everything
      // else the panel applies.
      json(res, 200, { ok: true, plan, secret_mode_ok: secret.ok, warnings: plan.warnings });
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }


  return false;
}
