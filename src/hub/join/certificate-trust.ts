/** Web certificate pins are Fleet-local and separate from the Hub's member/issuer identity. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { hubOrigin } from "../tls.js";
import { sha256 } from "../identity.js";
import { hash, validated, parseStrictJson, HubProtocolError } from "../validation.js";
import { readPrivateFile } from "../private-files.js";
import { createJoinPrivate, writeJoinPrivate } from "./private.js";
export const pilotTrustChoice = z.strictObject({ fingerprint: hash, previous: hash.nullable() });
export type PilotTrustChoice = z.infer<typeof pilotTrustChoice>;
const recordSchema = z.strictObject({ v: z.literal(1), origin: z.string(), fingerprint: hash });
export class CompanyCertificateTrust {
  constructor(private readonly home: string) {}
  private path(origin: string) { return `hub-member/web-certificate-trust/${sha256(hubOrigin(origin))}.json`; }
  read(origin: string): string | null {
    const path = this.path(origin);
    if (!existsSync(join(this.home, path))) return null;
    const record = validated(recordSchema, parseStrictJson(readPrivateFile(this.home, path, 2048)));
    if (record.origin !== hubOrigin(origin)) throw new HubProtocolError("unavailable");
    return record.fingerprint;
  }
  save(origin: string, choice: PilotTrustChoice, current: () => boolean): void {
    const selected = validated(pilotTrustChoice, choice), path = this.path(origin);
    const unchanged = () => current() && this.read(origin) === selected.previous;
    if (!unchanged()) throw new HubProtocolError("stale");
    const bytes = JSON.stringify({ v: 1, origin: hubOrigin(origin), fingerprint: selected.fingerprint });
    if (selected.previous === null) createJoinPrivate(this.home, path, bytes);
    else writeJoinPrivate(this.home, path, bytes, unchanged);
    if (!current()) throw new HubProtocolError("stale");
  }
}
