/** Historical cutover evidence, independent of current role edits and retained audit rows. */
import { z } from "zod";
import { epoch, hash, identifier, person, uuid, validated, parseStrictJson, HubProtocolError } from "../validation.js";
import { sha256 } from "../identity.js";
import { parseGroupPolicy } from "../group-policy/model.js";
import { convertGroupPolicy } from "./convert.js";
const part = z.strictObject({ name: identifier, rows: epoch, digest: hash });
export const hubRoleCutoverMarkerSchema = z.strictObject({
  v: z.literal(1), hubId: uuid, realm: person.shape.realm, generation: identifier, root: person, at: epoch,
  oldRaw: z.string().max(256 * 1024), oldDigest: hash, roleDigest: hash, fromRevision: epoch,
  transportRevision: epoch, authorizationVersion: epoch,
  inventory: z.strictObject({ digest: hash, tables: z.array(part).max(64) }), auditId: uuid,
});
export function parseHubRoleCutoverMarker(raw: string, hubId: string) {
  const marker = validated(hubRoleCutoverMarkerSchema, parseStrictJson(raw, 512 * 1024));
  const old = parseGroupPolicy(parseStrictJson(marker.oldRaw));
  const converted = convertGroupPolicy(old, { root: marker.root, now: marker.at, rolesActive: true });
  if (marker.hubId !== hubId || marker.root.realm !== marker.realm || old.realm !== marker.realm
    || old.generation !== marker.generation || old.revision !== marker.fromRevision
    || marker.oldDigest !== sha256(marker.oldRaw) || marker.roleDigest !== sha256(JSON.stringify(converted))
    || marker.inventory.digest !== sha256(JSON.stringify(marker.inventory.tables))
    || marker.transportRevision < 1 || marker.authorizationVersion < 1) throw new HubProtocolError("unavailable");
  return { raw, marker };
}
