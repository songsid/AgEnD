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
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { kiroStoreHasLogin } from "./kiro-auth-store.js";

/** Profile names become a directory; keep them boring. */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The two shapes a credential home comes in.
 *
 * `relocate-home` moves the backend's whole home with an environment variable
 * and links the shareable parts back. `redirect-files` leaves the home exactly
 * where the backend already has it and swaps a named file or two for the
 * profile's copy — which is the only option when something else already owns
 * that backend's home variable, and the cheapest one when the login is a single
 * file rather than a store entangled with everything else.
 */
export type CredentialHomeKind = "relocate-home" | "redirect-files";

export interface CredentialHomeSpec {
  kind: CredentialHomeKind;
  /**
   * The variable that moves the credential home, prepended at launch.
   *
   * Only meaningful for `relocate-home`. A `redirect-files` backend names the
   * variable it already uses, for the login command it prints, and nothing
   * prepends it.
   */
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
  /**
   * `redirect-files` only: the files the profile owns, relative to the home the
   * backend is already using.
   *
   * Everything not named here keeps coming from wherever it came from before,
   * which is the point: for a backend whose login is one file, swapping that
   * file is the entire mechanism and nothing else has to move.
   */
  files: readonly string[];
  /**
   * Whether this store holds a login, given its store directory.
   *
   * A profile nobody has logged into is not an empty session — the CLI stops at
   * an interactive sign-in prompt and waits there, so an agent pointed at one
   * never starts. A backend that cannot answer this omits it, and the switch is
   * allowed rather than blocked on a check that does not exist.
   */
  hasLogin?: (storeHome: string) => boolean;
  /** The subcommand that logs a store in, for telling the user what to run. */
  loginSubcommand: string;
  /**
   * Whether changing profile means the conversation is gone.
   *
   * Kiro keeps its conversations in the same database as the login, so a
   * different subscription is a different set of them: true. Codex keeps its
   * login in one file beside stores that carry no account, so the conversation
   * stays put: false. This is not a policy either way — it is what each
   * backend's files force.
   */
  switchStartsFreshSession: boolean;
}

/**
 * Kiro keeps its login in `$XDG_DATA_HOME/kiro-cli/data.sqlite3`, beside
 * several gigabytes of downloaded runtimes. Measured on a real install: `kas`
 * 8.2G, `node` 103M, `bun` 98M, `cli-checkouts` 56M — duplicating those per
 * profile is what makes the naive "just move XDG_DATA_HOME" approach expensive.
 */
const KIRO_HOME: CredentialHomeSpec = {
  kind: "relocate-home",
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
  files: [],
  hasLogin: kiroStoreHasLogin,
  loginSubcommand: "login",
  switchStartsFreshSession: true,
};

/**
 * Codex keeps its identity in one plain file and nothing else.
 *
 * Verified read-only against a real `~/.codex` (2026-09-21): `auth.json` holds
 * the whole login, and every conversation store — `sessions/` rollout JSONL
 * plus the thread/state/memory/goal databases — is keyed by thread and project
 * with no account column anywhere. So swapping that one file swaps the account
 * and leaves the conversation where it is, which is the opposite of kiro and
 * for the opposite reason: not a policy, just the file layout.
 *
 * It is `redirect-files` rather than `relocate-home` because `CODEX_HOME` is
 * already taken. Every instance gets its own codex home so its `config.toml`
 * (which carries AgEnD's MCP wiring) is private, and that home links almost
 * everything back to the shared one. A profile changes where exactly one of
 * those links points.
 */
const CODEX_HOME: CredentialHomeSpec = {
  kind: "redirect-files",
  env: "CODEX_HOME",
  sharedRoot: () => resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")),
  storeSubdir: "",
  isolate: ["auth.json"],
  share: [],
  files: ["auth.json"],
  hasLogin: codexStoreHasLogin,
  loginSubcommand: "login",
  switchStartsFreshSession: false,
};

/**
 * A codex login is `auth.json` with a token in it.
 *
 * Read for shape only — never a value, and never rewritten. An API-key-only
 * file counts: codex will run with it, and whether it can report usage is a
 * different question from whether the agent can start.
 */
function codexStoreHasLogin(storeHome: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(storeHome, "auth.json"), "utf8")) as {
      tokens?: { access_token?: unknown };
      OPENAI_API_KEY?: unknown;
    };
    return typeof parsed.tokens?.access_token === "string" && parsed.tokens.access_token.length > 0
      || typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.length > 0;
  } catch {
    return false;
  }
}

/** Backends that can hold more than one login. Codex and Claude come later. */
export const CREDENTIAL_HOMES: Readonly<Record<string, CredentialHomeSpec>> = {
  "kiro-cli": KIRO_HOME,
  "codex": CODEX_HOME,
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
  if (spec.kind === "redirect-files") {
    prepareRedirectedFiles(spec, profileHome);
    return;
  }
  const profileStore = spec.storeSubdir ? join(profileHome, spec.storeSubdir) : profileHome;
  const sharedStore = spec.storeSubdir ? join(spec.sharedRoot(), spec.storeSubdir) : spec.sharedRoot();

  // The same trap one level up: if the profile directory — or the store
  // directory inside it — is itself a link to the shared home, every file below
  // is the shared login. `mkdir -p` follows the link and succeeds, and the
  // store is a real file at the far end, so nothing else here would notice.
  // Refuse rather than launch: starting would quietly bill the wrong account.
  for (const level of new Set([profileHome, profileStore])) {
    try {
      if (!lstatSync(level).isSymbolicLink()) continue;
    } catch {
      continue; // absent; mkdir will create it
    }
    throw new Error(
      `credential profile path is a symlink, so it is not isolated: ${level}. Remove the link and let AgEnD create a real directory.`,
    );
  }

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

/**
 * Make the directory a `redirect-files` profile owns.
 *
 * Nothing is linked *into* it: the backend's home stays where it is and the
 * files here are the originals, so the only job is to create the directory and
 * refuse the one arrangement that would silently un-isolate it.
 */
function prepareRedirectedFiles(spec: CredentialHomeSpec, profileHome: string): void {
  try {
    if (lstatSync(profileHome).isSymbolicLink()) {
      throw new Error(
        `credential profile path is a symlink, so it is not isolated: ${profileHome}. `
        + "Remove the link and let AgEnD create a real directory.",
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("not isolated")) throw err;
    // Absent; mkdir will create it.
  }
  mkdirSync(profileHome, { recursive: true, mode: 0o700 });

  // A file the profile owns must be the real thing. A link here would point
  // back at the shared login, and this profile would be that login wearing a
  // different name — the same trap as a symlinked store, one level down.
  for (const name of spec.files) {
    const target = join(profileHome, name);
    try {
      if (!lstatSync(target).isSymbolicLink()) continue;
    } catch {
      continue; // not there yet: the backend will create it on login
    }
    throw new Error(
      `${name} in ${profileHome} is a symlink, so this profile shares the login it exists to separate. Remove it and log the profile in again.`,
    );
  }
}

/**
 * The profiles a fleet is configured to use for one backend, in a stable order.
 *
 * Read from the configuration rather than from the directories on disk: the
 * config is what the fleet will actually launch, a directory can linger after a
 * profile is removed, and a profile configured but never started has no
 * directory yet. Instances sharing a profile name collapse into one entry,
 * because they share one login and one quota.
 */
export function listConfiguredProfiles(
  config: { instances?: Record<string, { backend?: string; backend_options?: Record<string, Record<string, unknown>> }>; defaults?: { backend?: string; backend_options?: Record<string, Record<string, unknown>> } } | null,
  backendName: string,
): string[] {
  const found = new Set<string>();
  const collect = (options: Record<string, Record<string, unknown>> | undefined) => {
    try {
      const profile = resolveCredentialProfile(options?.[backendName]);
      if (profile) found.add(profile);
    } catch {
      // A malformed name is rejected where it is written; usage must not throw
      // because a config it only reads has something wrong in it.
    }
  };
  collect(config?.defaults?.backend_options);
  for (const instance of Object.values(config?.instances ?? {})) {
    collect(instance.backend_options);
  }
  return [...found].sort();
}

/**
 * The directory the backend's own files sit in, for one profile.
 *
 * One level below the profile home whenever the relocating variable points at a
 * directory of many programs' data — `XDG_DATA_HOME/kiro-cli`, not
 * `XDG_DATA_HOME`. Everything that reads a profile's store (the usage panel,
 * the transcript reader, the login check) must agree on this path, so it is
 * computed here rather than reassembled at each call site.
 */
export function credentialProfileStoreHome(dataDir: string, backendName: string, profile: string): string {
  const spec = credentialHomeSpec(backendName);
  const home = credentialProfileHome(dataDir, backendName, profile);
  return spec?.storeSubdir ? join(home, spec.storeSubdir) : home;
}

/**
 * Whether a profile can be started, and what to run if it cannot.
 *
 * `unknown` is not a failure: a backend with no login probe, or a profile on a
 * backend that has no credential home at all, is simply not something this can
 * speak about, and a caller must not treat silence as a refusal.
 */
export type CredentialProfileLogin =
  | { readonly state: "logged-in" }
  | { readonly state: "signed-out"; readonly loginCommand: string }
  | { readonly state: "unknown" };

export function credentialProfileLogin(
  dataDir: string,
  backendName: string,
  profile: string,
): CredentialProfileLogin {
  const spec = credentialHomeSpec(backendName);
  if (!spec?.hasLogin) return { state: "unknown" };
  const storeHome = credentialProfileStoreHome(dataDir, backendName, profile);
  if (spec.hasLogin(storeHome)) return { state: "logged-in" };
  return {
    state: "signed-out",
    // The whole command, not a description of one: this is read by an agent
    // relaying it to a person who has to run it, and a paraphrase of a shell
    // line is how a person ends up logging the wrong profile in.
    loginCommand: `${spec.env}=${JSON.stringify(credentialProfileHome(dataDir, backendName, profile))} ${backendName} ${spec.loginSubcommand}`,
  };
}

/**
 * Does switching this backend's profile cost the conversation?
 *
 * Unknown backends answer yes. Assuming a conversation survives when nobody has
 * checked is how an agent ends up resuming into a store that does not have it;
 * assuming it is lost only costs a handover message nobody needed.
 */
export function credentialSwitchStartsFresh(backendName: string): boolean {
  return credentialHomeSpec(backendName)?.switchStartsFreshSession ?? true;
}

/** The profile one instance runs under, or null for the shared login. */
export function instanceCredentialProfile(
  instance: { backend_options?: Record<string, Record<string, unknown>> } | undefined,
  defaults: { backend_options?: Record<string, Record<string, unknown>> } | undefined,
  backendName: string,
): string | null {
  for (const options of [instance?.backend_options, defaults?.backend_options]) {
    try {
      const profile = resolveCredentialProfile(options?.[backendName]);
      if (profile) return profile;
    } catch { /* reported by the validator, not here */ }
  }
  return null;
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
