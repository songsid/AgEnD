import { settingsRequestExecution, settingsWrite } from "./settings-request-capability.js";
import { type SettingsExecution, SettingsExecutionError, settingsFileResource, trySettingsLease } from "./settings-transaction.js";
import { readBoundedWebBody } from "./web-body.js";
import { permitWebContinuation } from "./web-continuation.js";
import { gatewayRequestContext } from "./web-request-context.js";
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
import { join } from "node:path";
import type { SecretWriteResult } from "./secret-file.js";
import { SecretStore } from "./secret-store.js";
import { discordBotPortalUrl, discordInviteUrl } from "./discord-permissions.js";
import { EnvFileUnreadableError, envFileKeys, generateTokenEnvName, generatedTokenEnvStale, newTokenEnvConflict, takenTokenEnvNames, TOKEN_ENV_PATTERN } from "./token-env-name.js";
import { KNOWN_BACKENDS, validateFleetConfig } from "./config-validator.js";
import type { FleetConfig } from "./types.js";
import {
  awaitTelegramGroupStart,
  detectInstalledBackends,
  listDiscordGuilds,
  listDiscordTextChannels,
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
  /** #1519 P7: the agents already configured — the wizard offers to connect one instead of overwriting it. */
  agents?: Array<{ name: string; working_directory: string | null; backend: string | null }>;
}

export interface WizardPlanInput {
  platform: "telegram" | "discord";
  /**
   * The env var for the token. A plan without one gets a generated name (#1519 P1: `AGEND_<PLATFORM>_<ID>_TOKEN`,
   * unique); the commit always carries it — the plan's — so what an admin confirms is what is written.
   */
  token_env: string;
  /** #1519 P1: "New connection" — add the connection only; no agent is written. */
  connection_only?: boolean;
  /**
   * #1519 P7: `instance_name` is an agent that already exists — bind it to the new connection and leave its directory
   * and backend as they are. Without it, an existing name is refused: the wizard never overwrites an agent.
   */
  existing_agent?: boolean;
  /** The new connection's id; free ids only (a new connection never takes over one). Default: the platform's, else numbered. */
  channel_id?: string;
  /**
   * The token env came from a plan (#1529 review): the commit then re-checks, under its write lease, that the name is
   * still free of everything the plan avoided — a generated name never overwrites a value. Without it, the name is the
   * caller's own (the pre-fleet setup form, the CLI) and only another connection's or a reserved name is refused.
   */
  token_env_generated?: boolean;
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
  /**
   * `topic`: an existing agent whose topic belongs to another chat (#1549 review) — `from` its old id, `to` the id it
   * gets here (the General topic of the new chat, for a General agent) or null (none: the old one is not carried).
   */
  instance: { name: string; working_directory: string; backend: string; channel_id: string; existing?: boolean;
    topic?: { from: string; to: string | null } } | null;
  /** The new connection's id and the env var its token goes to. */
  channel_id: string;
  token_env: string;
  /** Env var names only — never the value. */
  env_keys: string[];
  warnings: string[];
}

/**
 * A free channel id for a NEW connection (#1519 P1, S1: the wizard never takes over an existing connection). The
 * platform name is the obvious id and the first bot gets it; the next one on that platform is `<platform>-2`, and so on.
 */
export function nextChannelId(platform: string, existing: ReadonlyArray<{ id: string }>): string {
  const taken = new Set(existing.map(channel => channel.id));
  if (!taken.has(platform)) return platform;
  for (let n = 2; ; n++) {
    const candidate = `${platform}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * #1519 P7: why the agent part of this input cannot be written, or null. A new agent's name must be free (the wizard
 * never overwrites one); an existing agent must exist. A connection-only input has no agent part.
 */
export function agentConflict(input: Pick<WizardPlanInput, "instance_name" | "existing_agent" | "connection_only">, cfg: FleetConfig | null): string | null {
  if (input.connection_only) return null;
  const exists = !!cfg && Object.hasOwn(cfg.instances ?? {}, input.instance_name);
  if (input.existing_agent) return exists ? null : `there is no agent called "${input.instance_name}"`;
  return exists ? `an agent called "${input.instance_name}" already exists — connect it as an existing agent, or choose another name` : null;
}

/**
 * #1519 P7: an existing agent's input as the plan shows it — with the agent's own directory and backend (the wizard does
 * not ask for them, and they are not changed). Any other input as it is.
 */
export function withExistingAgent<T extends Pick<WizardPlanInput, "instance_name" | "existing_agent" | "working_directory" | "backend">>(input: T, cfg: FleetConfig | null): T {
  if (!input.existing_agent || !cfg || !Object.hasOwn(cfg.instances ?? {}, input.instance_name)) return input;
  const inst = cfg.instances[input.instance_name] as { working_directory?: string; backend?: string };
  return { ...input, working_directory: inst.working_directory ?? "", backend: inst.backend ?? cfg.defaults?.backend ?? "claude-code" };
}

/**
 * #1549 review: a topic id means something only in its chat (a Telegram group's forum topic, a Discord server's
 * channel). An existing agent moved to a connection in another chat would keep an id that, there, is some other topic —
 * or none yet — and inbound messages from that topic would route to it. So its topic binding goes with the move unless
 * the new connection is in the same chat (same platform and group/server). Unknown (the old connection cannot be
 * found) is not "the same": the binding goes.
 */
export function releasesTopic(cfg: FleetConfig, instanceName: string, newChannel: { type?: unknown; group_id?: unknown }): boolean {
  if (!Object.hasOwn(cfg.instances ?? {}, instanceName)) return false;
  const inst = cfg.instances[instanceName] as { topic_id?: unknown; channel_id?: unknown };
  if (inst.topic_id === undefined || inst.topic_id === null || inst.topic_id === "") return false;
  const channels = wizardChannels(cfg);
  const old = inst.channel_id != null ? channels.find(c => c.id === String(inst.channel_id)) : channels[0];
  if (!old || old.group_id == null || newChannel.group_id == null) return true;
  return !(old.type === String(newChannel.type ?? "") && old.group_id === String(newChannel.group_id));
}

/**
 * The topic an existing agent has after moving to `newChannel`: its own when the chat is the same; else, for the
 * General agent, the new chat's General (Telegram's thread 1, the Discord connection's general channel); else none.
 */
export function movedTopic(cfg: FleetConfig, instanceName: string, newChannel: Record<string, unknown>): { from: string; to: string | number | null } | null {
  if (!releasesTopic(cfg, instanceName, newChannel)) return null;
  const inst = cfg.instances[instanceName] as { topic_id?: unknown; general_topic?: unknown };
  const from = String(inst.topic_id);
  if (inst.general_topic !== true) return { from, to: null };
  if (newChannel.type === "telegram") return { from, to: 1 };
  const general = newChannel.general_channel_id;
  return { from, to: general != null && /^\d{17,}$/.test(String(general)) ? String(general) : null };
}

/** The plan as the wizard shows it: an existing agent's topic that the move changes is said so. */
export function withTopicRelease(plan: WizardPlan, cfg: FleetConfig, input: Pick<WizardPlanInput, "instance_name" | "existing_agent">): WizardPlan {
  const moved = input.existing_agent && plan.instance ? movedTopic(cfg, input.instance_name, plan.channel) : null;
  if (!moved || !plan.instance) return plan;
  return { ...plan, instance: { ...plan.instance, topic: { from: moved.from, to: moved.to == null ? null : String(moved.to) } } };
}

/** Why this input cannot be a new connection, or null: a taken id or token env (it would replace a connection). */
export function newConnectionConflict(input: Pick<WizardPlanInput, "token_env" | "channel_id">, env: Pick<WizardEnvironment, "channels">): string | null {
  if (input.channel_id && env.channels.some(channel => channel.id === input.channel_id)) {
    return `a connection called "${input.channel_id}" already exists — a new connection never replaces one`;
  }
  return input.token_env ? newTokenEnvConflict(input.token_env, env.channels) : null;
}

export function planQuickstart(input: WizardPlanInput, env: WizardEnvironment & { taken_env?: ReadonlySet<string> }): WizardPlan {
  const warnings: string[] = [];
  const channelId = input.channel_id || nextChannelId(input.platform, env.channels);
  const tokenEnv = input.token_env || generateTokenEnvName(input.platform, channelId,
    env.taken_env ?? takenTokenEnvNames({ channelEnvs: env.channels.map(channel => channel.token_env) }));
  const channel: Record<string, unknown> = {
    id: channelId,
    type: input.platform,
    bot_token_env: tokenEnv,
    mode: "topic",
    access: { mode: "locked", allowed_users: input.admin_user_id ? [input.admin_user_id] : [] },
  };
  // Only the id that platform has — Discord has a guild, Telegram a group.
  if (input.platform === "discord") {
    if (input.guild_id) channel.group_id = input.guild_id;
    // Write general_channel_id under options (the runtime reads it from there).
    // Top-level general_channel_id was a bug introduced in c25045b0; old files
    // that still have it at the top level are handled by discordGeneralChannelId().
    if (input.general_channel_id) channel.options = { ...(channel.options as Record<string,unknown> ?? {}), general_channel_id: input.general_channel_id };
  } else if (input.group_id) {
    channel.group_id = input.group_id;
  }

  if (!input.admin_user_id) {
    warnings.push("No admin user id: access stays locked with an empty allow list, so nobody can drive the bot until you add one.");
  }
  if (!input.connection_only && !input.existing_agent && !env.backends.includes(input.backend)) {
    warnings.push(`${input.backend} was not found on this host; the agent will fail to start until it is installed.`);
  }

  return {
    channel,
    // The agent is the new connection's (#1529 review): bound to it, not to whichever connection is first.
    instance: input.connection_only ? null : { name: input.instance_name, working_directory: input.working_directory, backend: input.backend, channel_id: channelId,
      ...(input.existing_agent ? { existing: true } : {}) },
    channel_id: channelId,
    token_env: tokenEnv,
    env_keys: [tokenEnv],
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
  try {
    const store = new SecretStore(path, new Set([key]));
    store.write(key, value);
    return { ok: true, mode: 0o600 };
  } catch {
    // Keep the old return shape for the wizard UI, but a failed mode/atomic
    // write is now handled as a hard commit error by the endpoint below.
    return { ok: false, mode: null, reason: "secret write failed" };
  }
}

export type ProbeRequest =
  | { action: "verify"; platform: "telegram" | "discord"; token: string }
  | { action: "guilds"; token: string }
  | { action: "channels"; token: string; guild_id: string }
  | { action: "await-telegram-start"; token: string; offset?: number };

export type ProbeResult =
  | { ok: true; identity: BotIdentity; invite_url?: string; portal_url?: string }
  | { ok: true; channels: Array<{ id: string; name: string }> }
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
    // #1519 P3: a verified Discord bot comes with its invite (the one permission set) and its portal page.
    if (request.platform === "discord" && identity.valid && identity.id) {
      return { ok: true, identity, invite_url: discordInviteUrl(identity.id), portal_url: discordBotPortalUrl(identity.id) };
    }
    return { ok: true, identity };
  }
  if (request.action === "guilds") {
    return { ok: true, guilds: await listDiscordGuilds(request.token) };
  }
  if (request.action === "channels") {
    const listed = await listDiscordTextChannels(request.token, request.guild_id);
    return listed.ok ? { ok: true, channels: listed.channels } : { ok: false, error: listed.error };
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
function withMovedTopic<T extends { topic_id?: unknown }>(inst: T, moved: { to: string | number | null } | null): T {
  if (!moved) return inst;
  const { topic_id: _old, ...rest } = inst;
  return (moved.to == null ? rest : { ...rest, topic_id: moved.to }) as T;
}

/** One pure draft shared by the writer and the authoritative confirmation diff. */
export function draftQuickstart(cfg: FleetConfig, body: WizardPlanInput, plan: WizardPlan): FleetConfig {
  const draft = structuredClone(cfg), summary = wizardChannels(cfg);
  const channels = draft.channels ?? (draft.channel ? [draft.channel] : []);
  // Always a new connection (#1519 P1, S1): never matched to one by token env, platform or group. The commit refuses a
  // taken id or env before it gets here (newConnectionConflict).
  void summary;
  channels.push({ ...plan.channel } as unknown as typeof channels[number]);
  draft.channels = channels; delete draft.channel;
  if (body.connection_only) return draft;
  const existing = Object.hasOwn(draft.instances, body.instance_name) ? draft.instances[body.instance_name] : undefined;
  draft.instances = { ...draft.instances, [body.instance_name]: body.existing_agent && existing
    // #1519 P7: an existing agent keeps everything it has; only its connection becomes the new one — and a topic of
    // another chat is not carried into this one (#1549 review: releasesTopic).
    ? withMovedTopic({ ...existing, channel_id: plan.channel_id }, movedTopic(cfg, body.instance_name, plan.channel))
    : { ...(existing ?? {}), working_directory: body.working_directory, backend: body.backend, channel_id: plan.channel_id },
  } as FleetConfig["instances"];
  return draft;
}

export interface QuickstartApiContext {
  readonly webToken?: string | null;
  readonly webSessions?: import("./web-session.js").WebSessionStore | null;
  fleetConfig: FleetConfig | null;
  dataDir: string;
  logger: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void };
  /** SetupHost returns an undo for its exact persisted write; ordinary fleet writers keep their existing contract. */
  saveFleetConfig(): void | (() => boolean);
  settingsCommitted?(execution?: SettingsExecution): void;
  /** Only a running fleet can answer this; without one, nothing is polling. */
  isBotTokenInUse?(token: string): boolean;
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return readBoundedWebBody(req, maxBytes);
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
export function validateWizardInput(input: Partial<WizardPlanInput>, opts: { tokenEnvOptional?: boolean } = {}): string | null {
  if (input.platform !== "telegram" && input.platform !== "discord") return "platform must be telegram or discord";
  if (input.connection_only !== undefined && typeof input.connection_only !== "boolean") return "connection_only must be a boolean";
  if (input.existing_agent !== undefined && typeof input.existing_agent !== "boolean") return "existing_agent must be a boolean";
  if (input.token_env_generated !== undefined && typeof input.token_env_generated !== "boolean") return "token_env_generated must be a boolean";
  if (!(opts.tokenEnvOptional && input.token_env === undefined) && (!input.token_env || !TOKEN_ENV_PATTERN.test(input.token_env))) return "token_env must be an UPPER_SNAKE env var name";
  if (input.channel_id !== undefined && (typeof input.channel_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(input.channel_id))) return "channel_id must be [A-Za-z0-9_-], up to 32 characters";
  if (!input.connection_only) {
    if (!input.instance_name || !/^[A-Za-z0-9._-]{1,128}$/.test(input.instance_name)) return "instance_name must be [A-Za-z0-9._-]";
    // An existing agent keeps its own directory and backend: neither is asked for.
    if (!input.existing_agent) {
      if (!input.backend || !KNOWN_BACKENDS.includes(input.backend)) return "backend must be a known backend";
      if (!input.working_directory || !input.working_directory.startsWith("/")) return "working_directory must be an absolute path";
    }
  }
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
      agents: Object.entries(cfg?.instances ?? {}).map(([name, inst]) => ({
        name, working_directory: (inst as { working_directory?: string }).working_directory ?? null, backend: (inst as { backend?: string }).backend ?? null })),
    } satisfies WizardEnvironment);
    return true;
  }

  if (method === "POST" && path === "/api/settings/quickstart/probe") {
    if (gatewayRequestContext(req)) { json(res, 403, { error: "Token verification is not permitted over a public link" }); return true; }
    readBody(req, 16 * 1024).then(async buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      let body: Record<string, unknown>;
      try { body = JSON.parse(buf.toString("utf-8") || "{}") as Record<string, unknown>; }
      catch { return json(res, 400, { error: "invalid JSON" }); }
      const token = typeof body.token === "string" ? body.token : "";
      if (!token) return json(res, 400, { error: "token required" });
      const action = String(body.action ?? "");
      if (action !== "verify" && action !== "guilds" && action !== "channels" && action !== "await-telegram-start") {
        return json(res, 400, { error: "unknown probe" });
      }
      const platform = body.platform === "discord" ? "discord" : "telegram";
      // The token is read, used for one outbound call, and dropped. It is never
      // logged and never echoed back in the response.
      ctx.logger.info({ action, platform }, "settings: quickstart probe");
      const result = await runProviderProbe(
        { action, platform, token, offset: typeof body.offset === "number" ? body.offset : 0, guild_id: typeof body.guild_id === "string" ? body.guild_id : "" } as never,
        { isTokenInUse: candidate => ctx.isBotTokenInUse?.(candidate) ?? false },
      );
      json(res, result.ok ? 200 : 409, result);
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  if (method === "POST" && path === "/api/settings/quickstart/plan") {
    if (!cfg) { json(res, 503, { error: "fleet not loaded" }); return true; }
    readBody(req, 16 * 1024).then(buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      let body: WizardPlanInput;
      try { body = JSON.parse(buf.toString("utf-8") || "{}") as WizardPlanInput; }
      catch { return json(res, 400, { error: "invalid JSON" }); }
      const invalid = validateWizardInput(body, { tokenEnvOptional: true });
      if (invalid) return json(res, 400, { error: invalid });
      const channels = wizardChannels(cfg);
      const conflict = newConnectionConflict(body, { channels }) ?? agentConflict(body, cfg);
      if (conflict) return json(res, 409, { error: conflict });
      // A generated name avoids every name already held: connections', providers', this data dir's .env, this process's.
      let envFile: Set<string>;
      try { envFile = envFileKeys(ctx.dataDir); }
      catch (err) { if (err instanceof EnvFileUnreadableError) return json(res, 503, { error: err.message }); throw err; }
      const taken = takenTokenEnvNames({ channelEnvs: channels.map(c => c.token_env), envFile, processEnv: Object.keys(process.env) });
      json(res, 200, withTopicRelease(planQuickstart(withExistingAgent(body, cfg), {
        backends: body.connection_only ? [] : detectWizardBackends(),
        has_fleet: Object.keys(cfg.instances ?? {}).length > 0,
        channels,
        taken_env: taken,
      }), cfg, body));
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  if (method === "POST" && path === "/api/settings/quickstart/commit") {
    if (!cfg) { json(res, 503, { error: "fleet not loaded" }); return true; }
    readBody(req, 16 * 1024).then(buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      let body: WizardPlanInput & { token?: string };
      try { body = JSON.parse(buf.toString("utf-8") || "{}") as WizardPlanInput & { token?: string }; }
      catch { return json(res, 400, { error: "invalid JSON" }); }
      const invalid = validateWizardInput(body);
      if (invalid) return json(res, 400, { error: invalid });
      if (!body.token) return json(res, 400, { error: "token required" });

      const summary = wizardChannels(cfg);
      // Never a replacement (#1519 P1, S1): an id or token env another connection holds is refused before anything moves.
      const conflict = newConnectionConflict(body, { channels: summary }) ?? agentConflict(body, cfg);
      if (conflict) return json(res, 409, { error: conflict });
      const plan = planQuickstart(withExistingAgent(body, cfg), {
        backends: detectWizardBackends(),
        has_fleet: Object.keys(cfg.instances ?? {}).length > 0,
        channels: summary,
      });

      // Everything is assembled and validated on a copy. Nothing on disk and
      // nothing in memory moves until the whole result is known to be valid —
      // the previous order wrote the token first and left the running config
      // rewritten when validation then failed.
      const draft = draftQuickstart(cfg, body, plan);

      const validation = validateFleetConfig(draft);
      if (!validation.valid) {
        return json(res, 400, { error: validation.errors.map(e => `${e.path}: ${e.message}`).join("; ") });
      }

      const execution = settingsRequestExecution(req), envPath = join(ctx.dataDir, ".env");
      const lease = trySettingsLease([settingsFileResource(envPath)], execution?.owner);
      if (!lease) return json(res, 409, { error: "another secret operation is still running" });
      let stored = false, secretBefore: import("./secret-store.js").SecretSnapshot | undefined;
      const agent = !body.connection_only;
      const before = { channels: cfg.channels, channel: cfg.channel, instance: agent ? cfg.instances[body.instance_name] : undefined,
        hadInstance: agent && Object.hasOwn(cfg.instances, body.instance_name) };
      let store: SecretStore | undefined;
      const rollback: { config?: () => boolean } = {};
      try {
        execution?.assert();
        // A generated name is re-checked here, under the .env lease, against what the write would overwrite (#1529 review).
        if (body.token_env_generated) {
          let stale: string | null;
          try { stale = generatedTokenEnvStale(body.token_env, { dataDir: ctx.dataDir, channelEnvs: summary.map(c => c.token_env) }); }
          catch (err) { if (err instanceof EnvFileUnreadableError) return json(res, 503, { error: err.message }); throw err; }
          if (stale) return json(res, 409, { error: stale });                // nothing written yet; the lease goes in finally
        }
        store = new SecretStore(envPath, new Set([body.token_env]), { owner: lease.owner });
        settingsWrite(req, () => {
          secretBefore = store!.write(body.token_env, body.token!); stored = true;
          cfg.channels = draft.channels; delete cfg.channel;
          if (agent) Object.defineProperty(cfg.instances, body.instance_name, { value: draft.instances[body.instance_name], enumerable: true, writable: true, configurable: true });
          const undo = ctx.saveFleetConfig();
          if (typeof undo === "function") rollback.config = undo;
          ctx.settingsCommitted?.(execution);
        });
      } catch (err) {
        cfg.channels = before.channels;
        if (before.channel !== undefined) cfg.channel = before.channel; else delete cfg.channel;
        if (before.hadInstance) cfg.instances[body.instance_name] = before.instance!; else if (agent) delete cfg.instances[body.instance_name];
        let cleanupFailed = false;
        try { if (rollback.config && !rollback.config()) cleanupFailed = true; } catch { cleanupFailed = true; }
        try { if (stored && secretBefore) store!.restoreIfCurrent(secretBefore); } catch { cleanupFailed = true; }
        if (cleanupFailed) return json(res, 500, { error: "setup cleanup failed; inspect configuration on the host" });
        return json(res, err instanceof SettingsExecutionError ? 409 : 500, { error: "setup was not committed" });
      } finally { lease.release(); }
      ctx.logger.info({ instance: agent ? body.instance_name : null, connection: plan.channel_id, platform: body.platform }, "settings: quickstart committed");
      // No apply here: the page starts the ordinary job so the wizard's last
      // step has the same progress, deadline and restart recovery as everything
      // else the panel applies.
      json(res, 200, { ok: true, plan, secret_mode_ok: true, warnings: plan.warnings });
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }


  return false;
}
