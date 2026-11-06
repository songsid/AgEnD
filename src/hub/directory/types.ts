/**
 * AgEnD Hub — directory sign-in (S-43, design issue #3095 §2 and §4 "Revoke or change roles").
 *
 * A person is the directory realm plus the directory's immutable object id (entryUUID, or objectGUID decoded). The login
 * name, display name and email are attributes that can change; they never identify anyone. A renamed account keeps
 * its key; a deleted-and-recreated account with the same login gets a new key and inherits nothing.
 */

/**
 * The only identity the Hub stores or authorizes against. realm: a stable configured id ([a-z][a-z0-9_-]{0,63});
 * objectId: a lowercase canonical UUID. Neither contains "/", so personKeyString is unambiguous.
 */
export interface PersonKey {
  readonly realm: string;
  readonly objectId: string;
}

/**
 * What the directory says about a person right now. Never cached by this module. Server-side only: UI, member and
 * envelope DTOs project it and never forward dn, groups or anything about the service account (S-42 contract).
 */
export interface DirectoryPerson {
  readonly key: PersonKey;
  /** The current login (it changes on a rename). Display only. */
  readonly login: string;
  readonly dn: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly department?: string;
  /** Group DNs from memberOf. Informational in P1: grants are personal (design §4). */
  readonly groups: readonly string[];
}

/**
 * Why a sign-in was refused. For the audit log only: the sign-in page shows one generic refusal for all of them, so it
 * never reveals whether a login exists or is disabled.
 */
export type SignInRefusal =
  | "bad-input" // empty or malformed login/password (an empty password would be an unauthenticated bind)
  | "invalid-credentials" // unknown login, wrong password, or a lock the directory enforces on bind
  | "not-eligible" // the account exists but is disabled or expired
  | "unavailable"; // the directory could not be reached or answered unexpectedly: fail closed

export type SignInResult =
  | { readonly ok: true; readonly person: DirectoryPerson }
  | { readonly ok: false; readonly reason: SignInRefusal };

/** Local initialization only: finding an account does not authenticate it or issue a session. */
export type InitializationLookupResult =
  | { readonly ok: true; readonly person: DirectoryPerson }
  | { readonly ok: false; readonly reason: "bad-input" | "not-found" | "not-eligible" | "unavailable" };

export type IneligibleReason =
  | "gone" // no entry carries this object id any more (deleted, or recreated with a new id)
  | "disabled" // the entry exists but the directory marks it disabled or expired
  | "unavailable"; // could not establish eligibility: fail closed

export type Eligibility =
  | { readonly eligible: true; readonly person: DirectoryPerson }
  | { readonly eligible: false; readonly reason: IneligibleReason };

export interface HubDirectory {
  readonly realm: string;
  /** Verify a login and password with the directory. The password is used for one bind and never kept. */
  signIn(login: string, password: string): Promise<SignInResult>;
  /** Narrow service-account lookup for local init, never exposed as a browser lookup endpoint. Missing = unavailable. */
  lookupForInitialization?(login: string): Promise<InitializationLookupResult>;
  /** Per-request eligibility (design §4): exists, same immutable id, enabled. No cache; unreachable = not eligible. */
  checkEligibility(key: PersonKey): Promise<Eligibility>;
  /** Release the directory; later calls refuse (unavailable). */
  close(): Promise<void>;
}

export function personKeyString(key: PersonKey): string {
  return `${key.realm}/${key.objectId}`;
}

export function samePerson(a: PersonKey, b: PersonKey): boolean {
  return a.realm === b.realm && a.objectId === b.objectId;
}
