/** Room creator policy and metadata-only administration; no role-model activation. */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { personKeyString } from "../identity.js";
import { personFromString, type HubCore } from "../http/core.js";
import type { HubRequestContext } from "../types.js";
import { HubProtocolError, validated } from "../validation.js";
import type { RoomEvent } from "./types.js";

type DB = Database.Database;
const personId = z.string().max(128).regex(/^[a-z][a-z0-9_-]{0,63}\/[a-f0-9-]{36}$/);
const policy = z.strictObject({ people: z.array(personId).max(200), teams: z.array(z.string().uuid()).max(0) });
export function canCreateRoom(core: HubCore, db: DB, person: string): boolean {
  return person === personKeyString(core.deps.config.administrator) || !!db.prepare("SELECT 1 FROM hub_room_creators WHERE kind='person' AND subject=?").get(person);
}
export class HubRoomAdmin {
  constructor(private readonly core: HubCore, private readonly publish: (event: RoomEvent) => void, private readonly archived: (id: string) => void) {}
  private readPolicy(db: DB) {
    const rows = db.prepare("SELECT kind,subject FROM hub_room_creators ORDER BY kind,subject").all() as { kind: "person" | "team"; subject: string }[];
    return { people: rows.filter(r => r.kind === "person").map(r => r.subject), teams: rows.filter(r => r.kind === "team").map(r => r.subject) };
  }
  async creators(ctx: HubRequestContext, input?: unknown) {
    const permit = await this.core.management(ctx, "hub.admin");
    if (input === undefined) return this.core.atomic(db => this.readPolicy(db), { assertCurrent: () => permit.assertCurrent() });
    const body = validated(policy, input);
    for (const person of body.people) if (!await this.core.eligible(personFromString(person))) throw new HubProtocolError("invalid");
    return this.core.atomic((db, tx) => {
      db.prepare("DELETE FROM hub_room_creators").run();
      for (const person of new Set(body.people)) db.prepare("INSERT INTO hub_room_creators(kind,subject) VALUES('person',?)").run(person);
      this.core.audit(tx, { requestId: ctx.requestId, actor: permit.actor.kind === "directory" ? { kind: "person", person: permit.actor.person } : { kind: "local-host" }, action: "room.creators", result: "completed" });
      return this.readPolicy(db);
    }, { assertCurrent: () => permit.assertCurrent() });
  }
  async list(ctx: HubRequestContext) {
    const permit = await this.core.management(ctx, "hub.admin");
    return this.core.atomic(db => ({ rooms: (db.prepare(`SELECT r.id,r.name,r.created_at,r.archived,
      (SELECT COUNT(*) FROM hub_room_members m WHERE m.room_id=r.id AND m.kind='person') people,
      (SELECT COUNT(*) FROM hub_room_members m WHERE m.room_id=r.id AND m.kind='agent') agents,
      COALESCE((SELECT MAX(p.created_at) FROM hub_room_posts p WHERE p.room_id=r.id),r.created_at) lastAt
      FROM hub_group_rooms r ORDER BY lastAt DESC,r.id`).all() as { id: string; name: string; archived: number; people: number; agents: number; lastAt: number }[]).map(r => ({
        id: r.id, name: r.name, people: r.people, agents: r.agents, managers: (db.prepare(`SELECT COALESCE(p.display_name,m.subject) name FROM hub_room_members m
          LEFT JOIN hub_people p ON p.person=m.subject WHERE m.room_id=? AND m.kind='person' AND m.role='manager' ORDER BY name,m.id`).all(r.id) as { name: string }[]).map(x => x.name),
        lastAt: r.lastAt, archived: r.archived === 1,
      })) }), permit);
  }
  async join(ctx: HubRequestContext, id: string) {
    const permit = await this.core.management(ctx, "hub.admin"), person = await ctx.requirePerson(), me = personKeyString(person);
    this.core.atomic((db, tx) => {
      const room = db.prepare("SELECT history_for_new FROM hub_group_rooms WHERE id=?").get(id) as { history_for_new: string } | undefined;
      if (!room) throw new HubProtocolError("not-found");
      const old = db.prepare("SELECT id,role FROM hub_room_members WHERE room_id=? AND kind='person' AND subject=?").get(id, me) as { id: string; role: string } | undefined;
      if (old?.role === "manager") return;
      const sequence = (db.prepare("SELECT COALESCE(MAX(sequence),0)+1 n FROM hub_room_posts WHERE room_id=?").get(id) as { n: number }).n;
      if (old) db.prepare("UPDATE hub_room_members SET role='manager' WHERE id=?").run(old.id);
      else db.prepare("INSERT INTO hub_room_members(id,room_id,kind,subject,role,joined_sequence) VALUES(?,?,'person',?,'manager',?)").run(randomUUID(), id, me, room.history_for_new === "all" ? 0 : sequence);
      const name = (db.prepare("SELECT display_name FROM hub_people WHERE person=?").get(me) as { display_name: string } | undefined)?.display_name ?? me;
      db.prepare(`INSERT INTO hub_room_posts(id,room_id,sequence,author_kind,author_id,author_subject,author_name,content_ref,digest,mentions,created_at)
        VALUES(?,?,?,'system','system','system','',?,'','[]',?)`).run(randomUUID(), id, sequence,
          this.core.deps.content.put(tx, { question: `${name} joined as a room manager.` }), this.core.now());
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person }, action: "room.admin-joined", result: "completed", roomId: id });
    }, { assertCurrent: () => { permit.assertCurrent(); if (ctx.isCurrent?.() !== true) throw new HubProtocolError("revoked"); } });
    this.publish({ type: "room.changed", roomId: id, data: { roomId: id } }); this.publish({ type: "member.changed", roomId: id, data: { roomId: id } }); return { ok: true };
  }
  async archive(ctx: HubRequestContext, id: string, input: unknown) {
    const permit = await this.core.management(ctx, "hub.admin"), body = validated(z.strictObject({ archived: z.boolean() }), input);
    this.core.atomic((db, tx) => {
      if (!db.prepare("SELECT 1 FROM hub_group_rooms WHERE id=?").get(id)) throw new HubProtocolError("not-found");
      db.prepare("UPDATE hub_group_rooms SET archived=? WHERE id=?").run(Number(body.archived), id);
      this.core.audit(tx, { requestId: ctx.requestId, actor: permit.actor.kind === "directory" ? { kind: "person", person: permit.actor.person } : { kind: "local-host" }, action: "room.admin-archived", result: "completed", roomId: id });
    }, { assertCurrent: () => permit.assertCurrent() });
    if (body.archived) this.archived(id);
    this.publish({ type: "room.changed", roomId: id, data: { roomId: id } }); return { ok: true };
  }
}
