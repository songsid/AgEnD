/**
 * #3647: the episodes the dispatcher has been told about (dispatcher-liveness.ts) — one open row per claimed card at most,
 * kept in the scheduler database beside the board so a fleet restart neither repeats a notice nor forgets one it must
 * take back. A row is the episode: what stopped (`kind`), since when, who was told and with which notice.
 */
import type Database from "better-sqlite3";
import type { StopKind } from "../dispatcher-liveness.js";

export interface LivenessEpisode {
  cardUuid: string;
  assignee: string;
  /** The dispatcher's name (an instance, or the person's label). */
  dispatcher: string;
  dispatcherKind: "instance" | "person";
  kind: StopKind;
  since: number;
  detail: string;
  /** The notice that told it (delivery outbox key), or null (a person's — Needs you —, or not taken). */
  noticeKey: string | null;
  notifiedAt: number;
  /** The dispatcher is an agent that was not running when it was told: the person sees it in Needs you too. */
  needsYou?: boolean;
}

export class LivenessLedger {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS task_liveness (
      card_uuid TEXT PRIMARY KEY,
      assignee TEXT NOT NULL,
      dispatcher TEXT NOT NULL,
      dispatcher_kind TEXT NOT NULL,
      kind TEXT NOT NULL,
      since INTEGER NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      notice TEXT,
      notified_at INTEGER NOT NULL,
      needs_you INTEGER NOT NULL DEFAULT 0
    )`);
    // A table made by an earlier build of this feature lacks the later column: add it (the rows keep their episodes).
    const cols = new Set((db.prepare("PRAGMA table_info(task_liveness)").all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has("needs_you")) db.exec("ALTER TABLE task_liveness ADD COLUMN needs_you INTEGER NOT NULL DEFAULT 0");
  }

  private static row(r: Record<string, unknown>): LivenessEpisode {
    return { cardUuid: String(r.card_uuid), assignee: String(r.assignee), dispatcher: String(r.dispatcher),
      dispatcherKind: r.dispatcher_kind === "person" ? "person" : "instance", kind: String(r.kind) as StopKind,
      since: Number(r.since), detail: String(r.detail ?? ""), noticeKey: r.notice == null ? null : String(r.notice), notifiedAt: Number(r.notified_at),
      needsYou: Number(r.needs_you) === 1 };
  }

  get(cardUuid: string): LivenessEpisode | null {
    const r = this.db.prepare("SELECT * FROM task_liveness WHERE card_uuid=?").get(cardUuid) as Record<string, unknown> | undefined;
    return r ? LivenessLedger.row(r) : null;
  }

  listOpen(): LivenessEpisode[] {
    return (this.db.prepare("SELECT * FROM task_liveness ORDER BY since").all() as Array<Record<string, unknown>>).map(LivenessLedger.row);
  }

  /** Open (or replace) the card's episode. */
  open(e: LivenessEpisode): void {
    this.db.prepare(`INSERT INTO task_liveness (card_uuid,assignee,dispatcher,dispatcher_kind,kind,since,detail,notice,notified_at,needs_you)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(card_uuid) DO UPDATE SET assignee=excluded.assignee, dispatcher=excluded.dispatcher,
      dispatcher_kind=excluded.dispatcher_kind, kind=excluded.kind, since=excluded.since, detail=excluded.detail,
      notice=excluded.notice, notified_at=excluded.notified_at, needs_you=excluded.needs_you`)
      .run(e.cardUuid, e.assignee, e.dispatcher, e.dispatcherKind, e.kind, e.since, e.detail, e.noticeKey, e.notifiedAt, e.needsYou ? 1 : 0);
  }

  close(cardUuid: string): void { this.db.prepare("DELETE FROM task_liveness WHERE card_uuid=?").run(cardUuid); }

  /** How many open episodes were told by this notice (one notice may tell several cards). */
  openWithKey(key: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM task_liveness WHERE notice=?").get(key) as { n: number }).n;
  }
}
