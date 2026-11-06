import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cachedCredentialStatus, credentialProfilesRoot, ensureCredentialProfile, rememberCredentialStatus } from "../src/runtime-credential-profiles.js";
import { CREATED_PROFILES_FILE, ProfileOwnershipRefusal, createRuntimeProfile, deleteProfileBackups, isCreatedProfile, removeOwnedProfile, requireOwnedProfile } from "../src/runtime-profile-ownership.js";

const directories: string[] = [];
const scratch = (): string => { const path = mkdtempSync(join(tmpdir(), "agend-ownership-")); directories.push(path); return path; };
afterEach(() => { for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); } });
const setup = () => { const pairing = scratch(), root = credentialProfilesRoot(pairing); return { pairing, root }; };
const refusal = (run: () => unknown): ProfileOwnershipRefusal => { try { run(); } catch (error) { expect(error).toBeInstanceOf(ProfileOwnershipRefusal); return error as ProfileOwnershipRefusal; } throw Error("expected a refusal"); };
/** Creating a link may need a privilege on Windows; where it does not work the case is skipped, never faked. */
const link = (target: string, path: string): boolean => { try { symlinkSync(target, path, "dir"); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return false; throw error; } };

describe("proof of creation (Q4)", () => {
  it("records a profile the Runtime creates, and does not claim a folder that was already there", () => {
    const { pairing, root } = setup();
    expect(createRuntimeProfile(root, "claude-code", "work")).toEqual({ directory: join(root, "claude-code", "work"), created: true });
    expect(isCreatedProfile(root, "claude-code", "work")).toBe(true);
    ensureCredentialProfile(root, "claude-code", "byhand");           // a folder the Runtime has no record of
    expect(createRuntimeProfile(root, "claude-code", "byhand").created).toBe(false);
    expect(isCreatedProfile(root, "claude-code", "byhand")).toBe(false);
    expect(createRuntimeProfile(root, "claude-code", "work").created).toBe(false);
    expect(requireOwnedProfile(pairing, root, "claude-code", "work")).toBe(join(root, "claude-code", "work"));
    expect(refusal(() => requireOwnedProfile(pairing, root, "claude-code", "byhand")).reason).toBe("not_owned");
    expect(refusal(() => requireOwnedProfile(pairing, root, "claude-code", "missing")).reason).toBe("not_found");
  });
  it("a name that is also a property name is a name (null-prototype ledger)", () => {
    const { pairing, root } = setup();
    for (const name of ["constructor", "toString", "hasOwnProperty", "valueOf"]) { expect(isCreatedProfile(root, "claude-code", name)).toBe(false); createRuntimeProfile(root, "claude-code", name); expect(requireOwnedProfile(pairing, root, "claude-code", name)).toContain(name); }
  });
  it("a missing, damaged or hostile ledger records nothing, so nothing is removable remotely", () => {
    const { pairing, root } = setup(); createRuntimeProfile(root, "claude-code", "work");
    for (const text of ["{", "[]", JSON.stringify({ version: 1, created: { "claude-code": ["work"] } }), JSON.stringify({ version: 2, created: { "claude-code": { work: 1 } } }), JSON.stringify({ version: 1, created: { "claude-code": { "../x": 1, work: "now" } } })]) {
      writeFileSync(join(root, CREATED_PROFILES_FILE), text);
      expect(refusal(() => requireOwnedProfile(pairing, root, "claude-code", "work")).reason, text.slice(0, 30)).toBe("not_owned");
    }
  });
  it("is Claude Code only; Codex (which may use the Windows Credential Manager) is refused with the reason", () => {
    const { pairing, root } = setup();
    for (const cli of ["codex", "kiro-cli", "__proto__", undefined, 5]) { const error = refusal(() => requireOwnedProfile(pairing, root, cli, "work")); expect(error.reason).toBe("unsupported"); }
    expect(refusal(() => requireOwnedProfile(pairing, root, "codex", "work")).message).toMatch(/Credential Manager/);
    expect(refusal(() => requireOwnedProfile(pairing, root, "claude-code", "../escape")).reason).toBe("invalid_request");
    expect(refusal(() => requireOwnedProfile(pairing, root, "claude-code", "C:\\Users\\me\\.claude")).reason).toBe("invalid_request");
  });
});

describe("no link at any level", () => {
  it("refuses when the profile folder itself is a link, and deletes nothing behind it", () => {
    const { pairing, root } = setup(), victim = scratch(); writeFileSync(join(victim, "keep.txt"), "x");
    createRuntimeProfile(root, "claude-code", "work"); rmSync(join(root, "claude-code", "work"), { recursive: true });
    if (!link(victim, join(root, "claude-code", "work"))) return;
    expect(refusal(() => requireOwnedProfile(pairing, root, "claude-code", "work")).reason).toBe("link");
    expect(refusal(() => removeOwnedProfile(pairing, root, "claude-code", "work")).reason).toBe("link");
    expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("x");
  });
  it("refuses when the CLI folder, the profile root or the pairing folder is a link", () => {
    for (const level of ["cli", "root", "pairing"] as const) {
      const real = setup(), other = scratch();
      createRuntimeProfile(real.root, "claude-code", "work");
      let pairing = real.pairing, root = real.root;
      if (level === "cli") { const moved = join(other, "claude-code"); rmSync(moved, { recursive: true, force: true }); mkdirSync(moved); mkdirSync(join(moved, "work")); rmSync(join(real.root, "claude-code"), { recursive: true }); if (!link(moved, join(real.root, "claude-code"))) continue; }
      if (level === "root") { const moved = join(other, "credential-profiles"); mkdirSync(moved, { recursive: true }); rmSync(moved, { recursive: true }); rmSync(real.root, { recursive: true }); mkdirSync(moved, { recursive: true }); mkdirSync(join(moved, "claude-code", "work"), { recursive: true }); writeFileSync(join(moved, CREATED_PROFILES_FILE), JSON.stringify({ version: 1, created: { "claude-code": { work: 1 } } })); if (!link(moved, real.root)) continue; }
      if (level === "pairing") { const alias = join(scratch(), "alias"); if (!link(real.pairing, alias)) continue; pairing = alias; root = credentialProfilesRoot(alias); }
      expect(refusal(() => requireOwnedProfile(pairing, root, "claude-code", "work")).reason, level).toBe("link");
      expect(existsSync(join(real.pairing, "credential-profiles")) || level !== "pairing", level).toBe(true);
    }
  });
  it("refuses when anything inside the profile is a link, and removes nothing", () => {
    const { pairing, root } = setup(), victim = scratch(); writeFileSync(join(victim, "keep.txt"), "x");
    const directory = createRuntimeProfile(root, "claude-code", "work").directory; writeFileSync(join(directory, ".credentials.json"), "secret");
    mkdirSync(join(directory, "deep")); if (!link(victim, join(directory, "deep", "out"))) return;
    expect(refusal(() => removeOwnedProfile(pairing, root, "claude-code", "work")).reason).toBe("link");
    expect(existsSync(join(directory, ".credentials.json"))).toBe(true); expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("x");
  });
  it("treats what Windows calls a reparse point (junction and others) as a link, at every level, by asking an inspector", () => {
    const { pairing, root } = setup(); createRuntimeProfile(root, "claude-code", "work");
    const asked: string[][] = [];
    expect(requireOwnedProfile(pairing, root, "claude-code", "work", { inspect: paths => { asked.push([...paths]); return paths.map(() => false); } })).toBeTruthy();
    expect(asked[0]).toEqual([pairing, root, join(root, "claude-code"), join(root, "claude-code", "work")]);
    for (let level = 0; level < 4; level++) expect(refusal(() => requireOwnedProfile(pairing, root, "claude-code", "work", { inspect: paths => paths.map((_, index) => index === level) })).reason, String(level)).toBe("link");
    // An inspector that cannot answer is "not proven", never "no link".
    expect(refusal(() => requireOwnedProfile(pairing, root, "claude-code", "work", { inspect: () => { throw new Error("powershell missing"); } })).reason).toBe("link");
    expect(refusal(() => requireOwnedProfile(pairing, root, "claude-code", "work", { inspect: () => [false] })).reason).toBe("link");
  });
  it("never touches a protected home (this Windows user's own sign-in), even when it is the folder in question", () => {
    const { pairing, root } = setup(); const directory = createRuntimeProfile(root, "claude-code", "work").directory;
    const error = refusal(() => requireOwnedProfile(pairing, root, "claude-code", "work", { protectedHomes: [directory] }));
    expect(error.reason).toBe("not_owned"); expect(error.message).toMatch(/own sign-in/);
  });
});

describe("remove, and the backups of a sign-out", () => {
  it("removes exactly the one profile folder, its record and its cached sign-in; other profiles and the root stay", () => {
    const { pairing, root } = setup();
    for (const name of ["work", "home"]) { const directory = createRuntimeProfile(root, "claude-code", name).directory; writeFileSync(join(directory, ".credentials.json"), "secret"); mkdirSync(join(directory, "backups")); writeFileSync(join(directory, "backups", "x"), "y"); }
    rememberCredentialStatus(root, "claude-code", "work", { loggedIn: true, identity: { maskedEmail: "ab***@example.com", plan: "team" } }); rememberCredentialStatus(root, "claude-code", "home", { loggedIn: true });
    removeOwnedProfile(pairing, root, "claude-code", "work");
    expect(existsSync(join(root, "claude-code", "work"))).toBe(false); expect(existsSync(join(root, "claude-code", "home", ".credentials.json"))).toBe(true);
    expect(isCreatedProfile(root, "claude-code", "work")).toBe(false); expect(isCreatedProfile(root, "claude-code", "home")).toBe(true);
    expect(cachedCredentialStatus(root, "claude-code", "work")).toBeNull(); expect(cachedCredentialStatus(root, "claude-code", "home")?.loggedIn).toBe(true);
    expect(refusal(() => removeOwnedProfile(pairing, root, "claude-code", "work")).reason).toBe("not_found");
  });
  it("deletes backups\\.claude.json.backup* only: plain files with that name, nothing else, nothing followed", () => {
    const { root } = setup(), directory = createRuntimeProfile(root, "claude-code", "work").directory, backups = join(directory, "backups");
    expect(deleteProfileBackups(directory)).toBe(0);
    mkdirSync(backups);
    for (const name of [".claude.json.backup", ".claude.json.backup.1730000000000", ".claude.json.backup-2", "keep.txt", ".claude.json", ".claude.json.backupx", "x.claude.json.backup"]) writeFileSync(join(backups, name), "old identity");
    writeFileSync(join(directory, ".claude.json"), "current");
    expect(deleteProfileBackups(directory)).toBe(3);
    for (const name of [".claude.json.backup", ".claude.json.backup.1730000000000", ".claude.json.backup-2"]) expect(existsSync(join(backups, name)), name).toBe(false);
    for (const name of ["keep.txt", ".claude.json", ".claude.json.backupx", "x.claude.json.backup"]) expect(existsSync(join(backups, name)), name).toBe(true);
    expect(existsSync(join(directory, ".claude.json"))).toBe(true);
  });
  it("refuses a backups folder or a backup entry that is a link", () => {
    const { root } = setup(), directory = createRuntimeProfile(root, "claude-code", "work").directory, victim = scratch(); writeFileSync(join(victim, ".claude.json.backup"), "x");
    if (!link(victim, join(directory, "backups"))) return;
    expect(refusal(() => deleteProfileBackups(directory)).reason).toBe("link"); expect(existsSync(join(victim, ".claude.json.backup"))).toBe(true);
  });
});
