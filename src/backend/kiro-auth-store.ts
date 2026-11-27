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
  /** IAM Identity Center portal URL — identifies the login flow, not the subscription. */
  start_url?: string;
  /** Social login provider (google/github/…) — does not determine the subscription tier. */
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

/** Usage must follow the CLI selection, never an unrelated token's expiry. */
export function readKiroUsageIdentity(storeHome: string):
  | { kind: "no-store" }
  | { kind: "missing" }
  | { kind: "unknown"; reason: "account" | "profile" }
  | { kind: "selected"; token: KiroStoredToken; profileArn?: string } {
  let db: Database.Database;
  try { db = new Database(join(storeHome, "data.sqlite3"), { readonly: true, fileMustExist: true }); }
  catch { return { kind: "no-store" }; }
  try {
    // One read transaction keeps token and profile on the same CLI selection.
    return db.transaction(() => {
      const rows = db.prepare("SELECT key, value FROM auth_kv WHERE key LIKE '%:token'").all() as {key: string; value: string}[];
      const entries = rows.flatMap(row => {
        try {
          const token = JSON.parse(row.value) as KiroStoredToken;
          return typeof token?.access_token === "string" && token.access_token.length ? [{key: row.key, token}] : [];
        } catch { return []; }
      });
      // A present but malformed native selection cannot silently select a legacy account.
      const nativeRow = rows.find(row => row.key === "kirocli:odic:token");
      const native = entries.find(row => row.key === "kirocli:odic:token");
      if (nativeRow && !native) return { kind: "unknown", reason: "account" } as const;
      let profileArn: string | undefined;
      const hasState = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='state'").get();
      if (hasState) {
        const profile = db.prepare("SELECT value FROM state WHERE key='api.codewhisperer.profile'").get() as {value: string} | undefined;
        if (profile) {
          try {
            const value = JSON.parse(profile.value) as {arn?: unknown};
            if (typeof value?.arn !== "string" || !value.arn) return { kind: "unknown", reason: "profile" } as const;
            profileArn = value.arn;
          } catch { return { kind: "unknown", reason: "profile" } as const; }
        }
      }
      if (!entries.length) return { kind: "missing" } as const;
      const matches = profileArn ? entries.filter(row => row.token.profile_arn === profileArn) : [];
      const selected = native ?? (matches.length === 1 ? matches[0] : !profileArn && entries.length === 1 ? entries[0] : undefined);
      if (!selected) return { kind: "unknown", reason: "account" } as const;
      if (profileArn && selected.token.profile_arn && profileArn !== selected.token.profile_arn) return { kind: "unknown", reason: "profile" } as const;
      return { kind: "selected", token: selected.token, profileArn: profileArn ?? selected.token.profile_arn } as const;
    })();
  } catch { return { kind: "unknown", reason: "account" } as const; }
  finally { try { db.close(); } catch { /* read-only close */ } }
}
