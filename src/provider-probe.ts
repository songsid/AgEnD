/**
 * Read-only questions the setup flow asks a chat provider.
 *
 * Verify a bot token, list its guilds, or observe a new setup message. Nothing
 * here writes configuration and nothing returns the token it was
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

/** IDs remain strings: converting a Discord snowflake to Number loses precision. */
export function isDiscordSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{16,19}$/.test(value);
}

/** A setup must name an actual user, never a group id, an empty list or a coerced number. */
export function isAdminUserId(platform: "telegram" | "discord", value: unknown): value is string {
  return platform === "discord" ? isDiscordSnowflake(value)
    : typeof value === "string" && /^[1-9]\d{0,19}$/.test(value);
}

export interface DiscordUserCandidate { userId: string; username: string }

/** The small WebSocket surface the disposable probe needs; injectable for offline gateway tests. */
export interface DiscordProbeSocket {
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/**
 * Wait for a NEW human message in the chosen guild or in a DM to the bot. This
 * observes a candidate, not authority: the interactive caller must confirm it.
 * GuildMessages + DirectMessages reveal the author without MessageContent.
 * No history fetch, message-content access, config write or persistent client.
 */
export function awaitDiscordUserMessage(token: string, guildId: string, opts: {
  deadlineMs: number; signal?: AbortSignal; now?: () => number; doFetch?: typeof fetch;
  makeSocket?: (url: string) => DiscordProbeSocket;
  onReady?: () => void;
}): Promise<DiscordUserCandidate | null> {
  if (!isDiscordSnowflake(guildId) || !token || !Number.isFinite(opts.deadlineMs) || opts.deadlineMs <= 0 || opts.signal?.aborted) return Promise.resolve(null);
  const now = opts.now ?? (() => performance.now());
  const deadline = now() + Math.min(opts.deadlineMs, 60_000);
  const controller = new AbortController();
  return new Promise(resolve => {
    let socket: DiscordProbeSocket | undefined, done = false, ready = false, identified = false;
    let sequence: number | null = null, awaitingAck = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const current = () => !done && !opts.signal?.aborted && now() < deadline;
    const finish = (found: DiscordUserCandidate | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearInterval(heartbeat);
      opts.signal?.removeEventListener("abort", abort);
      controller.abort();
      if (socket) {
        socket.removeEventListener("message", message);
        socket.removeEventListener("error", abort);
        socket.removeEventListener("close", abort);
        try { socket.close(1000, "Setup probe finished"); } catch { /* already closed */ }
      }
      resolve(found);
    };
    const abort = () => finish(null);
    const send = (packet: unknown) => {
      if (!current()) { finish(null); return; }
      try { socket!.send(JSON.stringify(packet)); } catch { finish(null); }
    };
    const beat = () => {
      if (awaitingAck) { finish(null); return; }
      awaitingAck = true;
      send({ op: 1, d: sequence });
    };
    const message = (event: { data?: unknown }) => {
      if (!current()) { finish(null); return; }
      if (typeof event.data !== "string" || event.data.length > 256 * 1024) { finish(null); return; }
      let packet: any;
      try { packet = JSON.parse(event.data); } catch { finish(null); return; }
      if (!packet || typeof packet !== "object") { finish(null); return; }
      if (Number.isSafeInteger(packet.s) && packet.s >= 0) sequence = packet.s;
      if (packet.op === 10) {
        const interval = packet.d?.heartbeat_interval;
        if (identified || !Number.isFinite(interval) || interval < 100 || interval > 120_000) { finish(null); return; }
        identified = true;
        // Only these two non-privileged intents; the probe never needs content.
        send({ op: 2, d: { token, intents: (1 << 9) | (1 << 12), properties: { os: process.platform, browser: "agend", device: "agend-quickstart" } } });
        if (!current()) return;
        beat(); // First heartbeat has zero jitter, then the provider's interval.
        if (!current()) return;
        heartbeat = setInterval(beat, interval);
        return;
      }
      if (packet.op === 11) { awaitingAck = false; return; }
      if (packet.op === 1) { awaitingAck = true; send({ op: 1, d: sequence }); return; }
      // A short setup probe never reconnects/resumes, including invalid-session.
      if (packet.op === 7 || packet.op === 9) { finish(null); return; }
      if (packet.op !== 0 || !identified) return;
      if (packet.t === "READY") {
        if (!ready) {
          ready = true;
          try { opts.onReady?.(); } catch { finish(null); }
        }
        return;
      }
      if (!ready || packet.t !== "MESSAGE_CREATE") return;
      const msg = packet.d, author = msg?.author;
      // Only authored Default/Reply messages. Missing bot=false is Discord's
      // normal human-user shape; explicit bot/system/webhook values refuse.
      if (!msg || (msg.type !== 0 && msg.type !== 19) || msg.webhook_id != null
        || !isDiscordSnowflake(msg.id) || !isDiscordSnowflake(msg.channel_id)
        || !author || (author.bot !== undefined && author.bot !== false) || (author.system !== undefined && author.system !== false)
        || !isDiscordSnowflake(author.id) || typeof author.username !== "string" || !author.username || author.username.length > 64 || /[\u0000-\u001f\u007f]/.test(author.username)
        || (msg.guild_id !== undefined && msg.guild_id !== guildId)) return;
      if (!current()) { finish(null); return; }
      finish({ userId: author.id, username: author.username });
    };
    const timer = setTimeout(abort, Math.max(1, deadline - now()));
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (!current()) { finish(null); return; }
    // Abort bounds REST discovery too; a late response cannot open a socket.
    void (async () => {
      try {
        const response = await (opts.doFetch ?? fetch)(`${DISCORD_API}/gateway`, { signal: controller.signal });
        if (!current() || !response.ok) { finish(null); return; }
        const data = await response.json() as { url?: string };
        if (!current()) { finish(null); return; }
        const url = new URL(data.url ?? "");
        if (url.protocol !== "wss:" || url.hostname !== "gateway.discord.gg" || url.username || url.password || url.port) { finish(null); return; }
        url.search = "?v=10&encoding=json";
        const created = (opts.makeSocket ?? (target => new WebSocket(target)))(url.toString());
        if (!current()) { try { created.close(1000, "Setup probe finished"); } catch { /* retired during creation */ } finish(null); return; }
        socket = created;
        socket.addEventListener("message", message);
        socket.addEventListener("error", abort);
        socket.addEventListener("close", abort);
      } catch { finish(null); } // Never echo a token-bearing gateway error.
    })();
  });
}

export interface TelegramStartResult {
  groupId: number;
  userId: number;
}

const DISCORD_API = "https://discord.com/api/v10";

/** Provider errors are not safe to surface verbatim: Telegram's HTTP client
 * commonly includes the full bot URL (and therefore the token) in FetchError. */
export function redactProviderError(error: unknown, secret?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (secret) message = message.split(secret).join("[redacted]");
  message = message.replace(/(https?:\/\/[^\s/]+\/bot)[^\s/?]+/gi, "$1[redacted]");
  message = message.replace(/\b(Bot|Bearer)\s+[^\s]+/gi, "$1 [redacted]");
  return message.slice(0, 240);
}

export async function verifyDiscordToken(token: string, doFetch = fetch): Promise<BotIdentity> {
  try {
    const res = await doFetch(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bot ${token}` } });
    if (!res.ok) return { valid: false, username: null, id: null, reason: `Discord replied ${res.status}` };
    // For a bot user, the account id is also its application (client) id.
    const data = (await res.json()) as { username?: string; id?: string };
    return { valid: true, username: data.username ?? null, id: data.id ?? null };
  } catch (err) {
    return { valid: false, username: null, id: null, reason: redactProviderError(err, token) };
  }
}

export async function listDiscordGuilds(token: string, doFetch = fetch): Promise<DiscordGuild[]> {
  try {
    const res = await doFetch(`${DISCORD_API}/users/@me/guilds`, { headers: { Authorization: `Bot ${token}` } });
    if (!res.ok) return [];
    return (await res.json()) as DiscordGuild[];
  } catch { return []; }
}

export interface DiscordTextChannel { id: string; name: string }

/**
 * #1519 P3: a server's text channels, as the bot sees them (GET /guilds/{id}/channels with its token), in Discord's
 * order — for the General channel picker. A guild the bot is not in, or one it cannot list, is { ok: false }.
 */
export async function listDiscordTextChannels(token: string, guildId: string, doFetch = fetch): Promise<{ ok: true; channels: DiscordTextChannel[] } | { ok: false; error: string }> {
  if (!/^\d{1,20}$/.test(guildId)) return { ok: false, error: "guild id must be numeric" };
  try {
    const res = await doFetch(`${DISCORD_API}/guilds/${guildId}/channels`, { headers: { Authorization: `Bot ${token}` } });
    if (!res.ok) return { ok: false, error: `Discord replied ${res.status}` };
    const rows = (await res.json()) as Array<{ id?: string; name?: string; type?: number; position?: number }>;
    const text = (Array.isArray(rows) ? rows : []).filter(c => c && c.type === 0 && typeof c.id === "string" && typeof c.name === "string");
    text.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    return { ok: true, channels: text.map(c => ({ id: c.id!, name: c.name! })) };
  } catch (err) {
    return { ok: false, error: redactProviderError(err, token) };
  }
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
    return { valid: false, username: null, id: null, reason: redactProviderError(err, token) };
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
