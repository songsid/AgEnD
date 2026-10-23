/**
 * #2490: #2481's "installed, but the fleet fails to start" notice, in chat — for someone who uses AgEnD only from
 * Discord or Telegram and sees no banner, doctor row or macOS notification.
 *
 * A fleet that fails to start has no adapter to post with, and a child left behind dies with it (systemd's KillMode=mixed
 * kills the unit's leftovers). So `fleet start` itself sends it, from start-attempt.ts — before the rest of AgEnD loads —
 * on the third attempt of a version within ATTEMPT_WINDOW_MS with no start completed (systemd gives up after 4 quick
 * starts, launchd retries every 10 s): it claims the notice for that version with an O_EXCL file
 * (`fleet-start-chat-notified-<version>`: once per version, whatever came of it, and no writer of the attempts record
 * can undo it), then runs this module as a child and waits for it, at most CHAT_NOTICE_TIMEOUT_MS (notifyChatOnce in
 * start-failure.ts). A `fleet start` the lock will refuse (another live fleet) is not an attempt at all (start-attempt.ts).
 * The child posts one message with the platform's REST API — General's topic, else a DM to the channel's first admin —
 * and the attempt carries on starting.
 *
 * Best effort: a fleet.yaml, .env or package too broken to read, or no network, means no message. Never a token in a
 * log or on stderr: only the platform and an HTTP status.
 *
 * The decision and the claim are start-failure.ts's (notifyChatOnce, node built-ins only: start-attempt.ts loads nothing
 * more before it records the attempt). This child uses only node built-ins, js-yaml and dependency-free modules: the
 * rest of the package may be what is broken.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";
import { parseEnvText } from "./env-file.js";
import { detectLocale, setLocale } from "./locale.js";
import { startFailureLines } from "./start-failure-notice.js";
import {
  ATTEMPT_WINDOW_MS, CHAT_NOTICE_TIMEOUT_MS, keptCopies, ownPackage, previousVersion, readAttempts, readStarted,
  type AttemptsRecord, type StartedRecord,
} from "./start-failure.js";
import { validateTelegramApiRoot } from "./telegram-api-root.js";

const DISCORD_API = "https://discord.com/api/v10";
const TELEGRAM_API = "https://api.telegram.org";

export type ChatTarget =
  | { platform: "telegram"; token: string; apiRoot: string; chatId: string; threadId?: number }
  | { platform: "discord"; token: string; channelId: string }
  | { platform: "discord-dm"; token: string; userId: string };

type RawChannel = { id?: unknown; type?: unknown; bot_token_env?: unknown; group_id?: unknown; telegram_api_root?: unknown; access?: { allowed_users?: unknown } };
type RawInstance = { general_topic?: unknown; topic_id?: unknown; channel_id?: unknown };
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null);

/**
 * Where the notice goes, from fleet.yaml as parsed (not loaded: loading has side effects) and the bot tokens: General's
 * topic — the General on the primary channel, else the first — else a DM to the primary channel's first admin. Null
 * when there is nowhere, or no token.
 */
export function chatNoticeTarget(raw: unknown, env: (key: string) => string | undefined): ChatTarget | null {
  const config = raw && typeof raw === "object" ? raw as { channels?: unknown; channel?: unknown; instances?: unknown } : {};
  const channels = (Array.isArray(config.channels) ? config.channels : config.channel ? [config.channel] : [])
    .filter((c): c is RawChannel => !!c && typeof c === "object");
  if (!channels.length) return null;
  const idOf = (c: RawChannel) => str(c.id) ?? str(c.type);
  const primary = channels[0]!;
  const instances = config.instances && typeof config.instances === "object" ? Object.values(config.instances as Record<string, unknown>) : [];
  const generals = instances.filter((i): i is RawInstance => !!i && typeof i === "object" && (i as RawInstance).general_topic === true && str((i as RawInstance).topic_id) !== null);
  const general = generals.find(g => (str(g.channel_id) ?? idOf(primary)) === idOf(primary)) ?? generals[0];
  const channel = general ? channels.find(c => idOf(c) === (str(general.channel_id) ?? idOf(primary))) : primary;
  if (!channel) return null;
  const tokenKey = str(channel.bot_token_env);
  const token = tokenKey ? env(tokenKey)?.trim() : undefined;
  if (!token) return null;
  const type = str(channel.type);
  const admin = Array.isArray(channel.access?.allowed_users) ? str(channel.access!.allowed_users[0]) : null;
  if (type === "telegram") {
    const apiRoot = (str(channel.telegram_api_root) ?? TELEGRAM_API).replace(/\/+$/, "");
    validateTelegramApiRoot(apiRoot);
    if (general && str(channel.group_id)) {
      const thread = str(general.topic_id)!;
      // General's own forum topic (id 1) takes no message_thread_id (as the adapter's toThreadId).
      return { platform: "telegram", token, apiRoot, chatId: str(channel.group_id)!, ...(thread !== "1" ? { threadId: Number(thread) } : {}) };
    }
    return admin ? { platform: "telegram", token, apiRoot, chatId: admin } : null;
  }
  if (type === "discord") {
    if (general) return { platform: "discord", token, channelId: str(general.topic_id)! };
    return admin ? { platform: "discord-dm", token, userId: admin } : null;
  }
  return null;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Post the notice. The outcome names the platform and an HTTP status, never the URL (a Telegram URL holds the token). */
export async function postChatNotice(target: ChatTarget, text: string, doFetch: Fetch = fetch as unknown as Fetch, timeoutMs = CHAT_NOTICE_TIMEOUT_MS - 1_000): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs);
  const post = (url: string, headers: Record<string, string>, body: unknown) =>
    doFetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  try {
    if (target.platform === "telegram") {
      const res = await post(`${target.apiRoot}/bot${target.token}/sendMessage`, {},
        { chat_id: target.chatId, text, ...(target.threadId !== undefined ? { message_thread_id: target.threadId } : {}) });
      return res.ok ? "sent (telegram)" : `not sent (telegram: HTTP ${res.status})`;
    }
    const auth = { Authorization: `Bot ${target.token}` };
    let channelId = target.platform === "discord" ? target.channelId : null;
    if (target.platform === "discord-dm") {
      const dm = await post(`${DISCORD_API}/users/@me/channels`, auth, { recipient_id: target.userId });
      if (!dm.ok) return `not sent (discord DM: HTTP ${dm.status})`;
      channelId = str(((await dm.json()) as { id?: unknown } | null)?.id);
      if (!channelId) return "not sent (discord DM: no channel)";
    }
    const res = await post(`${DISCORD_API}/channels/${channelId}/messages`, auth, { content: text.slice(0, 2000), allowed_mentions: { parse: [] } });
    return res.ok ? `sent (${target.platform})` : `not sent (${target.platform}: HTTP ${res.status})`;
  } catch (err) {
    return `not sent (${target.platform}: ${err instanceof Error && err.name === "TimeoutError" ? "timed out" : "network error"})`;
  }
}

/** The notice's text: #2481's words, in the fleet's language. */
export function chatNoticeText(home: string, record: AttemptsRecord, started: StartedRecord | null, now: number, prefix: string | null): string {
  const recent = record.attempts.filter(a => { const at = Date.parse(a); return Number.isFinite(at) && at <= now && now - at <= ATTEMPT_WINDOW_MS; }).length;
  return startFailureLines({
    failing: true, version: record.version,
    previous: previousVersion(record.version, started, prefix ? keptCopies(prefix) : []),
    detail: `${recent} start attempts in the last ${ATTEMPT_WINDOW_MS / 60000} minutes, none completed`,
  }, home).map(line => line.trim()).join("\n");
}

/** The child: read what it needs, post, say one line on stderr. */
async function main(home: string): Promise<void> {
  const record = readAttempts(home);
  if (!record) return;
  let raw: unknown = null;
  try { raw = yaml.load(readFileSync(join(home, "fleet.yaml"), "utf8")); } catch { /* no config: nowhere to post */ }
  let fileEnv = new Map<string, string>();
  try { fileEnv = parseEnvText(readFileSync(join(home, ".env"), "utf8")); } catch { /* the service's own environment only */ }
  setLocale(detectLocale(raw as { defaults?: { locale?: string } } | undefined));
  let target: ChatTarget | null = null;
  try { target = chatNoticeTarget(raw, key => fileEnv.get(key) ?? process.env[key]); } catch { /* e.g. a refused API root */ }
  if (!target) { process.stderr.write("AgEnD start-failure chat notice: no General topic, admin or bot token to post with\n"); return; }
  const outcome = await postChatNotice(target, chatNoticeText(home, record, readStarted(home), Date.now(), ownPackage().prefix));
  process.stderr.write(`AgEnD start-failure chat notice: ${outcome}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2]) {
  void main(process.argv[2]).catch(() => { /* best effort */ });
}
