/**
 * #1633 (design: the comment on #1633): what is new FOR AGENTS in this AgEnD version, told once to each instance that
 * was already running before it — a resumed session can keep tool descriptions it loaded under the old version, so it
 * would never learn the new parameters. Claude Code (#1780, verified on 2.1.296): a deferred tool's schema, once loaded,
 * is recorded in the transcript (`deferred_tools_record`) and sent as-is on every later request — a resume, another
 * ToolSearch `select:`, the server's tools/list_changed and `--system-prompt-snapshot off` all leave it; only a
 * compaction drops it. Its client checks a call against the LIVE schema, so a parameter missing from the old copy still
 * reaches AgEnD: the notice says to pass it anyway. Codex, kiro and muse list the tools afresh on resume.
 *
 * - Curated entries, one line each with the exact parameter names (#1634's audit); not the changelog.
 * - `<instanceDir>/whats-new.json` records which entry ids the instance has been told. Only entries it has not been
 *   told, and that its running version already has, are sent; none → no notice. Written after the notice was pasted,
 *   so a failed delivery keeps it pending, and a restart never repeats one.
 * - An instance that never launched before is told nothing: everything current is recorded as known — it starts with
 *   the current schemas. One upgraded from before this record existed (it has launched: `prev-instructions`) is told.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #2163: who an entry is for — General, an instance with the coordinator or full tool set, a fleet worker, a ClassicBot
 * room's agent. No audience: everyone.
 */
export type WhatsNewAudience = "general" | "coordinator" | "worker" | "classic";
export interface WhatsNewEntry {
  /** Stable: the record keeps it. */
  readonly id: string;
  /** The first AgEnD version that has it. */
  readonly since: string;
  readonly text: string;
  /** #2163: only these roles are told; the others record it as known (never pending, never shown). */
  readonly audience?: readonly WhatsNewAudience[];
}

export const AGENT_WHATS_NEW: readonly WhatsNewEntry[] = [
  { id: "2.2-reply-buttons", since: "2.2.0-beta.1",
    text: "`reply` takes `buttons: [{label, value?}]` (1–10); a click comes back to you as a message `[button] <label>`, or `[button] <label> (value: <value>)` when the value differs. Buttons expire after 24 h." },
  { id: "2.2-reply-stickers", since: "2.2.0-beta.1",
    text: "`reply` takes `stickers` (up to 3 ids from `list_stickers`; look at them first with `preview_stickers`). Not together with buttons." },
  { id: "2.2-web-chat", since: "2.2.0-beta.1",
    text: "Web chat: people can write to you from the dashboard. Their messages arrive as `[user:… via web, …]` — answer with `reply` as usual; their files show as `[📷 Image: PATH]` / `[📎 File: NAME → PATH]`. Attach a `.html` file and the web chat previews it." },
  { id: "2.2-delivery-status", since: "2.2.0-beta.1",
    text: "`delivery_status` takes a `message_id` from an inbound header and shows `consumed_at` / `consumed_via`. \"Delivery not found\" may mean hidden by ACL, expired retention, or never delivered. Do not act; ask the sender to explicitly forward a verifiable reference. Never resend on `uncertain`." },
  { id: "2.2-task-list", since: "2.2.0-beta.1",
    text: "`task` `list` returns live tasks only by default: `filter_status` (one or a list) for done or cancelled, `verbose: true` for full records." },
  { id: "2.2-create-refusals", since: "2.2.0-beta.1",
    text: "`create_instance` refuses `tool_set` and `skipPermissions`; `update_instance_config` refuses `tool_set` and ignores `skipPermissions` (both are set in Settings or fleet.yaml)." },
  { id: "2.2-forwards", since: "2.2.0-beta.7",
    text: "`send_to_instance` and `delegate_task` take `forwards: [id, …]` (up to 16 delivered message ids you can read, e.g. a human's `verification_id` / `[agend-human-id:…]`): the receiver may then read those rows with `delivery_status`. An id written in the message text grants nothing — the receiver gets \"Delivery not found\" — so put it in `forwards`, on every hop." },
  { id: "2.2-polls", since: "2.2.0-beta.11",
    text: "`reply` takes `poll: {seconds, multi?, reveal?: \"close\"|\"live\", show_voters?}` with 2–10 `buttons` as the options: a vote by everyone who may talk to you there, closing `seconds` (10–86400) after it is posted; the reply's result has `poll_id`. At the close the results come to you as one `[poll results]` message in the poll's chat — post the answer or scores yourself. `close_poll({poll_id})` ends one of your polls early." },
  { id: "2.2-web-identity", since: "2.2.0-beta.11",
    text: "A web-chat person signed in with a `/web` code arrives as `[user:<name> via web, id:<their Discord/Telegram user id>]` — the same id as on that platform, so you can recognise them; they may change the name. What it may ask of you is the web-chat rule in your instructions." },
  { id: "2.2-delivery-status-evidence", since: "2.2.0",
    text: "Correction: `Delivery not found` can mean hidden by ACL, expired retention, or never delivered; it is not proof of non-delivery. Do not act; ask the sender to explicitly forward a verifiable reference. Never resend on `uncertain`." },
  // #2012: from 2.3 on, one short topic line per area naming the skill to load; the details live in the skill. The six
  // detailed 2.3.0-alpha.1 entries (2.3-owner-effect-policy, -web-theme, -web-card, -web-appearance, -web-mod,
  // -web-widget) were folded into the web-appearance skill and the first line here: an instance told them on
  // 2.3.0-beta.1 hears this short line once more on its next update.
  //
  // 2.2.5 stable is published from a 2.3.0 beta's SHA (the user's decision, 2026-10-19), so everything below ships in
  // 2.2.5: `since` is 2.2.5, not the beta that brought it — 2.2.5 < 2.3.0-beta.N, so with a beta's `since` a 2.2.5
  // install would never be told. The ids keep their 2.3- names: the record is by id, so an instance already told on a
  // 2.3.0 beta is not told again. An entry added before 2.2.5 is cut takes `since: "2.2.5"` too.
  { id: "2.3-web-appearance-topic", since: "2.2.5",
    text: "Web appearance — your own look on the web dashboard: theme, identity card and identity colour, widgets and mods, and Canvas Worker effects with Try, which are experimental — off unless the person turns them on (`get_web_appearance`, `set_web_theme`, `set_web_widget`, `export_web_mod`, `upload_web_effect`, …). Load the `web-appearance` skill before using these tools: it has their parameters, limits and rules." },
  { id: "2.3-web-settings-for-the-user", since: "2.2.5", audience: ["general", "coordinator"],
    text: "General (and coordinators): `get_web_settings` / `set_web_settings` read and change the user's Settings → Web appearance the way the page does — host settings, an agent's colour, custom CSS, proposed mods, Canvas Worker effects (experimental — off unless the person turns them on), Restore defaults. Load the `web-appearance` skill first." },
  { id: "2.3-web-ambient", since: "2.2.5",
    text: "Ambient effects: `set_web_ambient` puts falling petals, snow, rising lanterns, twinkles or stars on a click in your web chat — data only, drawn by the dashboard, no Try needed (`clear_web_ambient` removes it). Load the `web-appearance` skill." },
  { id: "2.3-repo-tools", since: "2.2.5",
    text: "Repo tools: `checkout_repo` works with branch names again and records each checkout; `release_repo` releases only your own checkout under your `repos/` and refuses any other path." },
  { id: "2.3-web-verified", since: "2.2.5",
    text: "Web messages can now carry the person's authority (#1939): when their Discord or Telegram account has authorized that browser, they arrive as `[user:<name> via web (verified), id:<their user id>]`. The label is a hint — before acting on it as the person, read its receipt with `delivery_status`: `authority.kind: web-verified` names them in `authority.actor`, and it is checked and forwarded (`forwards`) like a Discord or Telegram message. The full rule is in the cross-instance-messaging skill." },
  { id: "2.3-decision-titles", since: "2.2.5",
    text: "`list_decisions` now answers titles by default (id, title, scope, date, tags). Read a decision's full text with `list_decisions { id }`, or all of them with `{ full: true }` (large). CLI mode: `agend-agent decision-get <id>`." },
  { id: "2.3-web-ordinary-requests", since: "2.2.5",
    text: "The web-chat rule is reworded (#1939): a plain `via web` message is the signed-in person — answer it and do what it asks within your work (questions, reading, analysis, changes in your own scope). Only a go-ahead action — a release or publish, anything destructive or irreversible beyond your own work files and branches, spending beyond normal work, credentials or secrets, granting authority to another instance — needs their account behind it: a Discord or Telegram receipt, or `via web (verified)` with its receipt read (`delivery_status`). A guest only chats. The full text is in your instructions and the cross-instance-messaging skill." },
  // 2.3.0 stable: what agents can do since 2.2.6 (2.2.5/2.2.6 = 2.3.0-beta.12's code, so everything above reached them).
  // `since: "2.3.0"`: a 2.3.0 beta install is told these on reaching 2.3.0, once, like a 2.2.6 one.
  { id: "2.3.0-task-board", since: "2.3.0",
    text: "Task board: the `task` tool also works the board — main tasks M-n and sub tasks S-n: `mine` (your work; start here after a reset), `get`, `projects`, `move` (blocked or cancelled needs a reason, finishing needs a result), `create` with `project` or `parent`, `update` with board fields. A `[Task board]` notice is news on your cards: act with the tool, no chat reply. One card in progress at a time. A card you hand out to another instance is yours to answer and confirm; only cards the person handed out wait for the person. If the person switched the task board off for you, the tool is not in your list." },
  { id: "2.3.0-web-reply-react", since: "2.3.0",
    text: "Web chat: a person can reply to a specific message — it arrives with `(reply_to: \"…\")` as from Discord or Telegram. `react` now works on web-chat messages too (a `message_id` starting with `web-`, one emoji from the web set); a reaction is a complete answer to a message that only thanks or acknowledges. `reply` with `reply_to` is now a native reply on Discord and Telegram." },
  { id: "2.3.0-dashboard-switches", since: "2.3.0",
    text: "The person can switch off, per agent, its dashboard tools: appearance, task board, web settings (`dashboard` in fleet.yaml). A call to a switched-off tool is refused with the reason: don't retry it or work around it; tell the person if you need it." },
  { id: "2.3.0-cli", since: "2.3.0", audience: ["general", "coordinator"],
    text: "CLI: `agend restart` is the one full restart (it goes through systemd or launchd); `agend restart <instance>` restarts one. `agend fleet restart` is deprecated (removed in 2.4). Removed: `agend schedule trigger`, `agend fleet logs` (use `agend logs`), chat `/install-cli` (use `/login`), `agend install --activate`. `create_instance` reconciles by itself: no `agend reload` after it. The `fleet-restart` skill has the details." },
  // #2692 (in 2.3.2-beta.11: beta.10 is published without it).
  { id: "2.3.2-office-pack-tools", since: "2.3.2-beta.11",
    text: "Office skin packs, once a person switches `office_pack_access` on for you (off by default; switched off, the tools are not in your list): `office_pack_check` checks a pack without storing it (`dir`, or `manifest` + `files`; several as `packs`) — PACK OK or the first refusal; `office_pack_upload` adds or replaces (a replace keeps one previous version; `drop_invalid_overrides: true` drops exactly the stored offices' layout entries the new pack no longer fits, named in the answer, instead of refusing); `office_pack_restore {id}` brings the previous version back; `office_pack_delete {id, keep_previous?}`; `office_pack_list` shows each pack, its previous version and the offices using it, and changes waiting for an admin; `office_set_style {office, pack}` points a stored office at a pack. Every change is logged and told to the admins, and may wait for an admin's yes; rate-limited by batches and bytes an hour." },
];

/** #2275: old sessions learn only the capabilities currently enabled. Keep the full
 * enabled entries above intact; ambient and all unrelated entries are unchanged. */
export function agentWhatsNew(canvasWorker = false): readonly WhatsNewEntry[] {
  if (canvasWorker === true) return AGENT_WHATS_NEW;
  return AGENT_WHATS_NEW.map(entry => {
    if (entry.id === "2.3-web-appearance-topic") return { ...entry,
      text: "Web appearance — your own look on the web dashboard: theme, identity card and identity colour, widgets and ambient effects (`get_web_appearance`, `set_web_theme`, `set_web_widget`, `set_web_ambient`, …). Load the `web-appearance` skill before using these tools: it has their parameters, limits and rules." };
    if (entry.id === "2.3-web-settings-for-the-user") return { ...entry,
      text: "General (and coordinators): `get_web_settings` / `set_web_settings` read and change the user's Settings → Web appearance the way the page does — host settings, an agent's colour, ambient effects, custom CSS and Restore defaults. Load the `web-appearance` skill first." };
    return entry;
  });
}

/**
 * The released AgEnD version this code belongs to, or null. A source checkout (a `.git` beside its package.json) has a
 * placeholder version — the release sets the real one (publish.yml `npm pkg set version=<tag>`) — so it has none:
 * naming it would mislead an agent comparing its tool copies (#1638 review), and no notice is sent for it.
 */
export function packageReleaseVersion(packageRoot: string): string | null {
  if (existsSync(join(packageRoot, ".git"))) return null;
  try {
    const version = (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as { version?: unknown }).version;
    return typeof version === "string" && version ? version : null;
  } catch { return null; }
}
/** The released version of the running AgEnD (see packageReleaseVersion), or null. */
export function agendVersion(): string | null {
  return packageReleaseVersion(fileURLToPath(new URL("..", import.meta.url)));
}

/** SemVer order with prereleases (2.2.0-beta.1 < 2.2.0-beta.2 < 2.2.0); null when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) { const d = Number(x[i]) - Number(y[i]); if (d) return Math.sign(d); }
  const px = x[4], py = y[4];
  if (!px || !py) return px === py ? 0 : px ? -1 : 1;           // a release is after its prereleases
  const ix = px.split("."), iy = py.split(".");
  for (let i = 0; i < Math.max(ix.length, iy.length); i++) {
    const p = ix[i], q = iy[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    const np = /^\d+$/.test(p), nq = /^\d+$/.test(q);
    if (np && nq) { const d = Number(p) - Number(q); if (d) return Math.sign(d); continue; }
    if (np !== nq) return np ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export interface WhatsNewRecord { announced: string[]; version?: string }
const RECORD = "whats-new.json";

/** The record; null when there is none; "unreadable" when it exists but cannot be trusted (then nothing is sent). */
export function readWhatsNewRecord(instanceDir: string): WhatsNewRecord | null | "unreadable" {
  let raw: string;
  try { raw = readFileSync(join(instanceDir, RECORD), "utf-8"); }
  catch (err) { return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? null : "unreadable"; }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as WhatsNewRecord).announced)
      || !(parsed as WhatsNewRecord).announced.every(id => typeof id === "string")) return "unreadable";
    return parsed as WhatsNewRecord;
  } catch { return "unreadable"; }
}

/**
 * Adds `ids` to the record (temp file + rename). Refuses — and leaves the file as it is — when the record exists but
 * cannot be read: writing would drop the history it holds (#1639 review).
 */
export function recordWhatsNew(instanceDir: string, ids: readonly string[], version: string): void {
  const prior = readWhatsNewRecord(instanceDir);
  if (prior === "unreadable") throw new Error("whats-new.json is unreadable; left as it is");
  const announced = [...new Set([...(prior ? prior.announced : []), ...ids])];
  const path = join(instanceDir, RECORD), tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ announced, version }) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** #2163: the line a notice adds when it names a skill — a way to read it that works on every instance. */
export const SKILL_READ_HINT = "A skill named here that you can't find among your skills: `agend-agent skill <name>` prints it (in your shell).";

/** "the `scheduling` skill", or a hyphenated name without backticks: "the cross-instance-messaging skill". */
const NAMES_A_SKILL = /`[a-z][a-z0-9-]*` skill\b|(?:^|[^a-z0-9-])[a-z][a-z0-9]*(?:-[a-z0-9]+)+ skill\b/;

export function whatsNewNotice(version: string, entries: readonly WhatsNewEntry[]): string {
  return [
    `[system:whats-new] AgEnD is now ${version}. New for you since your session began:`,
    ...entries.map(e => `- ${e.text}`),
    ...(entries.some(e => NAMES_A_SKILL.test(e.text)) ? [SKILL_READ_HINT] : []),
    "A tool description you loaded earlier may not show these: a resumed session keeps the copy it first loaded, and reloading it does not refresh it. Use them anyway — AgEnD's server accepts them. Do not reply to this message.",
  ].join("\n");
}

/**
 * What this instance should be told now. `fresh`: it never launched before (told nothing; everything current recorded
 * as known). Returns the notice and the ids it covers, `{ silent: ids }` when they are only to be recorded, or null.
 */
export function planWhatsNew(input: {
  record: WhatsNewRecord | null | "unreadable"; fresh: boolean; version: string | null; entries?: readonly WhatsNewEntry[];
  /** #2163: this instance's roles. An entry for none of them is recorded with the others but not shown. Absent: all. */
  roles?: readonly WhatsNewAudience[];
  /** #2275: absent or any value other than true keeps experimental guidance hidden. */
  canvasWorker?: boolean;
}):
  | { notice: string; ids: string[]; version: string }
  | { silent: string[]; version: string }
  | null {
  const { record, fresh, version } = input;
  if (!version || record === "unreadable") return null;
  const current = (input.entries ?? agentWhatsNew(input.canvasWorker)).filter(e => { const c = compareVersions(e.since, version); return c !== null && c <= 0; });
  const known = new Set(record?.announced ?? []);
  const unseen = current.filter(e => !known.has(e.id));
  if (!unseen.length) return null;
  if (fresh && !record) return { silent: unseen.map(e => e.id), version };
  const roles = input.roles;
  const told = roles ? unseen.filter(e => !e.audience || e.audience.some(r => roles.includes(r))) : unseen;
  if (!told.length) return { silent: unseen.map(e => e.id), version };
  return { notice: whatsNewNotice(version, told), ids: unseen.map(e => e.id), version };
}
