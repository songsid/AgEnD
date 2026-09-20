/**
 * Reading a kiro-cli credential store, read-only.
 *
 * Verified against a real kiro-cli 2.22.0 install (2026-09-20): one
 * `data.sqlite3` per store holds the login in `auth_kv` AND the conversations
 * in `conversations_v2`, plus more auth state in `state` (`auth.idc.*`). That
 * is why a credential profile cannot isolate the login while sharing the
 * conversations — they are tables in one file, and a table cannot be a symlink.
 *
 * Two callers need "is there a login in this store?": the usage panel, which
 * turns it into a row, and the profile switch, which refuses to restart an
 * agent into a store nobody has logged into. They shared a copy of this query
 * for exactly one commit before it was worth extracting — the schema detail
 * (which key shapes are tokens) must live in one place.
 */
import { join } from "node:path";
import Database from "better-sqlite3";

export interface KiroStoredToken {
  access_token?: string;
  expires_at?: string;
  region?: string;
  profile_arn?: string;
  /** IAM Identity Center portal URL — present only for Q Developer Pro logins. */
  start_url?: string;
  /** Social login provider (google/github/…) — present only for free-tier logins. */
  provider?: string;
}

/**
 * `no-store` means the database is not there (or cannot be opened at all).
 * Anything else returns the tokens it could parse, which may be none — a store
 * that exists with nothing in it is "signed out", a different thing entirely.
 */
export type KiroAuthRead =
  | { readonly kind: "no-store" }
  | { readonly kind: "tokens"; readonly tokens: KiroStoredToken[] };

/** Every token-shaped row in a store's `auth_kv`. Never writes, never refreshes. */
export function readKiroAuthTokens(storeHome: string): KiroAuthRead {
  let db: Database.Database;
  try {
    db = new Database(join(storeHome, "data.sqlite3"), { readonly: true, fileMustExist: true });
  } catch {
    return { kind: "no-store" };
  }
  try {
    // Read every token-shaped row rather than a fixed pair of keys: kiro names
    // its auth rows per login type (`kirocli:social:token`,
    // `codewhisperer:odic:token`, …), and an unlisted one used to read as
    // "not logged in" — which then removed Kiro from the usage panel entirely.
    const rows = db.prepare("SELECT value FROM auth_kv WHERE key LIKE '%:token'").all() as { value: string }[];
    const tokens: KiroStoredToken[] = [];
    for (const row of rows) {
      try {
        const token = JSON.parse(row.value) as KiroStoredToken;
        if (token.access_token) tokens.push(token);
      } catch { /* not a token row after all */ }
    }
    return { kind: "tokens", tokens };
  } catch {
    // A store whose schema we cannot read is not a store we can claim a login
    // from. Same answer as an empty one: signed out, still visible.
    return { kind: "tokens", tokens: [] };
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
}

/** True when this store holds a login. Used to refuse a switch that would wall. */
export function kiroStoreHasLogin(storeHome: string): boolean {
  const read = readKiroAuthTokens(storeHome);
  return read.kind === "tokens" && read.tokens.length > 0;
}
