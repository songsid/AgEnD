/** Explicit owner choice after a NEW share. Never called by refresh, publication, request polling or Undo. */
import { z } from "zod";
import { HubAgentCatalogs } from "./agent-catalog.js";
import { readExposure } from "./catalog.js";
import { canonicalArguments, personKeyString, sha256 } from "./identity.js";
import { HubGroupAuthorizationError } from "./group-policy/authorization.js";
import { HubProtocolError, hash, uuid, validated } from "./validation.js";
import type { HubCore } from "./http/core.js";
import type { HubRequestContext } from "./types.js";
import type { RetainedGrant, StoppedImage } from "./sharing-retention.js";
interface Kept { owner: string; fleet_id: string; generation: number; revision: number; expires_at: number; image: string; grants: string; digest: string }
const inputSchema = z.strictObject({ revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), digest: hash });
export class HubPreviousAccess {
  constructor(private readonly core: HubCore, private readonly catalogs: HubAgentCatalogs) {}
  private read(id: string, owner: string) {
    return this.core.atomic(db => {
      const exposure = readExposure(db, id);
      if (!exposure || exposure.owner !== owner || !exposure.fleet_id || exposure.source_kind === "personal") throw new HubProtocolError("not-found");
      const fleet = this.core.deps.store.read().fleets.find(f => f.id === exposure.fleet_id && f.status === "active" && personKeyString(f.owner) === owner);
      if (!fleet) throw new HubProtocolError("not-found");
      const kept = db.prepare("SELECT * FROM hub_stopped_ask_lists WHERE exposure_id=?").get(id) as Kept | undefined;
      if (!kept || kept.owner !== owner || kept.fleet_id !== fleet.id || kept.generation !== fleet.generation || this.core.now() >= kept.expires_at) return { exposure, previous: null };
      if (sha256(canonicalArguments([kept.image, kept.grants])) !== kept.digest) throw new HubProtocolError("unavailable");
      const before = JSON.parse(kept.image) as StoppedImage["exposure"];
      if (before.id !== id || before.owner !== owner || before.revision !== kept.revision || before.frozen_through >= before.revision) return { exposure, previous: null };
      const grants = (JSON.parse(kept.grants) as RetainedGrant[]).filter(g => g.state === "active" && g.owner === owner && g.exposure_id === id && g.exposure_revision === kept.revision && g.expires_at > this.core.now());
      return { exposure, previous: grants.length ? { kept, grants } : null };
    });
  }
  async view(ctx: HubRequestContext, id: string) {
    validated(uuid, id); const browser = await this.catalogs.owner(ctx);
    const value = this.read(id, personKeyString(browser.person)); browser.assertCurrent();
    return { exposureId: id, revision: value.exposure.revision, previous: value.previous ? {
      digest: value.previous.kept.digest, expiresAt: value.previous.kept.expires_at, count: value.previous.grants.length,
      peopleCount: value.previous.grants.every(g => g.subject_kind === "person") ? value.previous.grants.length : null,
    } : null };
  }
  async use(ctx: HubRequestContext, id: string, value: unknown) {
    validated(uuid, id); const input = validated(inputSchema, value), browser = await this.catalogs.owner(ctx), owner = personKeyString(browser.person);
    const groups = this.core.deps.groups;
    let permit: { assertCurrent(): void } | null = null;
    if (groups) try {
      permit = await groups.prepareEnrollment({ kind: "exposure", id, revision: input.revision, owner: browser.person },
        { requestId: ctx.requestId, current: () => { try { browser.assertCurrent(); return true; } catch { return false; } } });
    } catch (error) { throw new HubProtocolError(error instanceof HubGroupAuthorizationError && error.reason === "denied" ? "denied" : "unavailable"); }
    return this.core.atomic((db, tx) => {
      browser.assertCurrent(); permit?.assertCurrent();
      if (this.core.deps.groups !== groups) throw new HubProtocolError("unavailable");
      const { exposure, previous } = this.read(id, owner);
      if (!previous || exposure.revision <= previous.kept.revision || exposure.revision !== input.revision || previous.kept.digest !== input.digest) throw new HubProtocolError("conflict");
      if (exposure.state !== "published" || exposure.frozen_through >= exposure.revision || exposure.sharing_paused) throw new HubProtocolError("denied");
      let count = 0;
      for (const grant of previous.grants) {
        // Stable new ID makes uncertain retries recover without re-enabling a subsequently revoked grant.
        const h = sha256(canonicalArguments([id, exposure.revision, previous.kept.digest, grant.id]));
        const freshId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
        if (db.prepare("SELECT 1 FROM hub_grants WHERE id=?").get(freshId)) continue;
        // A normal intervening edit wins; never replace an owner's more recent choice.
        if (db.prepare("SELECT 1 FROM hub_grants WHERE exposure_id=? AND exposure_revision=? AND subject=? AND subject_kind=? AND state='active'").get(id, exposure.revision, grant.subject, grant.subject_kind)) continue;
        db.prepare(`INSERT INTO hub_grants(id,revision,owner,exposure_id,exposure_revision,approved_by,approved_at,subject,subject_kind,subject_label,permissions,starts_at,expires_at,state)
          VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,'active')`).run(freshId, owner, id, exposure.revision, owner, this.core.now(), grant.subject, grant.subject_kind, grant.subject_label, grant.permissions, Math.max(this.core.now(), grant.starts_at), grant.expires_at);
        count++;
      }
      if (count) this.core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: browser.person }, action: "grant.previous-list-selected", result: "completed", exposureId: id, ownerAtEvent: browser.person });
      return { count };
    });
  }
}
