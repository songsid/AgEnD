/** Explicit role metadata read. This never assigns a content auditor or opens an encrypted payload. */
import { z } from "zod";
import type { HubCore } from "../http/core.js";
import type { HubAuditRecord, HubRequestContext } from "../types.js";
import { epoch, HubProtocolError, identifier, person, uuid, validated } from "../validation.js";

const scopeSchema = z.strictObject({ exposureId: uuid.optional(), after: epoch.optional() });
const actorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person"), person }),
  z.strictObject({ kind: z.literal("member"), fleetId: identifier }),
  z.strictObject({ kind: z.literal("local-host") }),
]);
const rowSchema = z.strictObject({ id: identifier, sequence: epoch, at: epoch, actor: z.string().max(2048),
  action: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/), result: z.enum(["allowed", "denied", "held", "completed"]),
  policy_version: epoch, fleet_id: identifier.nullable(), exposure_id: identifier.nullable(), owner_at_event: z.string().max(256).nullable() });
export type HubAuditMetadata = Readonly<Pick<HubAuditRecord, "id" | "sequence" | "at" | "actor" | "action" | "result" | "policyVersion" | "fleetId" | "exposureId" | "ownerAtEvent">>;
export const HUB_ROLE_AUDIT_PAGE = 500;
export const HUB_ROLE_AUDIT_FEATURE = "role-audit-metadata-v1";

function metadata(input: unknown): HubAuditMetadata {
  try {
    const row = rowSchema.parse(input), actor = actorSchema.parse(JSON.parse(row.actor));
    if (actor.kind === "person") Object.freeze(actor.person);
    let ownerAtEvent: z.infer<typeof person> | undefined;
    if (row.owner_at_event !== null) {
      const parts = row.owner_at_event.split("/");
      if (parts.length !== 2) throw new HubProtocolError("unavailable");
      ownerAtEvent = Object.freeze(validated(person, { realm: parts[0], objectId: parts[1] }));
    }
    return Object.freeze({ id: row.id, sequence: row.sequence, at: row.at, actor: Object.freeze(actor), action: row.action, result: row.result,
      policyVersion: row.policy_version, ...(row.fleet_id !== null ? { fleetId: row.fleet_id } : {}),
      ...(row.exposure_id !== null ? { exposureId: row.exposure_id } : {}), ...(ownerAtEvent ? { ownerAtEvent } : {}) });
  } catch { throw new HubProtocolError("unavailable"); }
}

export async function readHubRoleAudit(core: HubCore, ctx: HubRequestContext, input: z.input<typeof scopeSchema>) {
  const scope = Object.freeze(validated(scopeSchema, input)), permit = await core.management(ctx, "audit.view");
  // A legacy configured root is not implicitly a Hub-wide metadata auditor before role cutover.
  if (!("source" in permit) || permit.source !== "roles") throw new HubProtocolError("not-found");
  const records = core.atomic((db, tx) => {
    core.audit(tx, { requestId: ctx.requestId, actor: { kind: "person", person: permit.actor.person }, action: "audit.metadata-read", result: "completed",
      ...(scope.exposureId ? { exposureId: scope.exposureId } : {}) });
    const where: string[] = [], args: (string | number)[] = [];
    if (scope.exposureId !== undefined) { where.push("exposure_id=?"); args.push(scope.exposureId); }
    if (scope.after !== undefined) { where.push("sequence>?"); args.push(scope.after); }
    const rows = db.prepare(`SELECT id,sequence,at,actor,action,result,policy_version,fleet_id,exposure_id,owner_at_event FROM hub_audit
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY sequence LIMIT ?`).all(...args, HUB_ROLE_AUDIT_PAGE);
    return Object.freeze(rows.map(metadata));
  }, permit);
  permit.assertCurrent(); return Object.freeze({ records, assertCurrent: () => permit.assertCurrent() });
}
