/**
 * Read-only questions the setup flow asks a chat provider.
 *
 * Verify a bot token, list the guilds it is in, wait for the first `/start` in a
 * group. Nothing here writes configuration and nothing returns the token it was
 * given — these are the probes the CLI quickstart already made, lifted out so
 * the Settings wizard asks the provider exactly the same questions instead of
 * carrying a second copy of them.
 */
import { execFileSync } from "node:child_process";

export interface BotIdentity {
  valid: boolean;
  username: string | null;
  id: string | null;
  /** Why it was rejected, when the provider said something useful. */
  reason?: string;
}

export interface DiscordGuild {
  id: string;
  name: string;
}

export interface TelegramStartResult {
  groupId: number;
  userId: number;
}

const DISCORD_API = "https://discord.com/api/v10";

export async function verifyDiscordToken(token: string, doFetch = fetch): Promise<BotIdentity> {
  try {
    const res = await doFetch(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bot ${token}` } });
    if (!res.ok) return { valid: false, username: null, id: null, reason: `Discord replied ${res.status}` };
    // For a bot user, the account id is also its application (client) id.
    const data = (await res.json()) as { username?: string; id?: string };
    return { valid: true, username: data.username ?? null, id: data.id ?? null };
  } catch (err) {
    return { valid: false, username: null, id: null, reason: (err as Error).message };
  }
}

export async function listDiscordGuilds(token: string, doFetch = fetch): Promise<DiscordGuild[]> {
  try {
    const res = await doFetch(`${DISCORD_API}/users/@me/guilds`, { headers: { Authorization: `Bot ${token}` } });
    if (!res.ok) return [];
    return (await res.json()) as DiscordGuild[];
  } catch { return []; }
}

export async function verifyTelegramToken(token: string, doFetch = fetch): Promise<BotIdentity> {
  try {
    const res = await doFetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as { ok?: boolean; description?: string; result?: { id?: number; username?: string } };
    if (!res.ok || !data.ok) {
      return { valid: false, username: null, id: null, reason: data.description ?? `Telegram replied ${res.status}` };
    }
    return { valid: true, username: data.result?.username ?? null, id: data.result?.id != null ? String(data.result.id) : null };
  } catch (err) {
    return { valid: false, username: null, id: null, reason: (err as Error).message };
  }
}

/** Long-polling `getUpdates` has one consumer. A second one takes turns with the
 * first and both miss messages, which is why a running fleet must never be
 * polled behind its own back — the caller checks that before getting here. */
export class TelegramPollConflictError extends Error {}

/**
 * Wait for someone to post in a group the bot is in, and report both ids.
 *
 * Bounded by `deadlineMs`: a browser is waiting on the other end, and an
 * unbounded wait is a request that never answers. `offset` carries the cursor
 * between calls so a caller that polls in short slices does not re-read
 * consumed updates.
 */
export async function awaitTelegramGroupStart(
  token: string,
  opts: { deadlineMs: number; offset?: number; now?: () => number; doFetch?: typeof fetch },
): Promise<{ found: TelegramStartResult | null; offset: number }> {
  const doFetch = opts.doFetch ?? fetch;
  const now = opts.now ?? Date.now;
  const started = now();
  let offset = opts.offset ?? 0;

  if (offset === 0) {
    // Drop whatever is already queued: the group we want is the one the user is
    // about to post in, not one they wrote to last week.
    const stale = await doFetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1&timeout=0`);
    const data = (await stale.json()) as { ok?: boolean; description?: string; result?: { update_id: number }[] };
    if (data.ok === false && /conflict/i.test(data.description ?? "")) {
      throw new TelegramPollConflictError(data.description ?? "another getUpdates consumer is active");
    }
    if (data.result?.length) offset = data.result[data.result.length - 1]!.update_id + 1;
  }

  while (now() - started < opts.deadlineMs) {
    const remaining = Math.max(0, opts.deadlineMs - (now() - started));
    const timeout = Math.max(1, Math.min(25, Math.floor(remaining / 1000)));
    const res = await doFetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=${timeout}`);
    const data = (await res.json()) as {
      ok?: boolean;
      description?: string;
      result?: Array<{ update_id: number; message?: { chat?: { id: number; type: string }; from?: { id: number } } }>;
    };
    if (data.ok === false && /conflict/i.test(data.description ?? "")) {
      throw new TelegramPollConflictError(data.description ?? "another getUpdates consumer is active");
    }
    for (const update of data.result ?? []) {
      offset = update.update_id + 1;
      const chat = update.message?.chat;
      const from = update.message?.from;
      if ((chat?.type === "group" || chat?.type === "supergroup") && from?.id) {
        return { found: { groupId: chat.id, userId: from.id }, offset };
      }
    }
    if (!data.result?.length) break; // long poll already waited; let the caller decide
  }
  return { found: null, offset };
}

/** CLI backends actually installed on this host. */
export function detectInstalledBackends(
  candidates: ReadonlyArray<{ name: string; binary: string }>,
  run: (binary: string) => void = binary => { execFileSync("which", [binary], { stdio: "pipe", timeout: 2000 }); },
): string[] {
  const found: string[] = [];
  for (const candidate of candidates) {
    try { run(candidate.binary); found.push(candidate.name); } catch { /* not installed */ }
  }
  return found;
}
