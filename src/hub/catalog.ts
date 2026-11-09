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
 * - A grant binds one person to one exact exposure id and revision. A new exposure revision leaves old grants
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

/** P1 grants last at most this long; the owner chooses within it. */
export const GRANT_MAX_MS = 365 * 24 * 60 * 60_000;
const PERMISSIONS = ["ask", "read-own-room"] as const;
const snapshotSchema = z.strictObject({ revision: epoch, exposures: z.array(exposureSchema).max(64) });

interface ExposureRow { id: string; fleet_id: string; owner: string; display_name: string; revision: number; state: HubExposure["state"]; data_view_id: string; allowed_tools: string; policy_digest: string; frozen_through: number }
interface GrantRow { id: string; revision: number; owner: string; exposure_id: string; exposure_revision: number; approved_by: string; approved_at: number; subject: string; permissions: string; starts_at: number; expires_at: number; state: HubGrant["state"] }

export function exposureOf(row: ExposureRow): HubExposure {
  return { id: row.id, fleetId: row.fleet_id, owner: personFromString(row.owner), displayName: row.display_name, revision: row.revision,
    state: row.frozen_through >= row.revision && row.state === "published" ? "frozen" : row.state,
    dataViewId: row.data_view_id, allowedTools: JSON.parse(row.allowed_tools) as string[], policyDigest: row.policy_digest };
}
export function grantOf(row: GrantRow): HubGrant {
  return { id: row.id, revision: row.revision, owner: personFromString(row.owner), exposureId: row.exposure_id, exposureRevision: row.exposure_revision,
    approvedBy: personFromString(row.approved_by), approvedAt: row.approved_at, subject: { kind: "person", person: personFromString(row.subject) },
    permissions: JSON.parse(row.permissions) as HubGrant["permissions"], startsAt: row.starts_at, expiresAt: row.expires_at, state: row.state };
}
export const readExposure = (db: Database.Database, id: string) => db.prepare("SELECT * FROM hub_exposures WHERE id=?").get(id) as ExposureRow | undefined;
export const readGrant = (db: Database.Database, id: string) => db.prepare("SELECT * FROM hub_grants WHERE id=?").get(id) as GrantRow | undefined;
/** The canonical bytes of a snapshot: a repeat of a revision must match them exactly. */
const snapshotDigest = (s: HubExposureSnapshot) => createHash("sha256").update(JSON.stringify([s.revision, [...s.exposures].sort((a, b) => (a.id < b.id ? -1 : 1))
  .map((e) => [e.id, e.fleetId, e.owner.realm, e.owner.objectId, e.displayName, e.revision, e.state, e.dataViewId, [...e.allowedTools], e.policyDigest])])).digest("hex");

/** Whether a grant lets `asker` ask `exposure` right now (exact revision, window, state, permission). */
export function grantApplies(grant: HubGrant, exposure: HubExposure, asker: PersonKey, now: number): boolean {
  return grant.state === "active" && grant.exposureId === exposure.id && grant.exposureRevision === exposure.revision
    && personKeyString(grant.subject.person) === personKeyString(asker) && personKeyString(grant.owner) === personKeyString(exposure.owner)
    && grant.startsAt <= now && now < grant.expiresAt && grant.permissions.includes("ask");
}

export interface HubCatalogView {
  mine: readonly (HubExposure & { grants: readonly (HubGrant & { subjectName: string; subjectLogin: string })[] })[];
  askable: readonly { exposure: HubExposure; grant: HubGrant; ownerName: string }[];
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
          prepared.push(await groups.prepareEnrollment({ kind: "exposure", id: exposure.id, revision: exposure.revision, owner: exposure.owner }, ctx));
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
        || (error instanceof HubGroupEnrollmentRefusal && error.outcome === "denied")) throw new HubProtocolError("denied");
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
          .map((g) => { const n = names(g.subject); return { ...grantOf(g), subjectName: n?.display_name ?? "", subjectLogin: n?.login_label ?? "" }; });
        return { ...exposureOf(row), grants };
      });
      const askable: { exposure: HubExposure; grant: HubGrant; ownerName: string }[] = [];
      for (const g of db.prepare("SELECT * FROM hub_grants WHERE subject=? AND state='active' AND expires_at>?").all(me, now) as GrantRow[]) {
        const row = readExposure(db, g.exposure_id); if (!row) continue;
        const exposure = exposureOf(row), grant = grantOf(g);
        if (exposure.state !== "published" || !grantApplies(grant, exposure, person, now)) continue;
        askable.push({ exposure, grant, ownerName: names(row.owner)?.display_name ?? "" });
      }
      return { mine, askable };
    });
    // A grant may precede its recipient's first sign-in. Resolve display labels by the grant's immutable key,
    // without manufacturing a Hub person row. Existing signed-in people's labels retain the normal path.
    const recipientNames = new Map<string, { login: string; displayName?: string } | null>();
    for (const exposure of initial.mine) for (const grant of exposure.grants) {
      const id = personKeyString(grant.subject.person);
      if (!grant.subjectLogin && !recipientNames.has(id)) recipientNames.set(id, await this.core.current(grant.subject.person));
    }
    if (recipientNames.size) await ctx.current();
    const mine = initial.mine.map(exposure => ({ ...exposure, grants: exposure.grants.map(grant => {
      const name = recipientNames.get(personKeyString(grant.subject.person));
      return name ? { ...grant, subjectLogin: name.login, subjectName: name.displayName ?? name.login } : grant;
    }) }));
    const context = this.core.groupContext(ctx), proofs: HubOperationPermit[] = [], askable: HubCatalogView["askable"][number][] = [];
    let canAsk = true;
    try { proofs.push(await this.core.groupAsker(person, context)); }
    catch (e) { if (e instanceof HubProtocolError && e.code === "denied") canAsk = false; else throw e; }
    for (const candidate of canAsk ? initial.askable : []) {
      try { proofs.push(await this.core.groupExposure(candidate.exposure.id, null, context)); askable.push(candidate); }
      catch (e) { if (!(e instanceof HubProtocolError && (e.code === "denied" || e.code === "revoked"))) throw e; }
    }
    for (const proof of proofs) proof.assertCurrent();
    // Recheck ordinary grants after all asynchronous group reads too.
    return this.core.atomic(db => ({ mine: mine.filter(candidate => {
      const row = readExposure(db, candidate.id);
      return row && row.owner === me && row.state !== "withdrawn" && row.revision === candidate.revision;
    }).map(exposure => ({ ...exposure, grants: exposure.grants.filter(grant => {
      const row = readGrant(db, grant.id);
      return row && row.revision === grant.revision && row.state === "active" && row.expires_at > this.core.now();
    }) })), askable: askable.filter(candidate => {
      const e = readExposure(db, candidate.exposure.id), g = readGrant(db, candidate.grant.id);
      return e && g && exposureOf(e).state === "published" && grantOf(g).revision === candidate.grant.revision
        && grantApplies(grantOf(g), exposureOf(e), person, this.core.now());
    }) }), { assertCurrent: () => { for (const proof of proofs) proof.assertCurrent(); } });
  }

  /** Grant one eligible directory person `ask` on the owner's exposure at the revision the owner saw. */
  async grant(ctx: HubRequestContext, input: { exposureId: string; exposureRevision: number; login: string; days: number }): Promise<HubGrant> {
    const owner = await ctx.requirePerson(), me = personKeyString(owner);
    if (!Number.isSafeInteger(input.days) || input.days < 1 || input.days * 86_400_000 > GRANT_MAX_MS) throw new HubProtocolError("invalid");
    const login = input.login.trim();
    if (!login || login.length > 256) throw new HubProtocolError("invalid");
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
    this.core.atomic(ownedExposure);
    // Settle every outcome first: even a refusal or lookup error must not disclose a result after authority ends.
    const selection = await this.core.lookupGrantRecipient(login).then(
      subject => ({ ok: true as const, subject }), error => ({ ok: false as const, error }));
    this.core.check();
    await ctx.current();
    return this.core.atomic((db, tx) => {
      if (ctx.isCurrent?.() === false) throw new HubProtocolError("revoked");
      const exposure = ownedExposure(db);
      if (!selection.ok) throw selection.error;
      const subject = selection.subject, subjectId = subject ? personKeyString(subject) : null;
      if (!subject || !subjectId || subjectId === me) throw new HubProtocolError("not-found");
      const now = this.core.now();
      const grant: HubGrant = { id: randomUUID(), revision: 1, owner, exposureId: exposure.id, exposureRevision: exposure.revision,
        approvedBy: owner, approvedAt: now, subject: { kind: "person", person: subject }, permissions: [...PERMISSIONS],
        startsAt: now, expiresAt: now + input.days * 86_400_000, state: "active" };
      for (const g of db.prepare("SELECT id FROM hub_grants WHERE exposure_id=? AND subject=? AND state='active' AND exposure_revision=?").all(exposure.id, subjectId, exposure.revision) as { id: string }[])
        db.prepare("UPDATE hub_grants SET state='revoked', revision=revision+1 WHERE id=?").run(g.id);   // one live grant per person and revision
      db.prepare(`INSERT INTO hub_grants(id, revision, owner, exposure_id, exposure_revision, approved_by, approved_at, subject, permissions, starts_at, expires_at, state)
        VALUES(?,?,?,?,?,?,?,?,?,?,?, 'active')`).run(grant.id, 1, me, exposure.id, exposure.revision, me, now, subjectId, JSON.stringify(grant.permissions), grant.startsAt, grant.expiresAt);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: owner }, action: "grant.created", result: "completed",
        fleetId: exposure.fleetId, exposureId: exposure.id, ownerAtEvent: owner, grantId: grant.id, grantRevision: 1 });
      return grant;
    });
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
      db.prepare("UPDATE hub_exposures SET frozen_through=MAX(frozen_through, ?), updated_at=? WHERE id=?").run(row.revision, this.core.now(), id);
      this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person }, action: "exposure.frozen", result: "completed",
        fleetId: row.fleet_id, exposureId: id, ownerAtEvent: personFromString(row.owner) });
    });
  }
}
