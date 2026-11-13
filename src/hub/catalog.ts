/**
 * AgEnD Hub P1, slice 3: the exposure catalog and grants (hub.md §4, §5; seams with S1/S4 on cid-hub-s3-readiness).
 *
 * The Hub's exposure rows MIRROR what each member's owner approved. A member only publishes what its own S4 readiness
 * accepted. The Hub never asks S4 and never infers "enforceable" from a row being there.
 * - Snapshots are complete, monotonic catalog revisions per fleet. A newer accepted snapshot replaces the fleet's
 *   catalog: an exposure missing from it is withdrawn. An older snapshot is refused and can never revive consent. A
 *   repeat of the current revision is accepted only when byte-identical.
 * - An exposure's own revision never goes backwards.
 * - The Hub may narrow or freeze, never widen. A Hub-side freeze holds every revision up to the one it froze; only a
 *   newer revision re-consented on the member lifts it.
 * - A grant binds one person or immutable AD group to one exact exposure id and revision. A new exposure revision leaves old grants
 *   inapplicable until the owner grants again. Only the exposure's owner grants or revokes, against the revision shown.
 * - Private-agent non-enumeration: a person sees the exposures they own, and the published ones granted to them now.
 *   They never see others.
 */
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { HubProtocolError, epoch, identifier, person as personSchema, uuid, validated } from "./validation.js";
import { exposureSchema } from "./protocol.js";
import { HubGroupAuthorizationError, type HubGroupEnrollmentPermit, type HubGroupPermit } from "./group-policy/authorization.js";
import { HubGroupPolicyError } from "./group-policy/store.js";
import { HubGroupEnrollmentRefusal } from "./group-policy/resources.js";
import { personKeyString } from "./identity.js";
import type { HubExposure, HubExposureSnapshot, HubGrant, HubRequestContext, PersonKey } from "./types.js";
import type { HubLinkContext } from "./server.js";
import { personFromString, type HubCore, type HubOperationPermit } from "./http/core.js";
import type { HubGrantSubjectProof } from "./grant-access.js";

/** New grants match the UI's 90-day maximum. Existing rows retain their recorded expiry. */
export const GRANT_MAX_MS = 90 * 24 * 60 * 60_000;
/** Valid publication consent refused by policy; it does not revoke the member's connection. */
export class HubPublicationRefusal extends HubProtocolError {
  constructor(code: "denied" | "unavailable") { super(code); }
}
const PERMISSIONS = ["ask", "read-own-room"] as const;
const snapshotSchema = z.strictObject({ revision: epoch, exposures: z.array(exposureSchema).max(64) });
const selectedSubject = z.union([
  z.strictObject({ kind: z.literal("person"), person: personSchema }),
  z.strictObject({ kind: z.literal("group"), group: personSchema.extend({ objectId: uuid }), dn: z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f]+$/) }),
  z.strictObject({ kind: z.literal("team"), teamId: uuid }),
]);
const grantInput = z.strictObject({ exposureId: uuid, exposureRevision: epoch, days: z.number().int().min(1).max(GRANT_MAX_MS / 86_400_000),
  login: z.string().trim().min(1).max(256).optional(), subject: selectedSubject.optional(),
}).refine(v => v.subject?.kind === "group" || v.subject?.kind === "team" || !!v.login);

interface ExposureRow { id: string; fleet_id: string; owner: string; display_name: string; revision: number; state: HubExposure["state"]; data_view_id: string; allowed_tools: string; policy_digest: string; frozen_through: number; sharing_paused?: number; sharing_epoch?: number }
interface GrantRow { id: string; revision: number; owner: string; exposure_id: string; exposure_revision: number; approved_by: string; approved_at: number; subject: string; subject_kind?: "person" | "group" | "team"; subject_label?: string; permissions: string; starts_at: number; expires_at: number; state: HubGrant["state"] }

/** Presentation only: AD group DNs normally start with CN. Never use this label as identity or rewrite it.
 * Decode RFC 4514 character/UTF-8 octet escapes in that leading value; preserve plain/unsupported labels.
 * This deliberately is not a DN validator or a BER hexstring decoder.
 */
function groupGrantName(label: string): string {
  const first = /^cn=((?:\\(?:[0-9a-f]{2}|[ "#+,;<=>\\])|[^\\,+;"<>])*)(?:[,+]|$)/i.exec(label)?.[1];
  if (!first || first.startsWith("#")) return label;
  try {
    const name = first.replace(/\\((?:[0-9a-f]{2})(?:\\[0-9a-f]{2})*)|\\([ "#+,;<=>\\])/gi, (_, hex: string | undefined, char: string) =>
      hex ? new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(hex.replaceAll("\\", ""), "hex")) : char);
    return name && !/[\u0000-\u001f\u007f]/.test(name) ? name : label;
  } catch { return label; }
}

export function exposureOf(row: ExposureRow): HubExposure {
  return { id: row.id, fleetId: row.fleet_id, owner: personFromString(row.owner), displayName: row.display_name, revision: row.revision,
    state: row.state === "published" ? row.frozen_through >= row.revision ? "frozen" : row.sharing_paused ? "paused" : "published" : row.state,
    ...(row.sharing_epoch ? { sharingEpoch: row.sharing_epoch } : {}),
    dataViewId: row.data_view_id, allowedTools: JSON.parse(row.allowed_tools) as string[], policyDigest: row.policy_digest };
}
export function grantOf(row: GrantRow): HubGrant {
  if (row.subject_kind !== undefined && !["person", "group", "team"].includes(row.subject_kind)) throw new HubProtocolError("unavailable");
  const subject: HubGrant["subject"] = row.subject_kind === "team" ? { kind: "team", teamId: validated(uuid, row.subject) }
    : row.subject_kind === "group" ? { kind: "group", group: validated(personSchema, personFromString(row.subject)) }
    : { kind: "person", person: validated(personSchema, personFromString(row.subject)) };
  return { id: row.id, revision: row.revision, owner: personFromString(row.owner), exposureId: row.exposure_id, exposureRevision: row.exposure_revision,
    approvedBy: personFromString(row.approved_by), approvedAt: row.approved_at,
    subject, ...((row.subject_kind === "group" || row.subject_kind === "team") && row.subject_label ? { subjectLabel: row.subject_label } : {}),
    permissions: JSON.parse(row.permissions) as HubGrant["permissions"], startsAt: row.starts_at, expiresAt: row.expires_at, state: row.state };
}
export const readExposure = (db: Database.Database, id: string) => db.prepare("SELECT * FROM hub_exposures WHERE id=?").get(id) as ExposureRow | undefined;
export const readGrant = (db: Database.Database, id: string) => db.prepare("SELECT * FROM hub_grants WHERE id=?").get(id) as GrantRow | undefined;
/** The canonical bytes of a snapshot: a repeat of a revision must match them exactly. */
const snapshotDigest = (s: HubExposureSnapshot) => createHash("sha256").update(JSON.stringify([s.revision, [...s.exposures].sort((a, b) => (a.id < b.id ? -1 : 1))
  .map((e) => [e.id, e.fleetId, e.owner.realm, e.owner.objectId, e.displayName, e.revision, e.state, e.dataViewId, [...e.allowedTools], e.policyDigest])])).digest("hex");

/** Whether a grant lets `asker` ask `exposure` right now (exact revision, window, state, permission). */
export function grantSubjectApplies(grant: HubGrant, asker: PersonKey, proof?: HubGrantSubjectProof): boolean {
  return proof ? proof.allows(grant, asker) : grant.subject.kind === "person" && personKeyString(grant.subject.person) === personKeyString(asker);
}
export function grantApplies(grant: HubGrant, exposure: HubExposure, asker: PersonKey, now: number, proof?: HubGrantSubjectProof): boolean {
  return grant.state === "active" && grant.exposureId === exposure.id && grant.exposureRevision === exposure.revision
    && grantSubjectApplies(grant, asker, proof)
    && personKeyString(grant.owner) === personKeyString(exposure.owner)
    && grant.startsAt <= now && now < grant.expiresAt && grant.permissions.includes("ask");
}

export interface HubCatalogView {
  mine: readonly (HubExposure & { grants: readonly (HubGrant & { subjectName: string; subjectLogin: string; subjectSignedIn?: boolean })[] })[];
  askable: readonly { exposure: HubExposure; grant: HubGrant; ownerName: string }[];
}

/** One catalog entry per agent. Reuse a still-authorized chat; never move its history onto another grant. */
function selectAskable(db: Database.Database, candidates: HubCatalogView["askable"], asker: string): HubCatalogView["askable"] {
  const rooms = new Map((db.prepare("SELECT grant_id, MAX(created_at) at FROM hub_rooms WHERE asker=? AND state='active' GROUP BY grant_id").all(asker) as { grant_id: string; at: number }[]).map(r => [r.grant_id, r.at]));
  const seen = new Set<string>();
  return [...candidates].sort((a, b) => Number(rooms.has(b.grant.id)) - Number(rooms.has(a.grant.id))
    || (rooms.get(b.grant.id) ?? 0) - (rooms.get(a.grant.id) ?? 0) || b.grant.expiresAt - a.grant.expiresAt || a.grant.id.localeCompare(b.grant.id))
    .filter(c => !seen.has(c.exposure.id) && !!seen.add(c.exposure.id));
}

export class HubCatalogService {
  constructor(private readonly core: HubCore) {}

  /** A member's complete catalog revision, from its authenticated link (S1 already refused another fleet or owner). */
  async receiveSnapshot(input: HubExposureSnapshot, incoming: HubLinkContext, requestId: string = randomUUID()): Promise<void> {
    // Capture the complete payload and the current callback before any group-directory await.
    const snapshot = validated(snapshotSchema, input), current = incoming.current.bind(incoming);
    const link = { fleetId: validated(uuid, incoming.fleetId), owner: validated(personSchema, incoming.owner), current };
    const now = this.core.now(), owner = personKeyString(link.owner), dig = snapshotDigest(snapshot);
    const ids = new Set<string>();
    for (const e of snapshot.exposures) {
      if (e.fleetId !== link.fleetId || personKeyString(e.owner) !== owner || ids.has(e.id)) throw new HubProtocolError("denied");
      ids.add(e.id);
    }
    if (!link.current()) throw new HubProtocolError("stale");
    const image = (db: Database.Database) => ({
      cursor: db.prepare("SELECT revision,digest,at FROM hub_catalog_cursor WHERE fleet_id=?").get(link.fleetId) ?? null,
      rows: db.prepare("SELECT * FROM hub_exposures WHERE fleet_id=? ORDER BY id").all(link.fleetId),
    });
    const before = this.core.atomic(db => image(db));
    const cursor = before.cursor as { revision: number; digest: string } | null;
    if (cursor && snapshot.revision < cursor.revision) throw new HubProtocolError("stale");
    if (cursor && snapshot.revision === cursor.revision) {
      if (cursor.digest !== dig) throw new HubProtocolError("conflict");
      return; // A byte-identical retransmission neither creates provenance nor consults groups again.
    }
    const oldRows = before.rows as (ExposureRow & { updated_at: number })[];
    const validateBindings = (db: Database.Database) => {
      for (const e of snapshot.exposures) {
        const old = readExposure(db, e.id);
        if (old && (old.fleet_id !== link.fleetId || old.owner !== owner)) throw new HubProtocolError("denied");
        if (old && e.revision < old.revision) throw new HubProtocolError("stale");
        if (old && e.revision === old.revision && (old.policy_digest !== e.policyDigest || old.data_view_id !== e.dataViewId
          || old.allowed_tools !== JSON.stringify([...e.allowedTools]))) throw new HubProtocolError("conflict");
      }
    };
    this.core.atomic(validateBindings); // Ordinary malformed/stale consent never reaches the group-refusal narrowing path.
    const publishing = snapshot.exposures.filter(e => {
      const old = oldRows.find(r => r.id === e.id);
      return e.state === "published" && (!old || e.revision > old.frozen_through)
        && (!old || old.state !== "published" || old.frozen_through >= old.revision || old.revision !== e.revision);
    });
    const groups = this.core.deps.groups, prepared: HubGroupEnrollmentPermit[] = [];
    let fleetPermit: HubGroupPermit | undefined, serializedFleet: string | undefined;
    const ctx = { requestId: validated(identifier, requestId), current: () => this.core.live() && link.current() };
    let expectedImage = JSON.stringify(before);
    const permit = { assertCurrent: () => {
      if (!ctx.current() || this.core.deps.groups !== groups) throw new HubProtocolError("unavailable");
      fleetPermit?.assertCurrent(); for (const p of prepared) p.assertCurrent();
      if (serializedFleet !== undefined && JSON.stringify(this.core.deps.store.read().fleets.find(f => f.id === link.fleetId)) !== serializedFleet) throw new HubProtocolError("stale");
      if (JSON.stringify(this.core.atomic(db => image(db))) !== expectedImage) throw new HubProtocolError("conflict");
    } };
    // A publication refusal cannot keep an independently withdrawn agent reachable. Apply only reductions
    // to the prior exact material, retaining the cursor so the complete snapshot can be retried later.
    const narrowRefused = () => {
      const requested = new Map(snapshot.exposures.map(e => [e.id, e]));
      const narrowed = oldRows.filter(row => row.state !== "withdrawn" && (!requested.has(row.id) || requested.get(row.id)!.state !== "published"));
      if (!narrowed.length) return;
      let written = false;
      const narrowingPermit = { assertCurrent: () => {
        if (!ctx.current() || this.core.deps.groups !== groups) throw new HubProtocolError("unavailable");
        if (serializedFleet !== undefined && JSON.stringify(this.core.deps.store.read().fleets.find(f => f.id === link.fleetId)) !== serializedFleet) throw new HubProtocolError("stale");
        this.core.atomic(db => {
          if (JSON.stringify(image(db)) !== expectedImage) throw new HubProtocolError("conflict");
          if (written) for (const row of narrowed) {
            if (db.prepare("SELECT 1 FROM hub_grants WHERE exposure_id=? AND state='active'").get(row.id)
              || db.prepare("SELECT 1 FROM hub_rooms WHERE exposure_id=? AND state<>'closed'").get(row.id)) throw new HubProtocolError("conflict");
          }
        });
      } };
      this.core.atomic((db, tx) => {
        validateBindings(db);
        for (const row of narrowed) {
          const state = requested.get(row.id)?.state ?? "withdrawn";
          db.prepare("UPDATE hub_exposures SET state=?,frozen_through=MAX(frozen_through,?),updated_at=? WHERE id=?")
            .run(state, state === "frozen" ? row.revision : row.frozen_through, now, row.id);
          db.prepare("UPDATE hub_grants SET state='revoked',revision=revision+1 WHERE exposure_id=? AND state='active'").run(row.id);
          db.prepare("UPDATE hub_rooms SET state='closed' WHERE exposure_id=? AND state<>'closed'").run(row.id);
        }
        expectedImage = JSON.stringify(image(db)); written = true;
        this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "member", fleetId: link.fleetId }, action: "exposure.snapshot-narrowed", result: "completed",
          fleetId: link.fleetId, ownerAtEvent: link.owner, reasonCode: "publication-refused" });
      }, narrowingPermit);
    };
    let preparedAll = false;
    try {
      if (groups && publishing.length) {
        const fleet = this.core.deps.store.read().fleets.find(f => f.id === link.fleetId);
        if (!fleet || personKeyString(fleet.owner) !== owner) throw new HubProtocolError("revoked");
        serializedFleet = JSON.stringify(fleet);
        fleetPermit = await groups.check({ kind: "fleet", id: fleet.id, revision: fleet.generation, owner: fleet.owner }, ctx);
        if (fleetPermit.source !== "legacy" && (fleet.status !== "active" || !fleet.credentialHash)) throw new HubProtocolError("revoked");
        // A legacy fleet permit already binds the never-enabled/repair policy and epoch. It creates no provenance.
        if (fleetPermit.source !== "legacy") for (const exposure of publishing) {
          const permit = await groups.prepareEnrollment({ kind: "exposure", id: exposure.id, revision: exposure.revision, owner: exposure.owner }, ctx);
          if (fleetPermit.source === "code" && permit.source === "legacy") throw new HubGroupAuthorizationError("denied");
          prepared.push(permit);
        }
      }
      preparedAll = true;
      this.core.atomic((db, tx) => {
        const cursor = db.prepare("SELECT revision, digest FROM hub_catalog_cursor WHERE fleet_id=?").get(link.fleetId) as { revision: number; digest: string } | undefined;
        if (cursor && snapshot.revision < cursor.revision) throw new HubProtocolError("stale");
        if (cursor && snapshot.revision === cursor.revision) {
          if (cursor.digest !== dig) throw new HubProtocolError("conflict");
          return;                                            // the same revision again: nothing changes
        }
        validateBindings(db);
        const listed = new Set(snapshot.exposures.map((e) => e.id));
        const absent = (db.prepare("SELECT id FROM hub_exposures WHERE fleet_id=? AND state<>'withdrawn'").all(link.fleetId) as { id: string }[])
          .filter((r) => !listed.has(r.id));
        for (const r of absent) db.prepare("UPDATE hub_exposures SET state='withdrawn', updated_at=? WHERE id=?").run(now, r.id);
        // Leaving "published" (withdrawn by absence or by state) ends its grants and rooms: a later re-publish, even at the
        // same revision, needs the owner to grant again — consent never revives from history.
        const ended = [...absent.map((r) => r.id), ...snapshot.exposures.filter((e) => e.state !== "published").map((e) => e.id)];
        for (const id of ended) {
          db.prepare("UPDATE hub_grants SET state='revoked', revision=revision+1 WHERE exposure_id=? AND state='active'").run(id);
          db.prepare("UPDATE hub_rooms SET state='closed' WHERE exposure_id=? AND state<>'closed'").run(id);
        }
        for (const e of snapshot.exposures) {
          db.prepare(`INSERT INTO hub_exposures(id, fleet_id, owner, display_name, revision, state, data_view_id, allowed_tools, policy_digest, updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, revision=excluded.revision, state=excluded.state,
            data_view_id=excluded.data_view_id, allowed_tools=excluded.allowed_tools, policy_digest=excluded.policy_digest, updated_at=excluded.updated_at`)
            .run(e.id, e.fleetId, owner, e.displayName, e.revision, e.state, e.dataViewId, JSON.stringify([...e.allowedTools]), e.policyDigest, now);
        }
        db.prepare(`INSERT INTO hub_catalog_cursor(fleet_id, revision, digest, at) VALUES(?,?,?,?)
          ON CONFLICT(fleet_id) DO UPDATE SET revision=excluded.revision, digest=excluded.digest, at=excluded.at`).run(link.fleetId, snapshot.revision, dig, now);
        // Capture only our own SQL result, before invoking either registration or snapshot audit callbacks.
        expectedImage = JSON.stringify(image(db));
        for (const p of prepared) p.commit(db);
        this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "member", fleetId: link.fleetId }, action: "exposure.snapshot", result: "completed",
          fleetId: link.fleetId, ownerAtEvent: link.owner, reasonCode: absent.length ? "withdrawn" : undefined });
      }, permit);
    } catch (error) {
      if (!preparedAll && error instanceof HubGroupPolicyError) narrowRefused();
      if ((error instanceof HubGroupAuthorizationError && ["denied", "resume-required"].includes(error.reason))
        || (error instanceof HubGroupEnrollmentRefusal && error.outcome === "denied")) throw new HubPublicationRefusal("denied");
      if (error instanceof HubGroupAuthorizationError || error instanceof HubGroupEnrollmentRefusal) throw new HubPublicationRefusal("unavailable");
      if (error instanceof HubGroupPolicyError) throw new HubProtocolError("unavailable");
      throw error;
    }
  }

  /** What this person may see: their own exposures (with the grants on them) and what is granted to them now. */
  async visible(ctx: HubRequestContext): Promise<HubCatalogView> {
    const person = await ctx.requirePerson(), me = personKeyString(person), now = this.core.now();
    const initial = this.core.atomic((db) => {
      const names = (id: string) => db.prepare("SELECT display_name, login_label FROM hub_people WHERE person=?").get(id) as { display_name: string; login_label: string } | undefined;
      const mine = (db.prepare("SELECT * FROM hub_exposures WHERE owner=? AND state<>'withdrawn' ORDER BY display_name").all(me) as ExposureRow[]).map((row) => {
        const grants = (db.prepare("SELECT * FROM hub_grants WHERE exposure_id=? AND state='active' AND expires_at>? ORDER BY approved_at").all(row.id, now) as GrantRow[])
          .map((g) => { const n = g.subject_kind === "group" || g.subject_kind === "team" ? null : names(g.subject);
            return { ...grantOf(g), subjectName: g.subject_kind === "team" ? this.core.deps.roomTeams?.read(db, g.subject)?.name ?? g.subject_label ?? ""
              : g.subject_kind === "group" ? groupGrantName(g.subject_label ?? g.subject) : n?.display_name ?? "", subjectLogin: n?.login_label ?? "" }; });
        return { ...exposureOf(row), grants };
      });
      const askable: { exposure: HubExposure; grant: HubGrant; ownerName: string }[] = [];
      for (const g of db.prepare("SELECT * FROM hub_grants WHERE ((subject=? AND subject_kind='person') OR subject_kind IN ('group','team')) AND state='active' AND expires_at>?").all(me, now) as GrantRow[]) {
        const row = readExposure(db, g.exposure_id); if (!row) continue;
        const exposure = exposureOf(row), grant = grantOf(g);
        if (exposure.state !== "published" || grant.exposureRevision !== exposure.revision || grant.startsAt > now
          || personKeyString(grant.owner) !== personKeyString(exposure.owner)) continue;
        askable.push({ exposure, grant, ownerName: names(row.owner)?.display_name ?? "" });
      }
      return { mine, askable };
    });
    // A grant may precede its recipient's first sign-in. Resolve display labels by the grant's immutable key,
    // without manufacturing a Hub person row. Existing signed-in people's labels retain the normal path.
    const recipientNames = new Map<string, { login: string; displayName?: string } | null>();
    for (const exposure of initial.mine) for (const grant of exposure.grants) {
      if (grant.subject.kind !== "person") continue;
      const id = personKeyString(grant.subject.person);
      if (!grant.subjectLogin && !recipientNames.has(id)) recipientNames.set(id, await this.core.current(grant.subject.person));
    }
    if (recipientNames.size) await ctx.current();
    const mine = initial.mine.map(exposure => ({ ...exposure, grants: exposure.grants.map(grant => {
      if (grant.subject.kind !== "person") return grant;
      const name = recipientNames.get(personKeyString(grant.subject.person));
      return name ? { ...grant, subjectLogin: name.login, subjectName: name.displayName ?? name.login } : grant;
    }) }));
    const context = this.core.groupContext(ctx);
    let subjectProof = await this.core.grantAccess(initial.askable.map(g => g.grant.id), person, context);
    // Choose candidates synchronously; slow operational reads must not reuse an aged subject allow at disclosure.
    const candidates = initial.askable.filter(c => grantApplies(c.grant, c.exposure, person, this.core.now(), subjectProof));
    const proofs: HubOperationPermit[] = [], askable: HubCatalogView["askable"][number][] = [];
    let canAsk = true;
    try { proofs.push(await this.core.groupAsker(person, context)); }
    catch (e) { if (e instanceof HubProtocolError && e.code === "denied") canAsk = false; else throw e; }
    for (const candidate of canAsk ? candidates : []) {
      try { proofs.push(await this.core.groupExposure(candidate.exposure.id, null, context)); askable.push(candidate); }
      catch (e) { if (!(e instanceof HubProtocolError && (e.code === "denied" || e.code === "revoked"))) throw e; }
    }
    subjectProof.assertSelectionCurrent();
    if (this.core.now() >= subjectProof.expiresAt) {
      const fresh = await this.core.grantAccess(askable.map(c => c.grant.id), person, context);
      // Ending and regaining a policy/session/row cannot revive the original selection.
      subjectProof.assertSelectionCurrent(); subjectProof = fresh;
    }
    proofs.push(subjectProof);
    for (const proof of proofs) proof.assertCurrent();
    // Recheck ordinary grants after all asynchronous group reads too. A person row witnesses successful Hub
    // sign-in permanently; directory eligibility checks and ended sessions cannot manufacture or erase it.
    return this.core.atomic(db => ({ mine: mine.filter(candidate => {
      const row = readExposure(db, candidate.id);
      return row && row.owner === me && row.state !== "withdrawn" && row.revision === candidate.revision;
    }).map(exposure => ({ ...exposure, grants: exposure.grants.filter(grant => {
      const row = readGrant(db, grant.id);
      return row && row.revision === grant.revision && row.state === "active" && row.expires_at > this.core.now();
    }).map(grant => grant.subject.kind === "person" ? ({ ...grant, subjectSignedIn: !!db.prepare("SELECT 1 FROM hub_people WHERE person=?").get(personKeyString(grant.subject.person)) }) : grant) })), askable: selectAskable(db, askable.filter(candidate => {
      const e = readExposure(db, candidate.exposure.id), g = readGrant(db, candidate.grant.id);
      return e && g && exposureOf(e).state === "published" && grantOf(g).revision === candidate.grant.revision
        && grantApplies(grantOf(g), exposureOf(e), person, this.core.now(), subjectProof);
    }), me) }), { assertCurrent: () => { for (const proof of proofs) proof.assertCurrent(); } });
  }

  /** Owner-selected person or immutable AD security group; suggestions and labels never grant authority. */
  async grant(ctx: HubRequestContext, incoming: { exposureId: string; exposureRevision: number; login?: string; days: number; subject?: unknown }): Promise<HubGrant> {
    const input = validated(grantInput, incoming);
    const owner = await ctx.requirePerson(), me = personKeyString(owner);
    // A signed-in person may resolve a recipient only for their own exact published exposure.
    // Repeat these checks after selection settles, in the transaction handling any result.
    const ownedExposure = (db: Database.Database) => {
      const row = readExposure(db, input.exposureId);
      if (!row || row.owner !== me) throw new HubProtocolError("not-found");
      const exposure = exposureOf(row);
      if (exposure.revision !== input.exposureRevision) throw new HubProtocolError("conflict");
      if (exposure.state !== "published") throw new HubProtocolError("denied");
      return exposure;
    };
    const selectedExposure = JSON.stringify(this.core.atomic(ownedExposure));
    let directoryPermit: HubOperationPermit | undefined;
    const select = async (): Promise<{ subject: HubGrant["subject"]; label?: string } | null> => {
      if (input.subject?.kind === "team") {
        const reader = this.core.deps.roomTeams, read = reader?.read, teamId = input.subject.teamId;
        if (!reader || !read) throw new HubProtocolError("unavailable");
        const selected = this.core.atomic(db => read.call(reader, db, teamId));
        if (!selected) throw new HubProtocolError("not-found");
        const image = JSON.stringify(selected);
        directoryPermit = { assertCurrent: () => {
          this.core.check(); if (ctx.isCurrent?.() !== true) throw new HubProtocolError("revoked");
          if (this.core.deps.roomTeams !== reader || reader.read !== read
            || this.core.atomic(db => JSON.stringify(read.call(reader, db, teamId))) !== image) throw new HubProtocolError("conflict");
        } };
        return { subject: { kind: "team", teamId }, label: selected.name };
      }
      if (input.subject?.kind === "group") {
        const { group, dn } = input.subject, directory = this.core.deps.directory, lookup = directory.resolvePolicyGroup;
        if (group.realm !== directory.realm || directory.groupPolicy !== "ad-direct-guid" || !lookup) throw new HubProtocolError("unavailable");
        const read = await this.core.grantDirectoryRead(owner, this.core.groupContext(ctx), () => lookup.call(directory, dn));
        directoryPermit = { assertCurrent: () => {
          read.permit.assertCurrent();
          if (this.core.deps.directory !== directory || directory.resolvePolicyGroup !== lookup) throw new HubProtocolError("unavailable");
        } };
        const found = read.value;
        if (!found.ok) {
          if (found.reason === "unknown") throw new HubProtocolError("unavailable");
          throw new HubProtocolError("not-found");
        }
        const key = validated(personSchema.extend({ objectId: uuid }), found.group.key), label = validated(selectedSubject.options[1].shape.dn, found.group.dn);
        if (personKeyString(key) !== personKeyString(group) || label.toLowerCase() !== dn.toLowerCase()) throw new HubProtocolError("conflict");
        return { subject: { kind: "group", group: key }, label };
      }
      const key = await this.core.lookupGrantRecipient(input.login!);
      if (!key || personKeyString(key) === me) return null;
      if (input.subject?.kind === "person" && personKeyString(key) !== personKeyString(input.subject.person)) throw new HubProtocolError("conflict");
      return { subject: { kind: "person", person: key } };
    };
    // Settle every outcome first: even a refusal or lookup error must not disclose a result after authority ends.
    const selection = await select().then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    this.core.check();
    await ctx.current();
    return this.core.atomic((db, tx) => {
      if (ctx.isCurrent?.() === false) throw new HubProtocolError("revoked");
      const exposure = ownedExposure(db);
      if (JSON.stringify(exposure) !== selectedExposure) throw new HubProtocolError("conflict");
      if (!selection.ok) throw selection.error;
      const selected = selection.value;
      if (!selected) throw new HubProtocolError("not-found");
      const subject = selected.subject, subjectId = subject.kind === "team" ? subject.teamId : personKeyString(subject.kind === "person" ? subject.person : subject.group);
      const now = this.core.now();
      const grant: HubGrant = { id: randomUUID(), revision: 1, owner, exposureId: exposure.id, exposureRevision: exposure.revision,
        approvedBy: owner, approvedAt: now, subject, ...(selected.label ? { subjectLabel: selected.label } : {}), permissions: [...PERMISSIONS],
        startsAt: now, expiresAt: now + input.days * 86_400_000, state: "active" };
      for (const g of db.prepare("SELECT id FROM hub_grants WHERE exposure_id=? AND subject=? AND subject_kind=? AND state='active' AND exposure_revision=?").all(exposure.id, subjectId, subject.kind, exposure.revision) as { id: string }[])
        db.prepare("UPDATE hub_grants SET state='revoked', revision=revision+1 WHERE id=?").run(g.id);
      db.prepare(`INSERT INTO hub_grants(id, revision, owner, exposure_id, exposure_revision, approved_by, approved_at, subject, permissions, starts_at, expires_at, state, subject_kind, subject_label)
        VALUES(?,?,?,?,?,?,?,?,?,?,?, 'active',?,?)`).run(grant.id, 1, me, exposure.id, exposure.revision, me, now, subjectId, JSON.stringify(grant.permissions), grant.startsAt, grant.expiresAt, subject.kind, selected.label ?? "");
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: owner }, action: "grant.created", result: "completed",
        fleetId: exposure.fleetId, exposureId: exposure.id, ownerAtEvent: owner, grantId: grant.id, grantRevision: 1 });
      return grant;
    }, directoryPermit);
  }

  /** The owner withdraws a grant (narrowing: always allowed) against the revision they saw; its rooms close. */
  async revokeGrant(ctx: HubRequestContext, id: string, revision: number): Promise<void> {
    const owner = await ctx.requirePerson(), me = personKeyString(owner);
    this.core.atomic((db, tx) => {
      const g = readGrant(db, id);
      if (!g || g.owner !== me) throw new HubProtocolError("not-found");
      if (g.revision !== revision) throw new HubProtocolError("conflict");
      if (g.state === "revoked") return;
      db.prepare("UPDATE hub_grants SET state='revoked', revision=revision+1 WHERE id=?").run(id);
      db.prepare("UPDATE hub_rooms SET state='closed' WHERE grant_id=?").run(id);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: owner }, action: "grant.revoked", result: "completed",
        exposureId: g.exposure_id, ownerAtEvent: owner, grantId: id, grantRevision: revision + 1 });
    });
  }

  /**
   * Freeze an exposure on the Hub (narrowing only): its owner or the Hub administrator. It holds every revision up to
   * the current one; the member re-consenting a newer revision lifts it.
   */
  async freeze(ctx: HubRequestContext, id: string, revision: number, admin: boolean): Promise<void> {
    const actor = admin ? await ctx.requireAdmin() : null;
    const person = actor?.kind === "directory" ? actor.person : await ctx.requirePerson();
    this.core.atomic((db, tx) => {
      const row = readExposure(db, id);
      if (!row || (!admin && row.owner !== personKeyString(person))) throw new HubProtocolError("not-found");
      if (row.revision !== revision) throw new HubProtocolError("conflict");
      db.prepare("UPDATE hub_exposures SET frozen_through=MAX(frozen_through, ?), sharing_paused=0, sharing_epoch=sharing_epoch+1, updated_at=? WHERE id=?").run(row.revision, this.core.now(), id);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person }, action: "exposure.frozen", result: "completed",
        fleetId: row.fleet_id, exposureId: id, ownerAtEvent: personFromString(row.owner) });
    });
  }
}
