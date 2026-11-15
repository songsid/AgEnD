/** Hub virtual teams: selected rosters, live subjects and snapshot expansion. No routes mount on import. */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { HubCore } from "../http/core.js";
import { personFromString } from "../http/core.js";
import { personKeyString } from "../identity.js";
import type { HubRequestContext, PersonKey } from "../types.js";
import type { GrantPersonSearch } from "../directory/types.js";
import type { PolicyGroupSearch } from "../directory/groups.js";
import { HubProtocolError, person, plain, uuid, validated } from "../validation.js";
import type { HubTeams, HubTeamView, TeamCreationSettings } from "./types.js";
import { hubTeamReader, hubTeamCandidates, readTeamRow, teamMembers, teamLeads, writeTeamLeads, type TeamMemberRow, type TeamRow } from "./store.js";
export { HUB_TEAM_MANAGEMENT_MIGRATION, HUB_TEAMS_MIGRATION, hubTeamReader, hubTeamCandidates } from "./store.js";
export { HUB_TEAM_GRANTS_MIGRATION } from "./grant-schema.js";
export type { HubTeams, HubTeamView, TeamCreationSettings, HubTeamReader } from "./types.js";

export const TEAM_LIMIT = 200, TEAM_MEMBER_LIMIT = 200;
const personId = z.string().refine(id => person.safeParse(personFromString(id)).success);
const name = plain(256).trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/);
const leadsInput = z.array(personId).min(1).max(5).refine(ids => new Set(ids).size === ids.length);
const createInput = z.strictObject({ name, department: uuid.nullable().optional(), lead: personId.optional(), leads: leadsInput.optional(),
  members: z.array(personId).max(TEAM_MEMBER_LIMIT).default([]) }).refine(v => !(v.lead && v.leads));
const updateInput = z.strictObject({ name: name.optional(), department: uuid.nullable().optional(), lead: personId.optional(), leads: leadsInput.optional(),
  members: z.array(personId).max(TEAM_MEMBER_LIMIT).optional(), revision: z.number().int().min(1).optional() })
  .refine(v => Object.keys(v).some(key => key !== "revision") && !(v.lead && v.leads));
const creatorsInput = z.strictObject({ revision: z.number().int().min(1), creators: z.array(z.discriminatedUnion("kind", [
  z.strictObject({kind:z.literal("person"),id:personId}), z.strictObject({kind:z.literal("group"),id:uuid}),
])).max(100).refine(rows => new Set(rows.map(r => r.kind+":"+r.id)).size === rows.length) });
const feedbackText = plain(1024).max(256).regex(/^[^\u0000-\u001f\u007f]*$/);
const suggestionInput = z.strictObject({ kind: z.enum(["person", "group"]), teamId: uuid.optional(),
  q: plain(256).min(2).max(64).regex(/^[^\u0000-\u001f\u007f]+$/).refine(value => value === value.trim()) });
const suggestedPerson = z.strictObject({ person, login: feedbackText.min(1), displayName: feedbackText });
const suggestedGroup = z.strictObject({ objectId: uuid, cn: feedbackText.min(1), dn: plain(4096).min(1).max(1024) });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Actor = { person: PersonKey; id: string; admin: boolean };
type DB = Database.Database;

export interface HubTeamUsage { readonly allowedListUsesTeam?: (db: DB, teamId: string) => boolean }
export function createHubTeams(core: HubCore, usage: HubTeamUsage = {}): HubTeams { return new Teams(core,usage); }

class Teams implements HubTeams {
  private readonly feedbackBuckets = new Map<string, { at: number; count: number }>();
  constructor(private readonly core: HubCore, private readonly usage: HubTeamUsage) {}
  readonly read = hubTeamReader.read;
  readonly expand = hubTeamReader.expand;
  readonly isMember = hubTeamReader.isMember;
  readonly candidates = hubTeamCandidates;
  private fence(ctx: HubRequestContext) { return { assertCurrent: () => {
    this.core.check(); if (ctx.isCurrent?.() !== true) throw new HubProtocolError("revoked");
  } }; }
  private async who(ctx: HubRequestContext): Promise<Actor> {
    const key = await ctx.requirePerson(); let admin = false;
    try { await ctx.requireAdmin(); admin = true; }
    catch (error) { if (!(error instanceof HubProtocolError) || error.code !== "denied") throw error; }
    this.fence(ctx).assertCurrent(); return { person: key, id: personKeyString(key), admin };
  }
  private required(db: DB, id: string): TeamRow {
    const row = readTeamRow(db, validated(uuid, id)); if (!row) throw new HubProtocolError("not-found"); return row;
  }
  private snapshot(db: DB, id: string) { return { row: this.required(db, id), members: teamMembers(db, id), leads: teamLeads(db,id) }; }
  private checkImage(db: DB, image: ReturnType<Teams["snapshot"]>): void {
    if (!same(this.snapshot(db, image.row.id), image)) throw new HubProtocolError("conflict");
  }
  async suggestions(ctx: HubRequestContext, input: unknown) {
    const query = validated(suggestionInput, input), actor = await this.who(ctx);
    const image = query.teamId ? this.core.atomic(db => this.snapshot(db, query.teamId!)) : null;
    const permit = !actor.admin && !image ? await this.creationPermit(ctx,actor) : null;
    if (!actor.admin && (image ? !image.leads.includes(actor.id) : !permit?.allowed)) throw new HubProtocolError("denied");
    const session = await ctx.current();
    if (session.kind !== "directory" || personKeyString(session.person) !== actor.id) throw new HubProtocolError("denied");
    const at = this.core.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new HubProtocolError("unavailable");
    for (const [key, bucket] of this.feedbackBuckets) if (at < bucket.at || at - bucket.at >= 60_000) this.feedbackBuckets.delete(key);
    const key = JSON.stringify([actor.id, session.sessionId]), bucket = this.feedbackBuckets.get(key);
    if (bucket ? bucket.count >= 30 : this.feedbackBuckets.size >= 1024) throw new HubProtocolError("backpressure");
    this.feedbackBuckets.set(key, { at: bucket?.at ?? at, count: (bucket?.count ?? 0) + 1 });
    const directory = this.core.deps.directory, realm = directory.realm;
    const groups = directory.searchPolicyGroups, people = directory.searchGrantPeople;
    const lookup = query.kind === "group" ? groups : people;
    if (!lookup || (query.kind === "group" && directory.groupPolicy !== "ad-direct-guid")) throw new HubProtocolError("unavailable");
    const assertCurrent = () => {
      this.fence(ctx).assertCurrent(); permit?.assertCurrent();
      if (this.core.deps.directory !== directory || directory.realm !== realm
        || lookup !== (query.kind === "group" ? directory.searchPolicyGroups : directory.searchGrantPeople)
        || (query.kind === "group" && directory.groupPolicy !== "ad-direct-guid")) throw new HubProtocolError("unavailable");
      if (image) this.core.atomic(db => this.checkImage(db, image));
    };
    let outcome: { kind: "person" | "group"; id: string; name: string; login?: string }[] = [], failure: unknown;
    try {
      const result = await this.core.readDirectory<GrantPersonSearch | PolicyGroupSearch>(actor.person, this.core.groupContext(ctx), () => query.kind === "group"
        ? groups!.call(directory, query.q) : people!.call(directory, query.q));
      if (!result.ok || typeof result.truncated !== "boolean") throw new HubProtocolError("unavailable");
      if (query.kind === "group" && "groups" in result) {
        outcome = validated(z.array(suggestedGroup).max(20), result.groups).map(row => ({ kind: "group", id: row.objectId, name: row.cn }));
      } else if (query.kind === "person" && "people" in result) {
        const found = validated(z.array(suggestedPerson).max(20), result.people);
        if (found.some(row => row.person.realm !== realm)) throw new HubProtocolError("unavailable");
        outcome = found.map(row => ({ kind: "person", id: personKeyString(row.person), name: row.displayName || row.login, login: row.login }));
      } else throw new HubProtocolError("unavailable");
      if (new Set(outcome.map(row => row.id)).size !== outcome.length) throw new HubProtocolError("unavailable");
    } catch (error) { failure = error instanceof HubProtocolError && error.code !== "invalid" ? error : new HubProtocolError("unavailable"); }
    const fresh = await ctx.current();
    if (fresh.kind !== "directory" || fresh.sessionId !== session.sessionId || personKeyString(fresh.person) !== actor.id) throw new HubProtocolError("denied");
    if (actor.admin) await ctx.requireAdmin();
    assertCurrent();
    if (failure) throw failure instanceof HubProtocolError ? failure : new HubProtocolError("unavailable");
    return outcome;
  }
  private policy(db: DB) { return db.prepare("SELECT revision,creators FROM hub_team_creation_policy WHERE id=1").get() as {revision:number;creators:string}; }
  private async creationPermit(ctx: HubRequestContext, actor: Actor) {
    const image = this.core.atomic(db => this.policy(db)), creators = JSON.parse(image.creators) as TeamCreationSettings["creators"];
    let allowed = actor.admin || creators.some(row => row.kind === "person" && row.id === actor.id);
    const directory = this.core.deps.directory, method = directory.readPolicyGroups;
    if (!allowed && creators.some(row => row.kind === "group") && method && directory.groupPolicy === "ad-direct-guid") {
      const facts = await this.core.readDirectory(actor.person, this.core.groupContext(ctx), () => method.call(directory,actor.person));
      allowed = facts.kind === "complete" && personKeyString(facts.person) === actor.id && creators.some(row => row.kind === "group" && facts.groups.includes(row.id));
    }
    return {allowed, image, assertCurrent: () => {
      this.fence(ctx).assertCurrent();
      if (this.core.deps.directory !== directory || directory.readPolicyGroups !== method || !same(this.core.atomic(db => this.policy(db)),image)) throw new HubProtocolError("conflict");
    }};
  }
  async settings(ctx: HubRequestContext): Promise<TeamCreationSettings> {
    const actor = await this.who(ctx), permit = await this.creationPermit(ctx,actor); permit.assertCurrent();
    return {revision:permit.image.revision, creators:actor.admin ? JSON.parse(permit.image.creators) : [], canCreate:permit.allowed, canConfigure:actor.admin};
  }
  async saveSettings(ctx: HubRequestContext, input: unknown): Promise<TeamCreationSettings> {
    const body = validated(creatorsInput,input), actor = await this.who(ctx); if (!actor.admin) throw new HubProtocolError("denied");
    const image = this.core.atomic(db => this.policy(db)); if (image.revision !== body.revision) throw new HubProtocolError("conflict");
    const selected = await this.selectedPeople(ctx,actor,body.creators.filter(row => row.kind === "person").map(row => row.id));
    const groups = new Map<string, Awaited<ReturnType<Teams["department"]>>>();
    for (const row of body.creators) if (row.kind === "group") groups.set(row.id,await this.department(ctx,actor,row.id));
    await ctx.requireAdmin();
    const creators = body.creators.map(row => ({...row,name:row.kind === "person" ? selected.rows.find(p => p.person === row.id)!.display_name : groups.get(row.id)!.name}));
    this.core.atomic((db,tx) => {
      selected.assertCurrent(); for (const group of groups.values()) group.assertCurrent();
      if (!same(this.policy(db),image)) throw new HubProtocolError("conflict");
      db.prepare("UPDATE hub_team_creation_policy SET revision=revision+1,creators=? WHERE id=1").run(JSON.stringify(creators));
      this.core.audit(tx,{requestId:ctx.requestId,actor:{kind:"person",person:actor.person},action:"team.creation-policy-updated",result:"completed"});
    },this.fence(ctx));
    return this.settings(ctx);
  }
  private roster(input: readonly string[], leads: readonly string[]): string[] {
    const members = [...new Set([...input,...leads])].sort();
    if (members.length > TEAM_MEMBER_LIMIT) throw new HubProtocolError("invalid"); return members;
  }
  private async selectedPeople(ctx: HubRequestContext, actor: Actor, ids: readonly string[]) {
    const directory = this.core.deps.directory, method = directory.checkEligibility;
    const rows: TeamMemberRow[] = [];
    for (const id of ids) {
      const key = validated(person, personFromString(id));
      if (key.realm !== directory.realm) throw new HubProtocolError("invalid");
      const result = await this.core.readDirectory(actor.person, this.core.groupContext(ctx), () => method.call(directory, key));
      if (!result.eligible) throw new HubProtocolError(result.reason === "unavailable" ? "unavailable" : "not-found");
      if (personKeyString(result.person.key) !== id) throw new HubProtocolError("conflict");
      rows.push({ team_id: "", person: id, display_name: (result.person.displayName || result.person.login).slice(0, 256),
        login_label: result.person.login.slice(0, 256), department: (result.person.department || "").slice(0, 256) });
    }
    return { rows, assertCurrent: () => {
      this.fence(ctx).assertCurrent();
      if (this.core.deps.directory !== directory || directory.checkEligibility !== method) throw new HubProtocolError("unavailable");
    } };
  }
  private async department(ctx: HubRequestContext, actor: Actor, id: string) {
    const directory = this.core.deps.directory, lookup = directory.checkPolicyGroup;
    if (!lookup) throw new HubProtocolError("unavailable");
    const key = { realm: directory.realm, objectId: id };
    const result = await this.core.readDirectory(actor.person, this.core.groupContext(ctx), () => lookup.call(directory, key));
    if (!result.ok) throw new HubProtocolError(result.reason === "unknown" ? "unavailable" : "not-found");
    if (personKeyString(result.group.key) !== personKeyString(key)) throw new HubProtocolError("conflict");
    // The DN is not an identity. Only its display value is retained, never used for membership.
    const label = /^CN=([^,]+)/i.exec(result.group.dn)?.[1] || result.group.dn;
    return { realm: directory.realm, name: label.slice(0, 256), assertCurrent: () => {
      this.fence(ctx).assertCurrent();
      if (this.core.deps.directory !== directory || directory.checkPolicyGroup !== lookup) throw new HubProtocolError("unavailable");
    } };
  }
  private view(db: DB, row: TeamRow, actor: Actor, details = false, leadEligible: boolean | null = null): HubTeamView {
    const members = teamMembers(db, row.id), leads = teamLeads(db,row.id), lead = members.find(member => member.person === row.lead);
    const isLead = leads.includes(actor.id), canSee = actor.admin || members.some(member => member.person === actor.id);
    return { id: row.id, revision: row.revision, name: row.name, department: row.department_guid || null, leads, leadNames: leads.map(id => members.find(m => m.person === id)?.display_name || id), memberCount: members.length,
      departmentName: row.department_name, lead: row.lead, leadName: lead?.display_name || row.lead,
      members: canSee ? members.map(member => member.person) : [], canManage: actor.admin || isLead, isLead, leadEligible,
      ...(details && canSee ? { memberInfo: members.map(member => ({ id: member.person, name: member.display_name, login: member.login_label,
        department: member.department, signedIn: !!db.prepare("SELECT 1 FROM hub_people WHERE person=?").get(member.person),
        agents: db.prepare("SELECT id,display_name AS name FROM hub_exposures WHERE owner=? AND state='published' ORDER BY display_name,id")
          .all(member.person) as { id: string; name: string }[] })),
      impact: { grants: db.prepare("SELECT g.id,g.exposure_id AS exposureId,e.display_name AS name,g.expires_at AS expiresAt FROM hub_grants g JOIN hub_exposures e ON e.id=g.exposure_id WHERE g.subject_kind='team' AND g.subject=? AND g.state='active' AND g.expires_at>? ORDER BY g.id")
        .all(row.id, this.core.now()) as { id: string; exposureId: string; name: string; expiresAt: number }[],
        allowedList: this.usage.allowedListUsesTeam?.(db,row.id) ?? false,
        roomCreator: !!db.prepare("SELECT 1 FROM hub_room_creators WHERE kind='team' AND subject=?").get(row.id) } } : {}) };
  }
  async list(ctx: HubRequestContext) {
    const actor = await this.who(ctx);
    return this.core.atomic(db => (db.prepare("SELECT * FROM hub_teams WHERE deleted=0 ORDER BY name COLLATE NOCASE,id")
      .all() as TeamRow[]).map(row => this.view(db, row, actor)), this.fence(ctx));
  }
  async get(ctx: HubRequestContext, id: string) {
    const actor = await this.who(ctx), image = this.core.atomic(db => this.snapshot(db, id));
    if (!actor.admin && !image.members.some(member => member.person === actor.id)) throw new HubProtocolError("denied");
    const directory = this.core.deps.directory;
    let eligible: boolean | null = null;
    try { const result = await this.core.readDirectory(actor.person, this.core.groupContext(ctx), () => directory.checkEligibility(personFromString(image.row.lead)));
      eligible = result.eligible ? personKeyString(result.person.key) === image.row.lead : result.reason === "unavailable" ? null : false;
    } catch (error) { this.fence(ctx).assertCurrent(); if (!(error instanceof HubProtocolError) || !["backpressure", "unavailable"].includes(error.code)) throw error; }
    return this.core.atomic(db => { this.checkImage(db, image); return this.view(db, image.row, actor, true, eligible); }, this.fence(ctx));
  }
  async create(ctx: HubRequestContext, input: unknown) {
    const body = validated(createInput, input), actor = await this.who(ctx), permit = await this.creationPermit(ctx,actor);
    if (!permit.allowed) throw new HubProtocolError("denied");
    const leads = [...new Set([actor.id,...(body.leads ?? (body.lead ? [body.lead] : []))])];
    if (leads.length > 5) throw new HubProtocolError("invalid");
    if (!actor.admin && (body.lead && body.lead !== actor.id || body.leads && !same(body.leads,[actor.id]))) throw new HubProtocolError("denied");
    const members = this.roster(body.members,leads), department = body.department ? await this.department(ctx,actor,body.department) : null;
    const selected = await this.selectedPeople(ctx, actor, members);
    return this.core.atomic((db, tx) => {
      selected.assertCurrent(); department?.assertCurrent(); permit.assertCurrent();
      if ((db.prepare("SELECT COUNT(*) AS n FROM hub_teams WHERE deleted=0").get() as { n: number }).n >= TEAM_LIMIT) throw new HubProtocolError("backpressure");
      const id = randomUUID(), now = this.core.now();
      db.prepare("INSERT INTO hub_teams VALUES(?,1,?,?,?,?,?,?,?,0)").run(id, body.name, department?.realm ?? "", body.department ?? "", department?.name ?? "", leads[0], now, now);
      for (const member of selected.rows) db.prepare("INSERT INTO hub_team_members VALUES(?,?,?,?,?)")
        .run(id, member.person, member.display_name, member.login_label, member.department);
      writeTeamLeads(db,id,leads);
      this.auditRoster(tx,ctx,actor,id,[],members,[],leads);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: actor.person }, action: "team.created", result: "completed", reasonCode: id });
      return this.view(db, this.required(db, id), actor);
    }, this.fence(ctx));
  }
  async update(ctx: HubRequestContext, id: string, input: unknown) {
    const body = validated(updateInput, input), actor = await this.who(ctx), image = this.core.atomic(db => this.snapshot(db, id));
    if (!actor.admin && !image.leads.includes(actor.id)) throw new HubProtocolError("denied");
    if (body.revision !== undefined && body.revision !== image.row.revision) throw new HubProtocolError("conflict");
    const leads = body.leads ?? (body.lead ? [body.lead] : image.leads), lead = leads[0]!;
    const leadChanged = !same(leads,image.leads);
    const requested = body.members ?? image.members.map(member => member.person);
    if (body.members && leads.some(lead => !body.members!.includes(lead))) throw new HubProtocolError("conflict");
    const members = this.roster(requested,leads);
    const old = new Map(image.members.map(member => [member.person, member]));
    const selected = await this.selectedPeople(ctx, actor, members.filter(member => !old.has(member) || (leadChanged && leads.includes(member))));
    const labels = new Map([...old, ...selected.rows.map(member => [member.person, member] as const)]);
    const department = body.department && body.department !== image.row.department_guid ? await this.department(ctx, actor, body.department) : null;
    return this.core.atomic((db, tx) => {
      selected.assertCurrent(); department?.assertCurrent(); this.checkImage(db, image);
      db.prepare("UPDATE hub_teams SET revision=revision+1,name=?,department_realm=?,department_guid=?,department_name=?,lead=?,updated_at=? WHERE id=?")
        .run(body.name ?? image.row.name, body.department === null ? "" : department?.realm ?? image.row.department_realm, body.department === null ? "" : body.department ?? image.row.department_guid,
          body.department === null ? "" : department?.name ?? image.row.department_name, lead, this.core.now(), id);
      db.prepare("DELETE FROM hub_team_members WHERE team_id=?").run(id);
      for (const member of members) { const label = labels.get(member)!;
        db.prepare("INSERT INTO hub_team_members VALUES(?,?,?,?,?)").run(id, member, label.display_name, label.login_label, label.department);
      }
      writeTeamLeads(db,id,leads);
      this.auditRoster(tx,ctx,actor,id,image.members.map(m => m.person),members,image.leads,leads);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: actor.person }, action: "team.updated", result: "completed", reasonCode: id });
      return this.view(db, this.required(db, id), actor);
    }, this.fence(ctx));
  }
  private auditRoster(tx: import("../types.js").HubTx, ctx: HubRequestContext, actor: Actor, id: string,
    before: readonly string[], after: readonly string[], oldLeads: readonly string[], leads: readonly string[]) {
    for (const [action,people] of [
      ["team.member-added",after.filter(p => !before.includes(p))], ["team.member-removed",before.filter(p => !after.includes(p))],
      ["team.lead-added",leads.filter(p => !oldLeads.includes(p))], ["team.lead-removed",oldLeads.filter(p => !leads.includes(p))],
    ] as const) for (const target of people) this.core.audit(tx,{requestId:ctx.requestId,actor:{kind:"person",person:actor.person},
      action,result:"completed",reasonCode:id,ownerAtEvent:personFromString(target)});
  }
  async remove(ctx: HubRequestContext, id: string) {
    const actor = await this.who(ctx), image = this.core.atomic(db => this.snapshot(db, id));
    if (!actor.admin && !image.leads.includes(actor.id)) throw new HubProtocolError("denied");
    return this.core.atomic((db, tx) => {
      this.checkImage(db, image);
      db.prepare("UPDATE hub_teams SET deleted=1,revision=revision+1,updated_at=? WHERE id=?").run(this.core.now(), id);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: actor.person }, action: "team.deleted", result: "completed", reasonCode: id });
    }, this.fence(ctx));
  }
}
