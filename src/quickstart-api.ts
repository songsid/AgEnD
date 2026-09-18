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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeSecretFile, type SecretWriteResult } from "./secret-file.js";
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
