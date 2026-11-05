/**
 * How each directory flavour names the things the Hub needs: the immutable object id, the login, and "disabled".
 *
 * - ad: objectGUID (16 bytes; shown in the usual mixed-endian GUID text form), sAMAccountName, userAccountControl bit 2
 *   (ACCOUNTDISABLE) and accountExpires (FILETIME; 0 and 0x7FFFFFFFFFFFFFFF mean never).
 * - openldap: entryUUID (RFC 4530), uid, and the ppolicy administrative lock (pwdAccountLockedTime 000001010000Z).
 *   A temporary password lockout is left to the server, which refuses the bind while it lasts.
 */
import type { DirectoryProfile } from "./config.js";

export interface ProfileShape {
  readonly idAttribute: string;
  /** Attributes the search must return as raw bytes. */
  readonly binaryAttributes: readonly string[];
  readonly departmentAttribute: string;
  readonly statusAttributes: readonly string[];
}

export const PROFILES: Record<DirectoryProfile, ProfileShape> = {
  ad: { idAttribute: "objectGUID", binaryAttributes: ["objectGUID"], departmentAttribute: "department", statusAttributes: ["userAccountControl", "accountExpires"] },
  openldap: { idAttribute: "entryUUID", binaryAttributes: [], departmentAttribute: "departmentNumber", statusAttributes: ["pwdAccountLockedTime"] },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isCanonicalObjectId(value: string): boolean {
  return UUID.test(value);
}

/** objectGUID bytes → the GUID text AD tools show (first three groups little-endian), lowercase. */
export function guidBytesToString(bytes: Uint8Array): string | undefined {
  if (bytes.length !== 16) return undefined;
  const h = (i: number) => bytes[i]!.toString(16).padStart(2, "0");
  const order = [3, 2, 1, 0, -1, 5, 4, -1, 7, 6, -1, 8, 9, -1, 10, 11, 12, 13, 14, 15];
  return order.map((i) => (i < 0 ? "-" : h(i))).join("");
}

/** The inverse of guidBytesToString. */
export function guidStringToBytes(guid: string): Buffer | undefined {
  if (!UUID.test(guid)) return undefined;
  const hex = guid.replace(/-/g, "");
  const b = Buffer.from(hex, "hex");
  return Buffer.from([b[3]!, b[2]!, b[1]!, b[0]!, b[5]!, b[4]!, b[7]!, b[6]!, ...b.subarray(8)]);
}

/** RFC 4515 assertion-value escaping for text. */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\u0000]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/**
 * The equality match that finds exactly the entry with this object id. A binary objectGUID is matched with its raw
 * bytes in a filter object: ldapts turns "\xx" escapes in a filter string into characters and re-encodes them as
 * UTF-8, which changes every byte above 0x7f, so an escaped string would never match.
 */
export function objectIdMatch(profile: DirectoryProfile, objectId: string): { attribute: string; value: string | Buffer } | undefined {
  if (!isCanonicalObjectId(objectId)) return undefined;
  if (profile === "ad") {
    const bytes = guidStringToBytes(objectId);
    return bytes ? { attribute: "objectGUID", value: bytes } : undefined;
  }
  return { attribute: "entryUUID", value: objectId };
}

type Values = string | Buffer | readonly (string | Buffer)[] | undefined;

function first(v: Values): string | Buffer | undefined {
  return Array.isArray(v) ? v[0] : (v as string | Buffer | undefined);
}

/** The entry's canonical object id, or undefined when it is missing or malformed (the entry is then refused). */
export function readObjectId(profile: DirectoryProfile, entry: Record<string, Values>): string | undefined {
  const raw = first(entry[PROFILES[profile].idAttribute]);
  if (profile === "ad") return Buffer.isBuffer(raw) ? guidBytesToString(raw) : undefined;
  if (typeof raw !== "string") return undefined;
  const id = raw.toLowerCase();
  return isCanonicalObjectId(id) ? id : undefined;
}

const NEVER_EXPIRES = 0x7fffffffffffffffn;
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000n;

/** True when the directory marks the account disabled or expired. Unparseable status counts as disabled. */
export function isDisabled(profile: DirectoryProfile, entry: Record<string, Values>, nowMs: number): boolean {
  if (profile === "ad") {
    const uacText = first(entry.userAccountControl);
    if (typeof uacText !== "string" || !/^-?\d{1,10}$/.test(uacText)) return true; // AD always has it: missing = refuse
    if ((Number(uacText) & 0x2) !== 0) return true;
    const exp = first(entry.accountExpires);
    if (exp === undefined) return false;
    if (typeof exp !== "string" || !/^-?\d{1,20}$/.test(exp)) return true;
    const ft = BigInt(exp);
    if (ft === 0n || ft === NEVER_EXPIRES) return false;
    const expiresMs = ft / 10_000n - FILETIME_EPOCH_OFFSET_MS;
    return expiresMs <= BigInt(Math.floor(nowMs));
  }
  const locked = entry.pwdAccountLockedTime;
  const values = (Array.isArray(locked) ? locked : locked === undefined ? [] : [locked]) as (string | Buffer)[];
  return values.some((v) => String(v) === "000001010000Z");
}

export function readText(entry: Record<string, Values>, attribute: string): string | undefined {
  const v = first(entry[attribute]);
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function readTextList(entry: Record<string, Values>, attribute: string): string[] {
  const v = entry[attribute];
  const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return list.filter((x): x is string => typeof x === "string");
}
