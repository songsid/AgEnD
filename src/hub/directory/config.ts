/**
 * Hub directory configuration (`hub.directory`), validated before any connection is made. The checks are the security
 * contract of S-43: credentials only ever travel over verified LDAPS (decision 7e5b8a8f: LDAPS only, so ldap:// and
 * StartTLS are refused), there is no switch to turn certificate verification off, and unknown keys are refused so one
 * cannot be smuggled in.
 */
import { isIP } from "node:net";

export type DirectoryProfile = "ad" | "openldap";

export interface HubDirectoryConfig {
  /** A short, stable name for this directory; it is the first half of every person key. */
  realm: string;
  /** ldaps://host[:port]. Nothing else: ldap:// (even with StartTLS) is refused. */
  url: string;
  /** PEM text of the CA(s) that issued the directory's certificate. Omitted: Node's built-in roots. */
  caPem?: string;
  /** Where people are searched for. */
  baseDn: string;
  /** The read-only service account the Hub searches with. Its password is passed separately as a secret. */
  bindDn: string;
  /** A reference to the service account's password in the Hub's secret store; resolved by the caller (S5), never here. */
  bindPasswordRef?: string;
  profile: DirectoryProfile;
  /** Defaults per profile: sAMAccountName (ad), uid (openldap). */
  loginAttribute?: string;
  /** An extra RFC 4515 filter ANDed with the login match, e.g. "(objectClass=person)". */
  userFilter?: string;
  /** Per-operation and connect timeout, 500–30000 ms (default 5000). */
  timeoutMs?: number;
}

export interface ResolvedDirectoryConfig {
  readonly realm: string;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly caPem?: string;
  readonly baseDn: string;
  readonly bindDn: string;
  readonly profile: DirectoryProfile;
  readonly loginAttribute: string;
  readonly userFilter: string;
  readonly timeoutMs: number;
}

export class HubDirectoryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubDirectoryConfigError";
  }
}

const KNOWN_KEYS = new Set(["realm", "url", "caPem", "bindPasswordRef", "baseDn", "bindDn", "profile", "loginAttribute", "userFilter", "timeoutMs"]);
// A stable configured id (never a display name), no slash: it is the first half of "<realm>/<objectId>".
const REALM = /^[a-z][a-z0-9_-]{0,63}$/;
const ATTRIBUTE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
// Printable, no NUL/newlines; a DN is checked for shape only, the directory judges the rest.
const DN = /^[^\u0000-\u001f\u007f]{1,1024}$/;

const DEFAULT_FILTER: Record<DirectoryProfile, string> = {
  ad: "(&(objectClass=person)(!(objectClass=computer)))",
  openldap: "(objectClass=person)",
};
const DEFAULT_LOGIN: Record<DirectoryProfile, string> = { ad: "sAMAccountName", openldap: "uid" };

function fail(message: string): never {
  throw new HubDirectoryConfigError(message);
}

export function resolveDirectoryConfig(input: unknown): ResolvedDirectoryConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("hub directory: the configuration must be an object");
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) fail(`hub directory: unknown setting "${key}" (certificate verification cannot be turned off)`);
  }
  const str = (key: string, required: boolean): string | undefined => {
    const v = raw[key];
    if (v === undefined && !required) return undefined;
    if (typeof v !== "string" || v.length === 0) fail(`hub directory: "${key}" must be a non-empty string`);
    return v;
  };

  const realm = str("realm", true)!;
  if (!REALM.test(realm)) fail('hub directory: "realm" must be a lowercase id: a letter, then letters, digits, "_" or "-" (64 at most)');

  const profile = str("profile", true)!;
  if (profile !== "ad" && profile !== "openldap") fail('hub directory: "profile" must be "ad" or "openldap"');

  const urlText = str("url", true)!;
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    fail('hub directory: "url" is not a URL');
  }
  if (url.username || url.password) fail('hub directory: "url" must not carry credentials');
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) fail('hub directory: "url" must be scheme://host[:port] only');
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!host) fail('hub directory: "url" has no host');

  // LDAPS only (decision 7e5b8a8f). ldap:// is plaintext until upgraded, and StartTLS is not offered as a mode in P1.
  if (url.protocol === "ldap:") fail("hub directory: ldap:// is plaintext and is not supported; use ldaps://");
  if (url.protocol !== "ldaps:") fail('hub directory: "url" must start with ldaps://');
  const port = url.port ? Number(url.port) : 636;

  const caPem = str("caPem", false);
  if (caPem !== undefined && !/-----BEGIN CERTIFICATE-----/.test(caPem)) fail('hub directory: "caPem" must hold PEM certificate text');

  if (raw.bindPasswordRef !== undefined) str("bindPasswordRef", false);

  const baseDn = str("baseDn", true)!;
  const bindDn = str("bindDn", true)!;
  if (!DN.test(baseDn)) fail('hub directory: "baseDn" has control characters or is too long');
  if (!DN.test(bindDn)) fail('hub directory: "bindDn" has control characters or is too long');

  const loginAttribute = str("loginAttribute", false) ?? DEFAULT_LOGIN[profile];
  if (!ATTRIBUTE.test(loginAttribute)) fail('hub directory: "loginAttribute" must be an attribute name');

  const extra = str("userFilter", false);
  if (extra !== undefined && !/^\(.*\)$/s.test(extra)) fail('hub directory: "userFilter" must be a parenthesised LDAP filter');
  const userFilter = extra ?? DEFAULT_FILTER[profile];

  const timeoutRaw = raw.timeoutMs;
  if (timeoutRaw !== undefined && (typeof timeoutRaw !== "number" || !Number.isInteger(timeoutRaw) || timeoutRaw < 500 || timeoutRaw > 30_000)) {
    fail('hub directory: "timeoutMs" must be a whole number from 500 to 30000');
  }
  const timeoutMs = (timeoutRaw as number | undefined) ?? 5000;

  return Object.freeze({
    realm,
    host,
    port,
    url: `ldaps://${isIP(host) === 6 ? `[${host}]` : host}:${port}`,
    ...(caPem !== undefined ? { caPem } : {}),
    baseDn,
    bindDn,
    profile,
    loginAttribute,
    userFilter,
    timeoutMs,
  });
}
