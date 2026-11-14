/** Owner-scoped feedback, never a lookup proxy to the configured-admin boundary or a grant permit. */
import { z } from "zod";
import type { HubCore } from "./http/core.js";
import type { HubRequestContext } from "./types.js";
import { HubProtocolError, person, uuid, epoch, validated } from "./validation.js";
import { personKeyString } from "./identity.js";
import { exposureOf, readExposure } from "./catalog.js";

const text = z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f]+$/);
const input = z.strictObject({ exposureRevision: epoch, kind: z.enum(["person", "group", "team"]), q: text.max(64).min(2).refine(s => s === s.trim()) });
const group = z.strictObject({ objectId: uuid, cn: text.max(256), dn: text });
const candidate = z.strictObject({ person, login: text.max(256), displayName: text.max(256) });
export class HubGrantSearch {
  private readonly buckets = new Map<string, { at: number; count: number }>();
  constructor(private readonly core: HubCore) {}
  async search(ctx: HubRequestContext, exposureId: string, raw: unknown) {
    const query = validated(input, raw), id = validated(uuid, exposureId), who = await ctx.requirePerson(), actor = await ctx.current(), me = personKeyString(who);
    if (actor.kind !== "directory" || personKeyString(actor.person) !== me) throw new HubProtocolError("denied");
    const session = actor.sessionId, context = this.core.groupContext(ctx), directory = this.core.deps.directory;
    const owned = () => this.core.atomic(db => {
      if (!context.current()) throw new HubProtocolError("revoked");
      const row = readExposure(db, id); if (!row || row.owner !== me) throw new HubProtocolError("not-found");
      if (row.revision !== query.exposureRevision) throw new HubProtocolError("conflict");
      const e = exposureOf(row); if (e.state !== "published") throw new HubProtocolError("denied"); return JSON.stringify(e);
    });
    const image = owned(), at = this.core.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new HubProtocolError("unavailable");
    for (const [key, b] of this.buckets) if (at < b.at || at - b.at >= 60_000) this.buckets.delete(key);
    const key = JSON.stringify([me, session]), bucket = this.buckets.get(key);
    if (bucket ? bucket.count >= 30 : this.buckets.size >= 1024) return { ok: false as const, reason: "limited" as const };
    this.buckets.set(key, { at: bucket?.at ?? at, count: (bucket?.count ?? 0) + 1 });
    if (query.kind === "team") {
      const candidates = this.core.deps.roomTeamCandidates;
      if (!candidates) return { ok: false as const, reason: "unsupported" as const };
      const teams = this.core.atomic(db => validated(z.array(z.strictObject({ id: uuid, name: text.max(256), people: z.number().int().min(1).max(200) })).max(20), candidates(db, query.q)));
      const fresh = await ctx.current();
      if (fresh.kind !== "directory" || fresh.sessionId !== session || personKeyString(fresh.person) !== me) throw new HubProtocolError("denied");
      if (!context.current() || owned() !== image || this.core.deps.roomTeamCandidates !== candidates) throw new HubProtocolError("unavailable");
      return { ok: true, teams, truncated: teams.length === 20 };
    }
    const groupLookup = directory.searchPolicyGroups, personLookup = directory.searchGrantPeople;
    const lookup = query.kind === "group" ? groupLookup : personLookup;
    if (!lookup || (query.kind === "group" && directory.groupPolicy !== "ad-direct-guid")) return { ok: false as const, reason: "unsupported" as const };
    const assert = () => {
      if (this.core.deps.directory !== directory || owned() !== image || !context.current()
        || lookup !== (query.kind === "group" ? directory.searchPolicyGroups : directory.searchGrantPeople)) throw new HubProtocolError("unavailable");
    };
    assert();
    let outcome: unknown, failure: unknown, permit: { assertCurrent(): void } | undefined;
    try {
      const read = await this.core.grantDirectoryRead(who, context, async () => query.kind === "group"
        ? await groupLookup!.call(directory, query.q) : await personLookup!.call(directory, query.q)); permit = read.permit;
      const result = read.value;
      if (!result.ok) outcome = { ok: false, reason: "unknown" };
      else if (query.kind === "group" && "groups" in result) {
        const groups = validated(z.array(group).max(20), result.groups);
        if (typeof result.truncated !== "boolean" || new Set(groups.map(g => g.objectId)).size !== groups.length) throw new HubProtocolError("unavailable");
        outcome = { ok: true, groups, truncated: result.truncated };
      } else if (query.kind === "person" && "people" in result) {
        const people = validated(z.array(candidate).max(20), result.people);
        if (typeof result.truncated !== "boolean" || people.some(p => p.person.realm !== directory.realm)
          || new Set(people.map(p => personKeyString(p.person))).size !== people.length) throw new HubProtocolError("unavailable");
        outcome = { ok: true, people, truncated: result.truncated };
      } else throw new HubProtocolError("unavailable");
    } catch (e) { failure = e; }
    const fresh = await ctx.current();
    if (fresh.kind !== "directory" || fresh.sessionId !== session || personKeyString(fresh.person) !== me) throw new HubProtocolError("denied");
    assert(); permit?.assertCurrent(); if (failure) throw failure;
    return outcome;
  }
  close() { this.buckets.clear(); }
}
