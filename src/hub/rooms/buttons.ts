/**
 * M-3127 B: an agent answer's buttons or poll in a group room (docs/design/hub-rooms-reactions-polls-search.md §B).
 * Pure SQL helpers on the caller's transaction — HubGroupRooms owns the orchestration (click → the asker's post,
 * close → a room line + the results delivered to the agent). A button is data, never an approval.
 */
import type Database from "better-sqlite3";
import { REPLY_BUTTON_TTL_MS } from "../../reply-buttons.js";
import { pollCounts } from "../../reply-polls.js";
import type { HubAnswerButtons, HubTx } from "../types.js";
import type { HubContentStore } from "../http/deps.js";

type DB = Database.Database;
export interface RoomButtonsRow {
  id: string; post_id: string; room_id: string; delivery_id: string; asker_member: string; content_ref: string;
  created_at: number; expires_at: number; state: "open" | "chosen" | "closed" | "expired"; revision: number;
  chosen_index: number | null; chosen_member: string | null; closed_at: number | null; result_post: string | null;
}
export interface RoomVote { member_id: string; options: number[]; at: number }
/**
 * What a room message carries (the Fleet thread's shape, `ReplyButtonsView`, plus who may answer): `asker` names the one
 * member who may press plain buttons; a poll is open to every person in the room who can see it.
 */
export interface RoomButtonsView {
  id: string; labels: string[]; state: "open" | "chosen" | "closed" | "expired"; chosen?: number; by?: string; asker: { id: string; name: string };
  poll?: { deadline: number; answered: number; multi: boolean; reveal: "close" | "live"; rev: number; counts?: number[]; voters?: string[][] };
}

export class RoomButtons {
  constructor(private readonly content: HubContentStore, private readonly now: () => number) {}
  /** At the answer's disclosure, in its transaction: the set opens (a poll for its seconds, buttons for a day). */
  /**
   * Returns the choices' content ref (the caller audits it: the content store reads only what an audit record binds), or
   * null when that set id (the Fleet's) is already taken — the answer then carries no buttons, and nothing is stored or
   * audited for it (Fable #3931 P3: never an "opened" audit for a set that was not opened).
   */
  record(db: DB, tx: HubTx, d: { id: string; room_id: string; reply_id: string; asker_member: string }, b: HubAnswerButtons): string | null {
    if (db.prepare("SELECT 1 FROM hub_room_buttons WHERE id=? OR post_id=?").get(b.id, d.reply_id)) return null;
    const now = this.now(), ref = this.content.put(tx, { buttons: b });
    db.prepare(`INSERT INTO hub_room_buttons(id,post_id,room_id,delivery_id,asker_member,content_ref,created_at,expires_at,state)
      VALUES(?,?,?,?,?,?,?,?,'open')`).run(b.id, d.reply_id, d.room_id, d.id, d.asker_member, ref, now, now + (b.poll ? b.poll.seconds * 1000 : REPLY_BUTTON_TTL_MS));
    return ref;
  }
  row(db: DB, setId: string): RoomButtonsRow | undefined { return db.prepare("SELECT * FROM hub_room_buttons WHERE id=?").get(setId) as RoomButtonsRow | undefined; }
  forPost(db: DB, postId: string): RoomButtonsRow | undefined { return db.prepare("SELECT * FROM hub_room_buttons WHERE post_id=?").get(postId) as RoomButtonsRow | undefined; }
  /** The choices, from the content store; undefined once retention removed them (the set is then inert). */
  choices(row: RoomButtonsRow): HubAnswerButtons | undefined { return this.content.get(row.content_ref)?.buttons; }
  votes(db: DB, setId: string): RoomVote[] {
    return (db.prepare("SELECT member_id,options,at FROM hub_room_votes WHERE set_id=? ORDER BY at,member_id").all(setId) as { member_id: string; options: string; at: number }[])
      .map(v => ({ member_id: v.member_id, options: JSON.parse(v.options) as number[], at: v.at })).filter(v => v.options.length > 0);
  }
  /** Sets whose deadline came and are still open, oldest first. */
  due(db: DB, limit = 32): RoomButtonsRow[] {
    return db.prepare("SELECT * FROM hub_room_buttons WHERE state='open' AND expires_at<=? ORDER BY expires_at,id LIMIT ?").all(this.now(), limit) as RoomButtonsRow[];
  }
  nextDeadline(db: DB): number | null { return (db.prepare("SELECT MIN(expires_at) AS t FROM hub_room_buttons WHERE state='open'").get() as { t: number | null }).t; }
  /**
   * A message's view for every viewer alike (the page keeps its own vote, as in direct chats). Counts when revealed (live,
   * or closed); voters' names only when closed with showVoters. `name(memberId)`: a member's display name.
   */
  view(db: DB, postId: string, name: (memberId: string) => string): RoomButtonsView | undefined {
    const row = this.forPost(db, postId); if (!row) return undefined;
    const b = this.choices(row); if (!b) return undefined;
    const asker = { id: row.asker_member, name: name(row.asker_member) };
    const expired = row.state === "open" && this.now() >= row.expires_at;
    if (!b.poll) return { id: b.id, labels: [...b.labels], state: expired ? "expired" : row.state, asker,
      ...(row.chosen_index !== null ? { chosen: row.chosen_index, by: name(row.chosen_member ?? row.asker_member) } : {}) };
    const closed = row.state !== "open" || expired, votes = this.votes(db, row.id);
    const ballots = votes.map(v => ({ voter: v.member_id, name: "", options: v.options, at: v.at }));
    return { id: b.id, labels: [...b.labels], state: closed ? "closed" : "open", asker, poll: {
      deadline: row.expires_at, answered: votes.length, multi: b.poll.multi, reveal: b.poll.reveal, rev: row.revision,
      ...(closed || b.poll.reveal === "live" ? { counts: pollCounts(b.labels.length, ballots) } : {}),
      ...(closed && b.poll.showVoters ? { voters: b.labels.map((_, i) => votes.filter(v => v.options.includes(i)).map(v => name(v.member_id))) } : {}),
    } };
  }
}
