/** Protected local operation records. A profile alone is never a company-join binding. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readPrivateFile } from "../private-files.js";
import { epoch, hash, uuid, parseStrictJson, validated } from "../validation.js";
import { joinBindingSchema, verifierSchema } from "./protocol.js";
import { createJoinPrivate, writeJoinPrivate } from "./private.js";
export interface JoinLocalSession {
  readonly ownerKey: object; readonly sessionId: string; readonly authorityEpoch: number; readonly hostHere: boolean; readonly fleetOrigin?: string;
  current(): boolean;
}
export interface JoinLocalAuthority { session: JoinLocalSession; confirmedCurrent(): boolean }
export const localJoinSnapshotSchema = z.strictObject({ membership: z.boolean(), binding: hash.nullable() });
export type JoinLocalSnapshot = z.infer<typeof localJoinSnapshotSchema>;
const journalSchema = z.strictObject({ v: z.literal(1), operationId: uuid, handoffId: uuid, binding: joinBindingSchema,
  privateKey: z.string().max(2048), verifier: verifierSchema, browserState: hash, certificatePem: z.string().max(16 * 1024),
  sessionId: hash, authorityEpoch: epoch, hostConfirmed: z.boolean(), snapshot: localJoinSnapshotSchema,
  createdAt: epoch, deadline: epoch, stage: z.enum(["preparing", "pending", "durable", "active", "held", "cancelled", "ended"]),
  reason: z.string().max(64).nullable(), issued: z.boolean(), outcomeKnown: z.boolean(), issuedHash: hash.nullable(),
  profileDigest: hash.nullable(), intendedBinding: hash.nullable(), enableIntent: z.boolean(), journalCommitId: uuid, remoteState: z.string().max(64).nullable() });
export type LocalJoinJournal = z.infer<typeof journalSchema>;
export const localJoinPath = (id: string) => `hub-member/company-joins/${validated(uuid, id)}.json`;
export function readLocalJoin(home: string, id: string): LocalJoinJournal {
  const record = validated(journalSchema, parseStrictJson(readPrivateFile(home, localJoinPath(id), 48 * 1024)));
  if (record.operationId !== id || record.binding.operationId !== id || record.deadline > record.createdAt + 600_000) throw Error("Join journal differs");
  return record;
}
export function saveLocalJoin(home: string, input: LocalJoinJournal, current: () => boolean): void {
  const record = validated(journalSchema, input);
  writeJoinPrivate(home, localJoinPath(record.operationId), JSON.stringify(record), current);
}
export function createLocalJoin(home: string, input: LocalJoinJournal, current: () => boolean): void {
  if (!current()) throw Error("Join operation changed");
  const record = validated(journalSchema, input);
  createJoinPrivate(home, localJoinPath(record.operationId), JSON.stringify(record));
  if (!current()) throw Error("Join operation changed");
}
export interface CompanyBindingMarker { operationId: string; profileDigest: string; journalCommitId: string }
export function companyBindingSettled(home: string, marker: CompanyBindingMarker, hubId: string, profileDigest: string | null): boolean {
  try {
    if (!marker || profileDigest === null || marker.profileDigest !== profileDigest) return false;
    const r = readLocalJoin(home, marker.operationId);
    return r.stage === "active" && r.binding.hub.hubId === hubId && r.profileDigest === profileDigest && r.journalCommitId === marker.journalCommitId;
  } catch { return false; }
}
export function currentLocalJoinId(home: string): string | null {
  const path = "hub-member/company-join-current.json";
  if (!existsSync(join(home, path))) return null;
  return validated(z.strictObject({ v: z.literal(1), operationId: uuid }), parseStrictJson(readPrivateFile(home, path, 512))).operationId;
}
export function selectLocalJoin(home: string, id: string, current: () => boolean): void {
  const path = "hub-member/company-join-current.json", value = JSON.stringify({ v: 1, operationId: validated(uuid, id) });
  if (!current()) throw Error("Join operation changed");
  if (existsSync(join(home, path))) writeJoinPrivate(home, path, value, current); else createJoinPrivate(home, path, value);
}
