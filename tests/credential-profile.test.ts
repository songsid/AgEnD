import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CREDENTIAL_HOMES,
  credentialHomeSpec,
  credentialProfileHome,
  prepareCredentialProfileHome,
  profilePrivateEntries,
  resolveCredentialProfile,
  credentialSwitchStartsFresh,
} from "../src/backend/credential-profile.js";
import { KiroBackend } from "../src/backend/kiro.js";
import type { CliBackendConfig } from "../src/backend/types.js";

const dirs: string[] = [];
const envBackup = { ...process.env };

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-credprofile-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of ["XDG_DATA_HOME", "AGEND_HOME"]) {
    if (envBackup[key] === undefined) delete process.env[key];
    else process.env[key] = envBackup[key];
  }
  vi.restoreAllMocks();
});

/** A stand-in for a real `~/.local/share` with a kiro store in it. */
function sharedRootWithStore(): { root: string; store: string } {
  const root = tempDir();
  const store = join(root, "kiro-cli");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "data.sqlite3"), "shared-login");
  writeFileSync(join(store, "bun"), "bun-binary");
  writeFileSync(join(store, "bun.sha256"), "deadbeef");
  mkdirSync(join(store, "kas", "1.2.3"), { recursive: true });
  writeFileSync(join(store, "kas", "1.2.3", "payload"), "8 gigabytes, pretend");
  mkdirSync(join(store, "cli-checkouts"), { recursive: true });
  writeFileSync(join(store, "history"), "shell history");
  mkdirSync(join(store, "run"), { recursive: true });
  return { root, store };
}

describe("opting in", () => {
  it("is off unless a profile is named", () => {
    // The whole backward-compatibility story: no profile, no behaviour.
    expect(resolveCredentialProfile(undefined)).toBeNull();
    expect(resolveCredentialProfile({})).toBeNull();
    expect(resolveCredentialProfile({ credential_profile: "" })).toBeNull();
    expect(resolveCredentialProfile({ provider: "glm" })).toBeNull();
  });

  it("accepts a plain name and refuses anything that would leave its directory", () => {
    expect(resolveCredentialProfile({ credential_profile: "work" })).toBe("work");
    expect(resolveCredentialProfile({ credential_profile: " work " })).toBe("work");
    for (const bad of ["../escape", "a/b", "", " ", ".hidden", "with space", "x".repeat(65), "$(whoami)"]) {
      if (bad === "" || bad === " ") continue;
      expect(() => resolveCredentialProfile({ credential_profile: bad }), bad).toThrow(/credential_profile/);
    }
  });

  it("puts a profile under the fleet, not under an instance", () => {
    // One subscription, however many agents point at it.
    expect(credentialProfileHome("/data", "kiro-cli", "work"))
      .toBe("/data/credential-profiles/kiro-cli/work");
  });

  it("knows the backends whose credential layout has been checked", () => {
    // One entry per backend somebody actually looked at. The two are different
    // shapes because their files are: kiro's login is a store entangled with
    // everything else, codex's is one file beside stores that carry no account.
    expect(credentialHomeSpec("kiro-cli")).toMatchObject({ kind: "relocate-home", env: "XDG_DATA_HOME" });
    expect(credentialHomeSpec("codex")).toMatchObject({ kind: "redirect-files", files: ["auth.json"] });
    expect(credentialHomeSpec("claude-code")).toBeNull();
    expect(Object.keys(CREDENTIAL_HOMES)).toEqual(["kiro-cli", "codex"]);
  });

  it("says which switches cost the conversation and which do not", () => {
    // Not a policy on either side — kiro's conversations live inside the login
    // database, codex's live outside it.
    expect(credentialSwitchStartsFresh("kiro-cli")).toBe(true);
    expect(credentialSwitchStartsFresh("codex")).toBe(false);
    // A backend nobody has checked is assumed to lose it: guessing the other
    // way is how an agent resumes into a store that never had the thread.
    expect(credentialSwitchStartsFresh("claude-code")).toBe(true);
  });
});

describe("the profile home", () => {
  it("keeps the login private and links the heavy caches back", () => {
    const { root, store } = sharedRootWithStore();
    process.env.XDG_DATA_HOME = root;
    const spec = credentialHomeSpec("kiro-cli")!;
    const home = join(tempDir(), "work");

    prepareCredentialProfileHome(spec, home);

    const profileStore = join(home, "kiro-cli");
    // Shared: the multi-gigabyte runtimes, as links to the one real copy.
    for (const name of ["kas", "bun", "bun.sha256", "cli-checkouts"]) {
      const target = join(profileStore, name);
      expect(lstatSync(target).isSymbolicLink(), `${name} should be shared`).toBe(true);
      expect(readlinkSync(target)).toBe(join(store, name));
    }
    // Private: nothing that carries an identity was linked.
    expect(existsSync(join(profileStore, "data.sqlite3"))).toBe(false);
    expect(existsSync(join(profileStore, "run"))).toBe(false);
    expect(existsSync(join(profileStore, ".refresh.lock"))).toBe(false);
    // …and an entry nobody classified stays private too.
    expect(existsSync(join(profileStore, "history"))).toBe(false);
  });

  it("never links the store itself, whatever the lists say", () => {
    // A symlinked SQLite database resolves to its target and writes its journal
    // there: a linked store is the shared store with extra steps.
    const { root } = sharedRootWithStore();
    process.env.XDG_DATA_HOME = root;
    const spec = { ...credentialHomeSpec("kiro-cli")!, share: ["data.sqlite3", "kas"] as const };
    const home = join(tempDir(), "work");

    prepareCredentialProfileHome(spec, home);

    expect(existsSync(join(home, "kiro-cli", "data.sqlite3"))).toBe(false);
    expect(lstatSync(join(home, "kiro-cli", "kas")).isSymbolicLink()).toBe(true);
  });

  it("creates the store directory owner-only", () => {
    const { root } = sharedRootWithStore();
    process.env.XDG_DATA_HOME = root;
    const home = join(tempDir(), "work");

    prepareCredentialProfileHome(credentialHomeSpec("kiro-cli")!, home);

    expect(statSync(join(home, "kiro-cli")).mode & 0o777).toBe(0o700);
  });

  it("is idempotent and never replaces what is already there", () => {
    const { root } = sharedRootWithStore();
    process.env.XDG_DATA_HOME = root;
    const spec = credentialHomeSpec("kiro-cli")!;
    const home = join(tempDir(), "work");
    prepareCredentialProfileHome(spec, home);
    // A real login appears in the profile, as it would after `kiro-cli login`.
    writeFileSync(join(home, "kiro-cli", "data.sqlite3"), "profile-login");
    // …and someone made kas a real directory here.
    rmSync(join(home, "kiro-cli", "kas"));
    mkdirSync(join(home, "kiro-cli", "kas"));

    prepareCredentialProfileHome(spec, home);
    prepareCredentialProfileHome(spec, home);

    expect(readFileSync(join(home, "kiro-cli", "data.sqlite3"), "utf8")).toBe("profile-login");
    expect(lstatSync(join(home, "kiro-cli", "kas")).isSymbolicLink()).toBe(false);
    expect(profilePrivateEntries(spec, home)).toEqual(["data.sqlite3", "kas"]);
  });

  it("removes a link standing where a private entry belongs", () => {
    // A linked store is the shared login wearing a different path — the profile
    // would look isolated and not be. An older version, or a hand-made link,
    // must not survive a start.
    const { root, store } = sharedRootWithStore();
    process.env.XDG_DATA_HOME = root;
    const spec = credentialHomeSpec("kiro-cli")!;
    const home = join(tempDir(), "work");
    mkdirSync(join(home, "kiro-cli"), { recursive: true });
    symlinkSync(join(store, "data.sqlite3"), join(home, "kiro-cli", "data.sqlite3"));
    mkdirSync(join(home, "kiro-cli", "run"), { recursive: true });
    rmSync(join(home, "kiro-cli", "run"), { recursive: true });
    symlinkSync(join(store, "run"), join(home, "kiro-cli", "run"), "dir");

    prepareCredentialProfileHome(spec, home);

    expect(existsSync(join(home, "kiro-cli", "data.sqlite3"))).toBe(false);
    expect(existsSync(join(home, "kiro-cli", "run"))).toBe(false);
    // The shared login itself is untouched.
    expect(readFileSync(join(store, "data.sqlite3"), "utf8")).toBe("shared-login");
  });

  it("leaves a real private file alone", () => {
    const { root } = sharedRootWithStore();
    process.env.XDG_DATA_HOME = root;
    const spec = credentialHomeSpec("kiro-cli")!;
    const home = join(tempDir(), "work");
    mkdirSync(join(home, "kiro-cli"), { recursive: true });
    writeFileSync(join(home, "kiro-cli", "data.sqlite3"), "profile-login");

    prepareCredentialProfileHome(spec, home);

    expect(readFileSync(join(home, "kiro-cli", "data.sqlite3"), "utf8")).toBe("profile-login");
  });

  it("does nothing when the profile would be the shared home itself", () => {
    const { root, store } = sharedRootWithStore();
    process.env.XDG_DATA_HOME = root;

    prepareCredentialProfileHome(credentialHomeSpec("kiro-cli")!, root);

    // No link pointing at itself.
    expect(lstatSync(join(store, "kas")).isSymbolicLink()).toBe(false);
  });

  it("copes with a shared home that has none of the caches yet", () => {
    const root = tempDir();
    process.env.XDG_DATA_HOME = root;
    const home = join(tempDir(), "work");

    expect(() => prepareCredentialProfileHome(credentialHomeSpec("kiro-cli")!, home)).not.toThrow();
    expect(existsSync(join(home, "kiro-cli"))).toBe(true);
  });
});

describe("the kiro launch command", () => {
  function backend(): KiroBackend {
    return new KiroBackend(tempDir(), {
      supportsLegacyUi: true, supportsRequireMcpStartup: false, supportsEffortFlag: false, version: "2.22.0",
    } as never);
  }

  function config(overrides: Partial<CliBackendConfig> = {}): CliBackendConfig {
    return {
      workingDirectory: "/tmp/w", instanceDir: "/tmp/i", instanceName: "one",
      mcpServers: {}, ...overrides,
    } as CliBackendConfig;
  }

  it("launches exactly as before when no profile is set", () => {
    const withoutOptions = backend().buildCommand(config());
    const withOtherOptions = backend().buildCommand(config({ backendOptions: { provider: "glm" } }));

    expect(withoutOptions).not.toContain("XDG_DATA_HOME");
    expect(withOtherOptions).not.toContain("XDG_DATA_HOME");
    expect(withOtherOptions.startsWith(withoutOptions.split(" ")[0]!)).toBe(true);
  });

  it("prepends the credential home when one is", () => {
    const dataDir = tempDir();
    process.env.AGEND_HOME = dataDir;
    process.env.XDG_DATA_HOME = sharedRootWithStore().root;

    const cmd = backend().buildCommand(config({ backendOptions: { credential_profile: "work" } }));

    const expected = join(dataDir, "credential-profiles", "kiro-cli", "work");
    expect(cmd.startsWith(`XDG_DATA_HOME=`)).toBe(true);
    expect(cmd).toContain(expected);
    // …and the directory is ready before the command is ever run.
    expect(existsSync(join(expected, "kiro-cli"))).toBe(true);
  });

  it("gives two instances on the same profile one store, and different profiles two", () => {
    const dataDir = tempDir();
    process.env.AGEND_HOME = dataDir;
    process.env.XDG_DATA_HOME = sharedRootWithStore().root;

    const a = backend().buildCommand(config({ backendOptions: { credential_profile: "work" } }));
    const b = backend().buildCommand(config({ backendOptions: { credential_profile: "work" } }));
    const c = backend().buildCommand(config({ backendOptions: { credential_profile: "personal" } }));

    const homeOf = (cmd: string) => cmd.slice("XDG_DATA_HOME=".length).split(" ")[0];
    expect(homeOf(a)).toBe(homeOf(b));
    expect(homeOf(a)).not.toBe(homeOf(c));
  });

  it("refuses a profile name that would escape its directory", () => {
    expect(() => backend().buildCommand(config({ backendOptions: { credential_profile: "../../etc" } })))
      .toThrow(/credential_profile/);
  });
});
