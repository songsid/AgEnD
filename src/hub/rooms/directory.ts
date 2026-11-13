/** Bounded room-picker suggestions, not membership or creator authority. */
import type Database from "better-sqlite3";
import { z } from "zod";
import type { HubCore } from "../http/core.js";
import { personFromString } from "../http/core.js";
import { personKeyString } from "../identity.js";
import type { HubRequestContext } from "../types.js";
import type { GrantPersonSearch } from "../directory/types.js";
import type { PolicyGroupSearch } from "../directory/groups.js";
import { HubProtocolError, person, uuid, validated } from "../validation.js";
const text = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/);
const group = z.strictObject({ objectId: uuid, cn: text, dn: z.string().max(1024) });
const candidate = z.strictObject({ person, login: text, displayName: text });
export class RoomDirectoryCandidates {
  private buckets = new Map<string, { at: number; count: number }>();
  constructor(private readonly core: HubCore) {}
  async roster(ctx: HubRequestContext, me: string, id: string, allowed: () => void) {
    const actor = await ctx.current(), directory = this.core.deps.directory, lookup = directory.roomGroupMembers;
    if (actor.kind !== "directory" || personKeyString(actor.person) !== me) throw new HubProtocolError("denied");
    const key = validated(person, { realm: directory.realm, objectId: validated(uuid, id) });
    const assert = () => { allowed(); if (directory !== this.core.deps.directory || lookup !== directory.roomGroupMembers) throw new HubProtocolError("unavailable"); };
    assert(); if (!lookup) throw new HubProtocolError("unavailable");
    const value = await this.core.readDirectory(actor.person, this.core.groupContext(ctx), () => lookup.call(directory, key)); assert();
    if (!value.ok || personKeyString(value.group.key) !== personKeyString(key) || value.people.length > 4096) throw new HubProtocolError("unavailable");
    const seen = new Set<string>(), people = value.people.map(p => {
      const who = validated(person, p.key), id = personKeyString(who);
      if (who.realm !== key.realm || seen.has(id)) throw new HubProtocolError("unavailable"); seen.add(id);
      return { id, login: validated(text, p.login), displayName: validated(text, p.displayName ?? p.login) };
    });
    return { id, name: validated(text, value.group.name), people };
  }
  async search(ctx: HubRequestContext, me: string, q: string, kind: "person" | "group", allowed: () => void) {
    const actor = await ctx.current(), directory = this.core.deps.directory;
    if (actor.kind !== "directory" || personKeyString(actor.person) !== me) throw new HubProtocolError("denied");
    const people = directory.searchGrantPeople, groups = directory.searchPolicyGroups;
    if (kind === "person" && !people || kind === "group" && !groups) return [];
    const assert = () => {
      allowed();
      if (directory !== this.core.deps.directory || people !== directory.searchGrantPeople || groups !== directory.searchPolicyGroups) throw new HubProtocolError("unavailable");
    };
    assert(); const at = this.core.now(), key = actor.sessionId;
    for (const [id, b] of this.buckets) if (at < b.at || at - b.at >= 60_000) this.buckets.delete(id);
    const b = this.buckets.get(key);
    if (b ? b.count >= 30 : this.buckets.size >= 1024) throw new HubProtocolError("backpressure");
    this.buckets.set(key, { at: b?.at ?? at, count: (b?.count ?? 0) + 1 });
    let found;
    try { found = await this.core.readDirectory<GrantPersonSearch | PolicyGroupSearch>(actor.person, this.core.groupContext(ctx), () => kind === "person" ? people!.call(directory, q) : groups!.call(directory, q)); }
    catch (error) { assert(); if (error instanceof HubProtocolError) throw error; throw new HubProtocolError("unavailable"); }
    assert();
    if (!found.ok || typeof found.truncated !== "boolean") throw new HubProtocolError("unavailable");
    if (kind === "person" && "people" in found) {
      const rows = validated(z.array(candidate).max(20), found.people);
      if (rows.some(row => row.person.realm !== directory.realm) || new Set(rows.map(row => personKeyString(row.person))).size !== rows.length) throw new HubProtocolError("unavailable");
      return rows.map(row => ({ kind: "person" as const, id: personKeyString(row.person), name: row.displayName }));
    }
    if (kind === "group" && "groups" in found) {
      const rows = validated(z.array(group).max(20), found.groups);
      if (new Set(rows.map(row => row.objectId)).size !== rows.length) throw new HubProtocolError("unavailable");
      return rows.map(row => ({ kind: "group" as const, id: row.objectId, name: row.cn }));
    }
    throw new HubProtocolError("unavailable");
  }
  close() { this.buckets.clear(); }
}
export interface RoomPersonSelection { id: string; login: string; displayName?: string }
/** Directory names recorded only with the final room write; this creates no session or independent permission. */
export function rememberRoomPeople(db: Database.Database, people: readonly RoomPersonSelection[], at: number): void {
  for (const selected of people) {
    const key = validated(person, personFromString(selected.id)), login = validated(text, selected.login);
    const previous = db.prepare("SELECT display_name FROM hub_people WHERE person=? UNION ALL SELECT display_name FROM hub_room_people WHERE person=? LIMIT 1").get(selected.id, selected.id) as { display_name: string } | undefined;
    const name = validated(text, selected.displayName ?? previous?.display_name ?? login);
    db.prepare(`INSERT INTO hub_room_people(person,display_name,login_label,observed_at) VALUES(?,?,?,?)
      ON CONFLICT(person) DO UPDATE SET display_name=excluded.display_name,login_label=excluded.login_label,observed_at=excluded.observed_at`)
      .run(personKeyString(key), name, login, at);
  }
}
