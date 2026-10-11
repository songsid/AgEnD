/**
 * #1633 (design: the comment on #1633): what is new FOR AGENTS in this AgEnD version, told once to each instance that
 * was already running before it — a resumed session can keep tool descriptions it loaded under the old version (Claude
 * Code: a deferred tool's schema is a ToolSearch result in the transcript), so it would never learn the new parameters.
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

export interface WhatsNewEntry {
  /** Stable: the record keeps it. */
  readonly id: string;
  /** The first AgEnD version that has it. */
  readonly since: string;
  readonly text: string;
}

export const AGENT_WHATS_NEW: readonly WhatsNewEntry[] = [
  { id: "2.2-reply-buttons", since: "2.2.0-beta.1",
    text: "`reply` takes `buttons: [{label, value?}]` (1–10); a click comes back to you as a message `[button] <label>`, or `[button] <label> (value: <value>)` when the value differs. Buttons expire after 24 h." },
  { id: "2.2-reply-stickers", since: "2.2.0-beta.1",
    text: "`reply` takes `stickers` (up to 3 ids from `list_stickers`; look at them first with `preview_stickers`). Not together with buttons." },
  { id: "2.2-web-chat", since: "2.2.0-beta.1",
    text: "Web chat: people can write to you from the dashboard. Their messages arrive as `[user:… via web, …]` — answer with `reply` as usual; their files show as `[📷 Image: PATH]` / `[📎 File: NAME → PATH]`. Attach a `.html` file and the web chat previews it." },
  { id: "2.2-delivery-status", since: "2.2.0-beta.1",
    text: "`delivery_status` takes a `message_id` from an inbound header (\"Delivery not found\" = never delivered) and shows `consumed_at` / `consumed_via`. Never resend on `uncertain`." },
  { id: "2.2-task-list", since: "2.2.0-beta.1",
    text: "`task` `list` returns live tasks only by default: `filter_status` (one or a list) for done or cancelled, `verbose: true` for full records." },
  { id: "2.2-create-refusals", since: "2.2.0-beta.1",
    text: "`create_instance` refuses `tool_set` and `skipPermissions`; `update_instance_config` refuses `tool_set` and ignores `skipPermissions` (both are set in Settings or fleet.yaml)." },
];

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

export function whatsNewNotice(version: string, entries: readonly WhatsNewEntry[]): string {
  return [
    `[system:whats-new] AgEnD is now ${version}. New for you since your session began:`,
    ...entries.map(e => `- ${e.text}`),
    "If a tool's description you loaded earlier doesn't show these, reload it before using them (Claude Code: `ToolSearch` with `select:<tool>`). Do not reply to this message.",
  ].join("\n");
}

/**
 * What this instance should be told now. `fresh`: it never launched before (told nothing; everything current recorded
 * as known). Returns the notice and the ids it covers, `{ silent: ids }` when they are only to be recorded, or null.
 */
export function planWhatsNew(input: { record: WhatsNewRecord | null | "unreadable"; fresh: boolean; version: string | null; entries?: readonly WhatsNewEntry[] }):
  | { notice: string; ids: string[]; version: string }
  | { silent: string[]; version: string }
  | null {
  const { record, fresh, version } = input;
  if (!version || record === "unreadable") return null;
  const current = (input.entries ?? AGENT_WHATS_NEW).filter(e => { const c = compareVersions(e.since, version); return c !== null && c <= 0; });
  const known = new Set(record?.announced ?? []);
  const unseen = current.filter(e => !known.has(e.id));
  if (!unseen.length) return null;
  if (fresh && !record) return { silent: unseen.map(e => e.id), version };
  return { notice: whatsNewNotice(version, unseen), ids: unseen.map(e => e.id), version };
}
