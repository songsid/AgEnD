/** Optional cosmetic metadata. It never changes pairing, authority, addresses or connectivity. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteFileSync } from "../atomic-write.js";
import { readDisplay } from "./join/display.js";
import { ensurePrivateDirectory, privatePath, readPrivateFile } from "./private-files.js";
import type { HubMemberProfile } from "./profile.js";
import { hash, parseStrictJson, uuid, validated } from "./validation.js";
import { sha256 } from "./identity.js";

export const HUB_DISPLAY_NAME_PATH = "/hub/v1/display-name";
export const hubDisplayNameSchema = z.strictObject({ name: z.string().max(200) });
const savedSchema = hubDisplayNameSchema.extend({ v: z.literal(1), hubId: uuid, issuerKeyId: hash, binding: hash });
type Identity = Pick<HubMemberProfile, "issuerKeyId" | "hub" | "fleetId" | "owner">;
const path = (profile: Identity) => `hub-member/${validated(uuid, profile.hub.hubId)}/display-name.json`;
const binding = (profile: Identity) => sha256(JSON.stringify([profile.hub.hubId, profile.issuerKeyId, profile.fleetId, profile.owner.realm, profile.owner.objectId]));

export function readHubDisplayName(home: string, profile: Identity): string | null {
  try {
    const saved = validated(savedSchema, parseStrictJson(readPrivateFile(home, path(profile), 4096)));
    if (saved.hubId === profile.hub.hubId && saved.issuerKeyId === profile.issuerKeyId && saved.binding === binding(profile)) return saved.name || null;
  } catch { /* Missing, unreadable or invalid optional display data never holds the member. */ }
  return readDisplay(home, profile.hub.hubId)?.hubName || null;
}

export function saveHubDisplayName(home: string, profile: Identity, input: unknown, current: () => boolean): void {
  const value = validated(savedSchema, { ...validated(hubDisplayNameSchema, input), v: 1, hubId: profile.hub.hubId, issuerKeyId: profile.issuerKeyId, binding: binding(profile) });
  if (!current()) return;
  const suffix = path(profile);
  ensurePrivateDirectory(home, `hub-member/${value.hubId}`);
  if (existsSync(join(home, suffix))) privatePath(home, suffix);
  atomicWriteFileSync(join(home, suffix), JSON.stringify(value), { mode: 0o600, beforeRename: () => { if (!current()) throw Error("Hub display source changed"); } });
}
