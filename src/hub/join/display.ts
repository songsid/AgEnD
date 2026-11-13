/**
 * M-2921 (Hub UX U1): what the Fleet shows about a Hub connection — never authority. At start: the Hub address and the
 * label this Fleet joined under (a reconnect starts again with them); at redeem: the Hub's display name and the owner's
 * label, when the Hub sends them (S1.3, asked for with X-AgEnD-Join-Display). Kept beside, not inside, the profile and the
 * join journal, so neither format changes; a missing or unreadable record only hides a line on the card.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseStrictJson, validated, uuid } from "../validation.js";
import { ensurePrivateDirectory, readPrivateFile } from "../private-files.js";
import { createJoinPrivate, writeJoinPrivate } from "./private.js";

const DIR = "hub-member/company-display";
export const companyDisplaySchema = z.strictObject({ v: z.literal(1), webOrigin: z.string().max(2048), label: z.string().max(120),
  hubName: z.string().max(200).nullable(), ownerLabel: z.string().max(200).nullable() });
export type CompanyDisplay = z.infer<typeof companyDisplaySchema>;
const idSchema = z.string().regex(/^[0-9a-f-]{36}$/);

function save(home: string, suffix: string, value: CompanyDisplay): void {
  ensurePrivateDirectory(home, DIR);
  const text = JSON.stringify(validated(companyDisplaySchema, value));
  if (existsSync(join(home, suffix))) writeJoinPrivate(home, suffix, text, () => true); else createJoinPrivate(home, suffix, text);
}
function read(home: string, suffix: string): CompanyDisplay | null {
  try { return existsSync(join(home, suffix)) ? validated(companyDisplaySchema, parseStrictJson(readPrivateFile(home, suffix, 8192))) : null; } catch { return null; }
}
/** At start: the address and label of this operation. */
export function saveStartDisplay(home: string, operationId: string, webOrigin: string, label: string): void {
  save(home, `${DIR}/op-${validated(uuid, operationId)}.json`, { v: 1, webOrigin, label, hubName: null, ownerLabel: null });
}
/** At redeem: this Hub's record — the operation's address and label, and the Hub's display fields (absent: null). */
export function settleDisplay(home: string, operationId: string, hubId: string, extras: { hubName?: string; ownerLabel?: string }): void {
  const start = read(home, `${DIR}/op-${validated(uuid, operationId)}.json`);
  if (!start) return;
  save(home, `${DIR}/${validated(idSchema, hubId)}.json`, { ...start, hubName: extras.hubName ?? null, ownerLabel: extras.ownerLabel ?? null });
}
/** This Hub's record, or null. */
export function readDisplay(home: string, hubId: string): CompanyDisplay | null {
  try { return read(home, `${DIR}/${validated(idSchema, hubId)}.json`); } catch { return null; }
}
