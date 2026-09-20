/**
 * Running one fleet against more than one subscription of the same backend.
 *
 * Every CLI backend keeps its login in one place on disk, and every instance
 * shares it — so the whole fleet is one account. A `credential_profile` gives a
 * named, separate copy of that place: instances with the same profile share a
 * login, instances with different profiles have different ones, and instances
 * with no profile keep using exactly what they use today.
 *
 * The mechanism is backend-agnostic by construction. What differs per backend
 * is one record: the environment variable that relocates the credential home,
 * where inside it the store sits, and which entries may be shared back. Adding
 * Codex or Claude later is a new entry in `CREDENTIAL_HOMES`, not a new design.
 *
 * Two rules the layout has to respect, both learned the hard way:
 *
 * - **The store itself is never a symlink.** SQLite resolves a symlinked
 *   database to its target and writes its journal beside the target, so a
 *   linked store is not isolated at all — it is the shared store with extra
 *   steps. The Codex backend carries the same warning for the same reason.
 * - **Sharing is an allow list, not an exclusion list.** Codex shares
 *   everything except its config because its home is small and well understood.
 *   A credential home is neither: this one holds an 8 GB runtime cache next to
 *   the login, a refresh lock, and a runtime socket directory. An entry nobody
 *   has classified stays private, which costs disk and never leaks a session.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Profile names become a directory; keep them boring. */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface CredentialHomeSpec {
  /** The variable that moves the credential home, prepended at launch. */
  env: string;
  /** The shared home this backend uses when the variable is unset. */
  sharedRoot(): string;
  /**
   * Where under the root the backend's own files live. `XDG_DATA_HOME` points
   * at a directory of many programs' data, so kiro's store is one level down;
   * a backend whose variable points straight at its own home leaves this "".
   */
  storeSubdir: string;
  /**
   * Entries that must be real files in the profile. Everything the login is
   * made of, plus anything the store cannot be separated from.
   */
  isolate: readonly string[];
  /**
   * Entries linked back to the shared home when they exist there. Only
   * content-addressed runtimes and caches belong here — things that are
   * expensive to duplicate and carry no identity.
   */
  share: readonly string[];
}

/**
 * Kiro keeps its login in `$XDG_DATA_HOME/kiro-cli/data.sqlite3`, beside
 * several gigabytes of downloaded runtimes. Measured on a real install: `kas`
 * 8.2G, `node` 103M, `bun` 98M, `cli-checkouts` 56M — duplicating those per
 * profile is what makes the naive "just move XDG_DATA_HOME" approach expensive.
 */
const KIRO_HOME: CredentialHomeSpec = {
  env: "XDG_DATA_HOME",
  sharedRoot: () => resolve(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share")),
  storeSubdir: "kiro-cli",
  isolate: [
    "data.sqlite3",
    // The refresh lock guards this store's token refresh; a shared lock would
    // serialise two unrelated logins against each other.
    ".refresh.lock",
    // Per-login runtime sockets.
    "run",
  ],
  share: [
    "kas", "kas.sha256",
    "node", "node.sha256",
    "bun", "bun.sha256",
    "cli-checkouts",
  ],
};

/** Backends that can hold more than one login. Codex and Claude come later. */
export const CREDENTIAL_HOMES: Readonly<Record<string, CredentialHomeSpec>> = {
  "kiro-cli": KIRO_HOME,
};

export function credentialHomeSpec(backendName: string): CredentialHomeSpec | null {
  return CREDENTIAL_HOMES[backendName] ?? null;
}

/**
 * The profile a backend was asked for, or null for "behave exactly as before".
 *
 * Null is the whole backward-compatibility story: no profile means no variable
 * is prepended and no directory is created, so an instance that does not opt in
 * cannot be affected by this feature at all.
 */
export function resolveCredentialProfile(backendOptions: Record<string, unknown> | undefined): string | null {
  const raw = backendOptions?.credential_profile;
  if (raw === undefined || raw === null || raw === "") return null;
  const name = String(raw).trim();
  if (!PROFILE_NAME.test(name)) {
    throw new Error(`credential_profile must match ${PROFILE_NAME} (got ${JSON.stringify(name)})`);
  }
  return name;
}

/**
 * Where a profile lives: under the fleet's data directory, not an instance's.
 *
 * A subscription is shared by however many agents the user points at it, so the
 * directory belongs to the fleet. Putting it under an instance would make
 * "these three agents use the work account" impossible to express.
 */
export function credentialProfileHome(dataDir: string, backendName: string, profile: string): string {
  return join(dataDir, "credential-profiles", backendName, profile);
}

/**
 * Create the profile home and link the shareable parts back.
 *
 * Idempotent: it only ever adds links that are missing, and never replaces
 * anything that already exists in the profile — a real directory there is
 * someone's data, and this is not the code that decides to delete it.
 */
export function prepareCredentialProfileHome(spec: CredentialHomeSpec, profileHome: string): void {
  const profileStore = spec.storeSubdir ? join(profileHome, spec.storeSubdir) : profileHome;
  const sharedStore = spec.storeSubdir ? join(spec.sharedRoot(), spec.storeSubdir) : spec.sharedRoot();
  mkdirSync(profileStore, { recursive: true, mode: 0o700 });

  // A link where a private entry belongs means this profile is not isolated at
  // all — it is the shared login wearing a different path. Remove the link and
  // let the backend create its own; never touch a real file, which is somebody's
  // actual login.
  for (const name of spec.isolate) {
    const target = join(profileStore, name);
    try {
      if (!lstatSync(target).isSymbolicLink()) continue;
      unlinkSync(target);
      console.warn(`[agend] removed a shared link where ${name} must be private: ${target}`);
    } catch {
      // Absent, or removed by a concurrent start. Either way there is no link.
    }
  }

  for (const name of spec.share) {
    // Isolation wins over sharing, so a name in both lists is never linked.
    if (spec.isolate.includes(name)) continue;
    const source = join(sharedStore, name);
    const target = join(profileStore, name);
    if (!existsSync(source)) continue;
    try {
      symlinkSync(source, target, lstatSync(source).isDirectory() ? "dir" : "file");
    } catch {
      // EEXIST is the ordinary case on every start after the first, and it is
      // also what protects anything already in the profile from being replaced.
      // A cache that could not be linked costs a re-download, not correctness.
    }
  }
}

/** Entries that are real (not links) in a prepared profile — for tests and doctor. */
export function profilePrivateEntries(spec: CredentialHomeSpec, profileHome: string): string[] {
  const profileStore = spec.storeSubdir ? join(profileHome, spec.storeSubdir) : profileHome;
  let names: string[];
  try { names = readdirSync(profileStore); } catch { return []; }
  return names.filter(name => {
    try { return !lstatSync(join(profileStore, name)).isSymbolicLink(); } catch { return false; }
  }).sort();
}
