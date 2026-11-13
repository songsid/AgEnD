/**
 * The Hub's directory client (S-43). Every operation opens its own connection, proves it is verified TLS before any
 * bind, and closes it; nothing is cached, so each Hub request sees the directory's current answer (design #3095 §4).
 *
 * Transport rules:
 * - ldaps:// only (decision 7e5b8a8f); the certificate is verified against the configured CA (or Node's roots) and the
 *   host name, always. A plain ldap:// socket is never created: createConnection refuses outright.
 * - One TLS connection per client. ldapts would otherwise reconnect transparently after a drop; every operation is a
 *   fresh session instead, and a bind is sent only on the verified socket this session opened.
 * - The library is imported lazily, so it never loads while the Hub is off.
 *
 * Passwords: the user's password is used for exactly one bind and is never stored, logged or returned. An empty
 * password is refused before the network (to LDAP it would be an unauthenticated bind that "succeeds").
 */
import { isIP } from "node:net";
import { X509Certificate } from "node:crypto";
import { AD_EXTENDED_DN, extendedGroupIds, type DirectoryFailure, type PolicyGroupLookup, type PolicyGroupFacts, type PolicyGroupSearch } from "./groups.js";
import * as net from "node:net";
import * as tls from "node:tls";
import type { Client as LdapClient, Control, Entry, Filter } from "ldapts";
import { HubDirectoryConfigError, resolveDirectoryConfig, type ResolvedDirectoryConfig } from "./config.js";
import { PROFILES, escapeFilterValue, isDisabled, objectIdMatch, readObjectId, readText, readTextList } from "./profiles.js";
import type { DirectoryPerson, DirectoryLookupResult, Eligibility, HubDirectory, InitializationLookupResult, PersonKey, SignInResult, RoomGroupRoster } from "./types.js";

export interface HubDirectorySecrets {
  /** The service account's password (resolved by the caller from the Hub's secret store). */
  readonly bindPassword: string;
}

export interface HubDirectoryDiagnostic {
  readonly op: "sign-in" | "eligibility" | "initialization-lookup" | "pairing-owner-lookup" | "grant-recipient-lookup" | "group-lookup" | "group-membership" | "group-search" | "person-search" | "room-group-members";
  readonly outcome: string;
  /** The underlying error's message, for the technical log. Never contains a password. */
  readonly error?: string;
  /** M-2724: for a group call, which step failed. */
  readonly failure?: DirectoryFailure;
}

export interface HubDirectoryOptions {
  /** Called once per refused or failed operation. */
  readonly onDiagnostic?: (event: HubDirectoryDiagnostic) => void;
  /** Test seam for expiry checks. */
  readonly now?: () => number;
  /** Internal settings proof only: normal TLS checks PLUS the exact leaf confirmed for a changed target/trust. */
  readonly expectedServerFingerprint?: string;
}

class InsecureTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsecureTransportError";
  }
}

/** Compare base RDN boundaries, tolerating formatting after commas without splitting escaped commas. */
function withinGroupBase(dn: string, base: string): boolean {
  const parts = (text: string): string[] => {
    const out: string[] = []; let part = "", escaped = false;
    for (const c of text) {
      if (c === "," && !escaped) { out.push(part.trimStart().toLowerCase()); part = ""; }
      else part += c;
      escaped = c === "\\" && !escaped;
    }
    out.push(part.trimStart().toLowerCase()); return out;
  };
  const child = parts(dn), parent = parts(base);
  return child.length > parent.length && parent.every((rdn, i) => rdn.length > 0 && child[child.length - parent.length + i] === rdn);
}

type Ldapts = typeof import("ldapts");
let ldaptsModule: Promise<Ldapts> | undefined;
function loadLdapts(): Promise<Ldapts> {
  ldaptsModule ??= import("ldapts");
  return ldaptsModule;
}

const LOGIN_MAX = 256;
const PASSWORD_MAX = 1024;
// A login is matched by the directory, not parsed by us; refuse only what can never be a login.
const LOGIN_SHAPE = /^[^\u0000-\u001f\u007f\s](?:[^\u0000-\u001f\u007f]*[^\u0000-\u001f\u007f\s])?$/;

function validLogin(login: unknown): login is string {
  return typeof login === "string" && login.length > 0 && login.length <= LOGIN_MAX && LOGIN_SHAPE.test(login);
}

function validPassword(password: unknown): password is string {
  return typeof password === "string" && password.length > 0 && password.length <= PASSWORD_MAX && !password.includes("\u0000");
}

/** One verified-TLS LDAP connection that refuses to reconnect. */
class Session {
  private connections = 0;
  private tlsSocket: tls.TLSSocket | undefined;

  private constructor(
    private readonly cfg: ResolvedDirectoryConfig,
    readonly client: LdapClient,
  ) {}

  static async open(cfg: ResolvedDirectoryConfig, expectedServerFingerprint?: string): Promise<Session> {
    const { Client } = await loadLdapts();
    let session: Session | undefined;
    const tlsOptions = (): tls.ConnectionOptions => ({
      ...(cfg.caPem !== undefined ? { ca: cfg.caPem } : {}),
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      host: cfg.host,
      ...(isIP(cfg.host) ? {} : { servername: cfg.host }),
      checkServerIdentity: (name, cert) => {
        const error = tls.checkServerIdentity(name, cert);
        if (error) return error;
        if (expectedServerFingerprint && (!cert.raw || new X509Certificate(cert.raw).fingerprint256.replace(/:/g, "").toUpperCase() !== expectedServerFingerprint)) {
          return new InsecureTransportError("hub directory: the confirmed server certificate changed");
        }
        return undefined;
      },
    });
    const client = new Client({
      url: cfg.url,
      timeout: cfg.timeoutMs,
      connectTimeout: cfg.timeoutMs,
      strictDN: true,
      autoRebind: false,
      // Never a plaintext socket, whatever the URL parsing inside the library decides.
      createConnection: (() => {
        throw new InsecureTransportError("hub directory: refusing a plaintext LDAP connection");
      }) as typeof net.connect,
      // Verification settings come from here only; anything the library passes is ignored.
      createSecureConnection: (() => {
        session!.claimConnection();
        const socket = tls.connect({ ...tlsOptions(), port: cfg.port });
        session!.tlsSocket = socket;
        return socket;
      }) as typeof tls.connect,
    });
    session = new Session(cfg, client);
    return session;
  }

  private claimConnection(): void {
    this.connections += 1;
    if (this.connections > 1) throw new InsecureTransportError("hub directory: connection lost; refusing to reconnect within one operation");
  }

  /** Throws unless the live connection is the one verified TLS socket this session made. */
  private assertSecure(): void {
    const s = this.tlsSocket;
    if (!s || s.destroyed || !s.authorized || !s.encrypted || this.connections !== 1 || !this.client.isConnected) {
      throw new InsecureTransportError("hub directory: no verified TLS connection; refusing to send credentials");
    }
  }

  async bind(dn: string, password: string): Promise<void> {
    // ldapts connects lazily inside bind(): a fresh session's first bind opens the socket through
    // createSecureConnection above (verified TLS, or no connection at all), and the bind is written only after
    // 'secureConnect'. A session that already has a socket must still be on that one verified socket.
    if (this.connections > 0) this.assertSecure();
    await this.client.bind(dn, password);
    this.assertSecure();
  }

  async search(filter: string | Filter, attributes: string[], binary: readonly string[], scope: "sub" | "base" = "sub", base = this.cfg.baseDn, controls?: Control[], complete = false): Promise<Entry[]> {
    this.assertSecure();
    const { searchEntries, searchReferences } = await this.client.search(base, {
      scope,
      filter,
      attributes,
      explicitBufferAttributes: [...binary],
      sizeLimit: 2,
      derefAliases: "never",
    }, controls);
    // M-2724: AD answers every subtree search at a domain root with continuation references (its DNS-zone and Configuration
    // partitions). An entry found by objectGUID — unique in the forest — is the whole answer whatever else is referenced; only a
    // conclusion of absence (nothing found) needs a result with no part elsewhere.
    if (complete && searchReferences?.length && searchEntries.length === 0) throw new IncompleteDirectoryResult();
    return searchEntries;
  }
  async groupPrefix(q: string): Promise<Entry[]> {
    this.assertSecure();
    const literal = escapeFilterValue(q);
    const { searchEntries } = await this.client.search(this.cfg.baseDn, {
      scope: "sub", derefAliases: "never", sizeLimit: 20, timeLimit: 5,
      filter: `(&(objectCategory=group)(groupType:1.2.840.113556.1.4.803:=2147483648)(|(cn=${literal}*)(sAMAccountName=${literal}*)))`,
      attributes: ["objectGUID", "cn", "distinguishedName"], explicitBufferAttributes: ["objectGUID"],
    });
    // Suggestions never establish absence/eligibility. Continuation references are not followed.
    return searchEntries;
  }
  async personPrefix(q: string, attributes: readonly string[], binary: readonly string[]): Promise<Entry[]> {
    this.assertSecure(); const literal = escapeFilterValue(q);
    const { searchEntries } = await this.client.search(this.cfg.baseDn, {
      scope: "sub", derefAliases: "never", sizeLimit: 20, timeLimit: 5,
      filter: `(&${this.cfg.userFilter}(|(displayName=${literal}*)(cn=${literal}*)(${this.cfg.loginAttribute}=${literal}*)))`,
      attributes: [...attributes], explicitBufferAttributes: [...binary],
    });
    return searchEntries; // Feedback only; referrals are never followed or interpreted as an absence proof.
  }
  async roomMembers(dn: string, attributes: readonly string[], binary: readonly string[]): Promise<Entry[]> {
    this.assertSecure(); const entries: Entry[] = [];
    // sizeLimit=0 makes ldapts refuse SizeLimitExceeded instead of silently accepting capped entries.
    // Paging bounds each response; the deadline and total cap bound this complete snapshot operation.
    for await (const page of this.client.searchPaginated(this.cfg.baseDn, { scope: "sub", derefAliases: "never", sizeLimit: 0, timeLimit: 5,
      paged: { pageSize: 100 }, filter: `(&${this.cfg.userFilter}(memberOf=${escapeFilterValue(dn)}))`,
      attributes: [...attributes], explicitBufferAttributes: [...binary] })) {
      this.assertSecure();
      if (page.searchReferences.length || entries.length + page.searchEntries.length > 4096) throw new IncompleteDirectoryResult();
      entries.push(...page.searchEntries);
    }
    return entries;
  }
  abort(): void { this.tlsSocket?.destroy(); }

  async close(physical = false): Promise<void> {
    const socket = this.tlsSocket;
    const settled = physical && socket && !socket.closed ? new Promise<void>(resolve => socket.once("close", () => resolve())) : Promise.resolve();
    try {
      await this.client.unbind();
    } catch {
      /* already closed */
    }
    if (physical) { socket?.destroy(); await settled; }
  }
}

/** M-2724: nothing found, but part of the subtree lives elsewhere: absence is not proven. */
class IncompleteDirectoryResult extends Error { constructor() { super("incomplete group result"); this.name = "IncompleteDirectoryResult"; } }
/** M-2724: the service account's own sign-in (bind) was refused, as opposed to the connection or the lookup. */
class ServiceBindError extends Error {
  constructor(readonly cause: unknown) {
    // The cause's own words stay in the message (the technical log, and sign-in's certificate wording read it).
    super(`service account bind failed: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`); this.name = "ServiceBindError";
  }
}
const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "EPIPE"]);
const failureOfOne = (err: unknown): DirectoryFailure | undefined => {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "", name = typeof e.name === "string" ? e.name : "", message = typeof e.message === "string" ? e.message : "";
  if (/CERT|SELF_SIGNED|ALTNAME|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code) || /certificate|self.signed/i.test(message)) return "certificate";
  if (UNREACHABLE_CODES.has(code) || /timeout|timed out|connection (?:closed|lost|reset)|socket hang up/i.test(`${name} ${message}`)) return "unreachable";
  return undefined;
};
/** Which step failed (M-2724): a transport or certificate problem wins over the step it happened in. */
export function directoryFailure(err: unknown): DirectoryFailure {
  const inner = err instanceof ServiceBindError ? err.cause : err;
  const transport = failureOfOne(inner) ?? failureOfOne((inner as { cause?: unknown } | null)?.cause);
  if (transport) return transport;
  return err instanceof ServiceBindError ? "service-sign-in" : "lookup";
}

export function createHubDirectory(config: unknown, secrets: HubDirectorySecrets, options: HubDirectoryOptions = {}): HubDirectory {
  const cfg = resolveDirectoryConfig(config);
  const expectedServerFingerprint = options.expectedServerFingerprint?.replace(/:/g, "").toUpperCase();
  if (expectedServerFingerprint !== undefined && !/^[0-9A-F]{64}$/.test(expectedServerFingerprint)) throw new HubDirectoryConfigError("hub directory: invalid server fingerprint");
  if (!secrets || typeof secrets.bindPassword !== "string" || !validPassword(secrets.bindPassword)) {
    throw new HubDirectoryConfigError("hub directory: the service account password is missing");
  }
  const bindPassword = secrets.bindPassword;
  const shape = PROFILES[cfg.profile];
  const now = options.now ?? Date.now;
  const attributes = [shape.idAttribute, cfg.loginAttribute, "displayName", "cn", "mail", shape.departmentAttribute, "memberOf", ...shape.statusAttributes];
  const report = (op: HubDirectoryDiagnostic["op"], outcome: string, error?: unknown, failure?: DirectoryFailure) => {
    if (!options.onDiagnostic) return;
    const message = error instanceof Error ? `${error.name}: ${error.message}` : error === undefined ? undefined : String(error);
    try {
      options.onDiagnostic({ op, outcome, ...(message !== undefined ? { error: message } : {}), ...(failure ? { failure } : {}) });
    } catch {
      /* a diagnostic sink never changes the answer */
    }
  };

  const toPerson = (entry: Entry, objectId: string): DirectoryPerson => {
    const displayName = readText(entry, "displayName") ?? readText(entry, "cn");
    const email = readText(entry, "mail");
    const department = readText(entry, shape.departmentAttribute);
    return Object.freeze({
      key: Object.freeze({ realm: cfg.realm, objectId }),
      login: readText(entry, cfg.loginAttribute) ?? "",
      dn: entry.dn,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(department !== undefined ? { department } : {}),
      groups: Object.freeze(readTextList(entry, "memberOf")),
    });
  };

  const openService = async (selected = cfg, observe?: (session: Session) => void): Promise<Session> => {
    const session = await Session.open(selected, expectedServerFingerprint);
    observe?.(session);
    try {
      await session.bind(cfg.bindDn, bindPassword);
      return session;
    } catch (err) {
      await session.close();
      throw new ServiceBindError(err);
    }
  };

  const findById = async (session: Session, objectId: string): Promise<Entry[]> => {
    const match = objectIdMatch(cfg.profile, objectId);
    if (!match) return [];
    const { AndFilter, EqualityFilter, FilterParser } = await loadLdapts();
    const filter = new AndFilter({ filters: [FilterParser.parseString(cfg.userFilter), new EqualityFilter(match)] });
    return session.search(filter, attributes, shape.binaryAttributes);
  };

  let closed = false;

  type Selection = { ok: true; entry: Entry; objectId: string }
    | { ok: false; reason: "not-found" | "not-eligible" | "unavailable"; detail?: string };
  // Shared with sign-in so local designation never acquires a weaker identity/eligibility rule.
  const selectLogin = async (service: Session, login: string): Promise<Selection> => {
    const found = await service.search(`(&${cfg.userFilter}(${cfg.loginAttribute}=${escapeFilterValue(login)}))`, attributes, shape.binaryAttributes);
    if (closed) return { ok: false, reason: "unavailable" };
    if (found.length === 0) return { ok: false, reason: "not-found" };
    if (found.length !== 1) return { ok: false, reason: "unavailable", detail: "the login matches more than one entry" };
    const entry = found[0]!, objectId = readObjectId(cfg.profile, entry);
    if (!objectId) return { ok: false, reason: "unavailable", detail: `the entry has no usable ${shape.idAttribute}` };
    if (isDisabled(cfg.profile, entry, now())) return { ok: false, reason: "not-eligible" };
    return { ok: true, entry, objectId };
  };
  const recheck = async (service: Session, entry: Entry, objectId: string, expectedLogin?: string): Promise<InitializationLookupResult> => {
    const again = await findById(service, objectId), current = again.length === 1 ? again[0] : undefined;
    if (closed || !current || readObjectId(cfg.profile, current) !== objectId
      || current.dn.toLowerCase() !== entry.dn.toLowerCase()
      || (expectedLogin !== undefined && readText(current, cfg.loginAttribute)?.toLowerCase() !== expectedLogin.toLowerCase())) return { ok: false, reason: "unavailable" };
    if (isDisabled(cfg.profile, current, now())) return { ok: false, reason: "not-eligible" };
    return { ok: true, person: toPerson(current, objectId) };
  };

  const lookup = async (login: string, operation: "initialization-lookup" | "pairing-owner-lookup" | "grant-recipient-lookup"): Promise<DirectoryLookupResult> => {
    if (closed) return { ok: false, reason: "unavailable" };
    if (!validLogin(login)) return { ok: false, reason: "bad-input" };
    let service: Session | undefined;
    try {
      service = await openService();
      const selected = await selectLogin(service, login);
      if (!selected.ok) return { ok: false, reason: selected.reason };
      // Re-read by immutable id; a rename, deletion or replacement never retargets the selected identity.
      return await recheck(service, selected.entry, selected.objectId, login);
    } catch (err) {
      // Server-supplied exception text can repeat a login or DN; diagnostics stay bounded.
      const certificate = err instanceof Error && /certificate|self.signed|verify/i.test(err.message);
      report(operation, "unavailable", certificate ? "directory certificate verification failed" : "directory lookup failed");
      return { ok: false, reason: "unavailable" };
    } finally { await service?.close(); }
  };

  const groupSupport = cfg.profile === "ad" && cfg.port === 636;
  const securityGroup = (entry: Entry): boolean => {
    const raw = readText(entry, "groupType");
    const n = raw !== undefined && /^-?\d{1,11}$/.test(raw) ? Number(raw) : NaN;
    return Number.isInteger(n) && n >= -2147483648 && n <= 4294967295 && ((n >>> 0) & 0x80000000) !== 0;
  };
  const groupEntry = (entry: Entry, expectedId?: string) => {
    const id = readObjectId("ad", entry);
    return id && (!expectedId || id === expectedId) && securityGroup(entry) ? id : undefined;
  };

  return {
    realm: cfg.realm,
    ...(groupSupport ? { groupPolicy: "ad-direct-guid" as const } : {}),

    async searchPolicyGroups(q: string): Promise<PolicyGroupSearch> {
      if (!groupSupport) return { ok: false, reason: "unsupported" };
      if (closed || typeof q !== "string" || q.length < 2 || q.length > 64 || /[\u0000-\u001f\u007f]/.test(q)) return { ok: false, reason: "unknown" };
      let service: Session | undefined, expired = false;
      const deadline = setTimeout(() => { expired = true; service?.abort(); }, 5000); deadline.unref();
      try {
        service = await openService({ ...cfg, timeoutMs: Math.min(cfg.timeoutMs, 5000) }, current => {
          service = current;
          if (expired) { current.abort(); throw new InsecureTransportError("group search deadline"); }
        });
        if (closed || expired) return { ok: false, reason: "unknown", failure: "unreachable" };
        const entries = await service.groupPrefix(q);
        if (closed || expired || entries.length > 20) return { ok: false, reason: "unknown" };
        const groups: Array<{ objectId: string; cn: string; dn: string }> = [], seen = new Set<string>();
        for (const entry of entries) {
          const objectId = readObjectId("ad", entry), cn = readText(entry, "cn"), dn = readText(entry, "distinguishedName") ?? entry.dn;
          if (!objectId || !cn || cn.length > 256 || /[\u0000-\u001f\u007f]/.test(cn) || !dn || dn.length > 1024
            || /[\u0000-\u001f\u007f]/.test(dn) || !withinGroupBase(dn, cfg.baseDn) || seen.has(objectId)) return { ok: false, reason: "unknown" };
          seen.add(objectId); groups.push({ objectId, cn, dn });
        }
        // ldapts accepts capped size-limit replies but does not expose their status; reaching 20 is conservatively truncated.
        return { ok: true, groups, truncated: entries.length === 20 };
      } catch (err) { const failure = expired ? "unreachable" : directoryFailure(err); report("group-search", "unknown", undefined, failure); return { ok: false, reason: "unknown", failure }; }
      finally { clearTimeout(deadline); await service?.close(true); }
    },
    async roomGroupMembers(key: PersonKey): Promise<RoomGroupRoster> {
      const who = key && Object.freeze({ realm: key.realm, objectId: key.objectId });
      if (!groupSupport) return { ok: false, reason: "unsupported" };
      if (closed || !who || who.realm !== cfg.realm || !objectIdMatch("ad", who.objectId)) return { ok: false, reason: "unknown" };
      let service: Session | undefined, expired = false;
      const deadline = setTimeout(() => { expired = true; service?.abort(); }, 5000); deadline.unref();
      try {
        service = await openService({ ...cfg, timeoutMs: Math.min(cfg.timeoutMs, 5000) }, current => {
          service = current; if (expired) { current.abort(); throw new InsecureTransportError("room group deadline"); }
        });
        const { AndFilter, EqualityFilter, FilterParser } = await loadLdapts();
        const filter = new AndFilter({ filters: [FilterParser.parseString("(objectClass=group)"), new EqualityFilter(objectIdMatch("ad", who.objectId)!)] });
        const attrs = ["objectGUID", "groupType", "cn"], found = await service.search(filter, attrs, ["objectGUID"], "sub", cfg.baseDn, undefined, true);
        if (!found.length) return { ok: false, reason: "not-found" };
        const entry = found[0]!, name = readText(entry, "cn");
        if (found.length !== 1 || !groupEntry(entry, who.objectId) || !withinGroupBase(entry.dn, cfg.baseDn) || !name || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name)) return { ok: false, reason: "unknown" };
        const members = await service.roomMembers(entry.dn, attributes, shape.binaryAttributes), people: DirectoryPerson[] = [], seen = new Set<string>();
        for (const member of members) {
          const id = readObjectId(cfg.profile, member);
          if (!id || seen.has(id) || !withinGroupBase(member.dn, cfg.baseDn)) return { ok: false, reason: "unknown" };
          seen.add(id); if (!isDisabled(cfg.profile, member, now())) people.push(toPerson(member, id));
        }
        const again = await service.search(filter, attrs, ["objectGUID"], "base", entry.dn, undefined, true);
        if (closed || expired || again.length !== 1 || !groupEntry(again[0]!, who.objectId) || again[0]!.dn.toLowerCase() !== entry.dn.toLowerCase()) return { ok: false, reason: "unknown" };
        return { ok: true, group: { key: who, name }, people };
      } catch { report("room-group-members", "unknown"); return { ok: false, reason: "unknown" }; }
      finally { clearTimeout(deadline); await service?.close(true); }
    },
    async resolvePolicyGroup(dn: string): Promise<PolicyGroupLookup> {
      if (!groupSupport) return { ok: false, reason: "unsupported" };
      if (closed) return { ok: false, reason: "unknown" };
      if (typeof dn !== "string" || !/^[^\u0000-\u001f\u007f]{1,1024}$/.test(dn)
        || !withinGroupBase(dn, cfg.baseDn)) return { ok: false, reason: "invalid" };
      let service: Session | undefined;
      try {
        service = await openService();
        const attrs = ["objectGUID", "groupType"];
        const found = await service.search("(objectClass=group)", attrs, ["objectGUID"], "base", dn, undefined, true);
        if (closed || found.length > 1) return { ok: false, reason: "unknown" };
        const entry = found[0];
        if (!entry) return { ok: false, reason: "not-found" };
        if (!withinGroupBase(entry.dn, cfg.baseDn)) return { ok: false, reason: "invalid" };
        const id = groupEntry(entry);
        if (!id) return { ok: false, reason: "not-security-group" };
        const { AndFilter, EqualityFilter, FilterParser } = await loadLdapts();
        const filter = new AndFilter({ filters: [FilterParser.parseString("(objectClass=group)"), new EqualityFilter(objectIdMatch("ad", id)!)] });
        const again = await service.search(filter, attrs, ["objectGUID"], "sub", cfg.baseDn, undefined, true);
        if (closed || again.length !== 1 || !groupEntry(again[0]!, id) || again[0]!.dn.toLowerCase() !== entry.dn.toLowerCase()) return { ok: false, reason: "unknown" };
        return { ok: true, group: Object.freeze({ key: Object.freeze({ realm: cfg.realm, objectId: id }), dn: again[0]!.dn }) };
      } catch (err) { const failure = directoryFailure(err); report("group-lookup", "unknown", undefined, failure); return { ok: false, reason: "unknown", failure }; }
      finally { await service?.close(); }
    },

    async checkPolicyGroup(key: PersonKey): Promise<PolicyGroupLookup> {
      const who = key && Object.freeze({ realm: key.realm, objectId: key.objectId });
      if (!groupSupport) return { ok: false, reason: "unsupported" };
      if (closed || !who || who.realm !== cfg.realm || !objectIdMatch("ad", who.objectId)) return { ok: false, reason: "unknown" };
      let service: Session | undefined;
      try {
        service = await openService();
        const { AndFilter, EqualityFilter, FilterParser } = await loadLdapts();
        const filter = new AndFilter({ filters: [FilterParser.parseString("(objectClass=group)"), new EqualityFilter(objectIdMatch("ad", who.objectId)!)] });
        const attrs = ["objectGUID", "groupType"];
        const found = await service.search(filter, attrs, ["objectGUID"], "sub", cfg.baseDn, undefined, true);
        if (closed || found.length > 1) return { ok: false, reason: "unknown" };
        const entry = found[0];
        if (!entry) return { ok: false, reason: "not-found" };
        if (!withinGroupBase(entry.dn, cfg.baseDn) || !groupEntry(entry, who.objectId)) return { ok: false, reason: "not-security-group" };
        const again = await service.search(filter, attrs, ["objectGUID"], "base", entry.dn, undefined, true);
        if (closed || again.length !== 1 || !groupEntry(again[0]!, who.objectId) || again[0]!.dn.toLowerCase() !== entry.dn.toLowerCase()) return { ok: false, reason: "unknown" };
        return { ok: true, group: Object.freeze({ key: who, dn: again[0]!.dn }) };
      } catch (err) { const failure = directoryFailure(err); report("group-lookup", "unknown", undefined, failure); return { ok: false, reason: "unknown", failure }; }
      finally { await service?.close(); }
    },

    async readPolicyGroups(key: PersonKey): Promise<PolicyGroupFacts> {
      // Capture caller-owned identity before any await; later replacement cannot retarget a result.
      const who = key && Object.freeze({ realm: key.realm, objectId: key.objectId });
      if (!groupSupport || closed || !who || who.realm !== cfg.realm || !objectIdMatch("ad", who.objectId)) return { kind: "unknown" };
      let service: Session | undefined;
      try {
        service = await openService();
        const { Control, AndFilter, EqualityFilter, FilterParser } = await loadLdapts();
        class ExtendedDn extends Control {
          constructor() { super(AD_EXTENDED_DN, { critical: true }); }
          protected override writeControl(writer: import("ldapts").BerWriter): void {
            // LDAP controlValue OCTET STRING contains SEQUENCE { Flags INTEGER(1) }.
            writer.writeBuffer(Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01]), 0x04);
          }
        }
        const filter = new AndFilter({ filters: [FilterParser.parseString(cfg.userFilter), new EqualityFilter(objectIdMatch("ad", who.objectId)!)] });
        const found = await service.search(filter, attributes, ["objectGUID"], "sub", cfg.baseDn, [new ExtendedDn()], true);
        if (closed || found.length > 1) return { kind: "unknown" };
        const entry = found[0], observedAt = now();
        if (!entry) return { kind: "ineligible", person: who, reason: "gone", observedAt };
        if (readObjectId("ad", entry) !== who.objectId) return { kind: "unknown" };
        if (isDisabled("ad", entry, observedAt)) return { kind: "ineligible", person: who, reason: "disabled", observedAt };
        const groups = extendedGroupIds(entry);
        if (!groups) return { kind: "unknown" };
        return Object.freeze({ kind: "complete", person: who, groups, observedAt });
      } catch (err) { const failure = directoryFailure(err); report("group-membership", "unknown", undefined, failure); return { kind: "unknown", failure }; }
      finally { await service?.close(); }
    },

    async close(): Promise<void> {
      // Nothing is pooled; after close every call refuses (fail closed) instead of opening a new connection.
      closed = true;
    },

    lookupForInitialization(login: string): Promise<InitializationLookupResult> {
      return lookup(login, "initialization-lookup");
    },
    lookupForPairing(login: string): Promise<DirectoryLookupResult> {
      return lookup(login, "pairing-owner-lookup");
    },
    lookupForGrant(login: string): Promise<DirectoryLookupResult> {
      return lookup(login, "grant-recipient-lookup");
    },
    async searchGrantPeople(q: string) {
      if (closed || typeof q !== "string" || q.length < 2 || q.length > 64 || /[\u0000-\u001f\u007f]/.test(q)) return { ok: false as const, reason: "unknown" as const };
      let service: Session | undefined, expired = false;
      const deadline = setTimeout(() => { expired = true; service?.abort(); }, 5000); deadline.unref();
      try {
        service = await openService({ ...cfg, timeoutMs: Math.min(cfg.timeoutMs, 5000) }, current => {
          service = current; if (expired) { current.abort(); throw new InsecureTransportError("person search deadline"); }
        });
        const entries = await service.personPrefix(q, attributes, [shape.idAttribute]);
        if (closed || expired || entries.length > 20) return { ok: false as const, reason: "unknown" as const };
        const people: Array<{ person: PersonKey; login: string; displayName: string }> = [], seen = new Set<string>();
        for (const entry of entries) {
          const objectId = readObjectId(cfg.profile, entry);
          if (!objectId || seen.has(objectId) || !withinGroupBase(entry.dn, cfg.baseDn)) return { ok: false as const, reason: "unknown" as const };
          seen.add(objectId); if (isDisabled(cfg.profile, entry, now())) continue;
          const p = toPerson(entry, objectId), displayName = p.displayName || p.login;
          if (!p.login || p.login.length > 256 || displayName.length > 256 || /[\u0000-\u001f\u007f]/.test(p.login + displayName)) return { ok: false as const, reason: "unknown" as const };
          people.push({ person: { ...p.key }, login: p.login, displayName });
        }
        return { ok: true as const, people, truncated: entries.length === 20 };
      } catch { report("person-search", "unavailable", "directory lookup failed"); return { ok: false as const, reason: "unknown" as const }; }
      finally { clearTimeout(deadline); await service?.close(true); }
    },

    async signIn(login: string, password: string): Promise<SignInResult> {
      if (closed) return { ok: false, reason: "unavailable" };
      if (!validLogin(login) || !validPassword(password)) {
        report("sign-in", "bad-input");
        return { ok: false, reason: "bad-input" };
      }
      let service: Session | undefined;
      try {
        service = await openService();
        const selected = await selectLogin(service, login);
        if (!selected.ok) {
          const reason = selected.reason === "not-found" ? "invalid-credentials" : selected.reason;
          report("sign-in", reason, selected.detail);
          return { ok: false, reason };
        }
        const { entry, objectId } = selected;

        // The password goes to the directory once, on its own connection, for the DN the service search found.
        const user = await Session.open(cfg, expectedServerFingerprint);
        try {
          await user.bind(entry.dn, password);
        } catch (err) {
          const { InvalidCredentialsError } = await loadLdapts();
          if (err instanceof InvalidCredentialsError) {
            report("sign-in", "invalid-credentials");
            return { ok: false, reason: "invalid-credentials" };
          }
          throw err;
        } finally {
          await user.close();
        }

        // The bound DN must still be the same object, still enabled (closes a delete/recreate race during the bind).
        const checked = await recheck(service, entry, objectId);
        if (!checked.ok) {
          const reason = checked.reason === "not-eligible" ? "not-eligible" : "unavailable";
          report("sign-in", reason, reason === "unavailable" ? "the entry changed during sign-in" : undefined);
          return { ok: false, reason };
        }
        return checked;
      } catch (err) {
        report("sign-in", "unavailable", err);
        return { ok: false, reason: "unavailable" };
      } finally {
        await service?.close();
      }
    },

    async checkEligibility(key: PersonKey): Promise<Eligibility> {
      if (closed) return { eligible: false, reason: "unavailable" };
      if (!key || key.realm !== cfg.realm || typeof key.objectId !== "string" || !objectIdMatch(cfg.profile, key.objectId)) {
        report("eligibility", "gone", "not a person key of this realm");
        return { eligible: false, reason: "gone" };
      }
      let service: Session | undefined;
      try {
        service = await openService();
        const found = await findById(service, key.objectId);
        if (found.length > 1) {
          report("eligibility", "unavailable", "the object id matches more than one entry");
          return { eligible: false, reason: "unavailable" };
        }
        const entry = found[0];
        if (!entry || readObjectId(cfg.profile, entry) !== key.objectId) {
          report("eligibility", "gone");
          return { eligible: false, reason: "gone" };
        }
        if (isDisabled(cfg.profile, entry, now())) {
          report("eligibility", "disabled");
          return { eligible: false, reason: "disabled" };
        }
        return { eligible: true, person: toPerson(entry, key.objectId) };
      } catch (err) {
        report("eligibility", "unavailable", err);
        return { eligible: false, reason: "unavailable" };
      } finally {
        await service?.close();
      }
    },
  };
}
