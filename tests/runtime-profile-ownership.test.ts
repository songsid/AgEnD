import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cachedCredentialStatus, credentialProfilesRoot, ensureCredentialProfile, rememberCredentialStatus } from "../src/runtime-credential-profiles.js";
import { CREATED_PROFILES_FILE, ProfileOwnershipRefusal, createRuntimeProfile, deleteProfileBackups, isCreatedProfile, listRemovalLeftovers, removeOwnedProfile, requireOwnedProfile } from "../src/runtime-profile-ownership.js";

const directories: string[] = [];
const scratch = (): string => { const path = mkdtempSync(join(tmpdir(), "agend-ownership-")); directories.push(path); return path; };
afterEach(() => { for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); } });
const setup = () => { const pairing = scratch(), root = credentialProfilesRoot(pairing); return { pairing, root }; };
const refusal = async (run: () => unknown): Promise<ProfileOwnershipRefusal> => { try { await run(); } catch (error) { expect(error).toBeInstanceOf(ProfileOwnershipRefusal); return error as ProfileOwnershipRefusal; } throw Error("expected a refusal"); };
/** Creating a link may need a privilege on Windows; where it does not work the case is skipped, never faked. */
const link = (target: string, path: string): boolean => { try { symlinkSync(target, path, "dir"); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return false; throw error; } };

describe("proof of creation (Q4)", () => {
  it("records a profile the Runtime creates, and does not claim a folder that was already there", async () => {
    const { pairing, root } = setup();
    expect(createRuntimeProfile(root, "claude-code", "work")).toEqual({ directory: join(root, "claude-code", "work"), created: true });
    expect(isCreatedProfile(root, "claude-code", "work")).toBe(true);
    ensureCredentialProfile(root, "claude-code", "byhand");           // a folder the Runtime has no record of
    expect(createRuntimeProfile(root, "claude-code", "byhand").created).toBe(false);
    expect(isCreatedProfile(root, "claude-code", "byhand")).toBe(false);
    expect(createRuntimeProfile(root, "claude-code", "work").created).toBe(false);
    expect(await requireOwnedProfile(pairing, root, "claude-code", "work")).toBe(join(root, "claude-code", "work"));
    expect((await refusal(() => requireOwnedProfile(pairing, root, "claude-code", "byhand"))).reason).toBe("not_owned");
    expect((await refusal(() => requireOwnedProfile(pairing, root, "claude-code", "missing"))).reason).toBe("not_found");
  });
  it("a name that is also a property name is a name (null-prototype ledger)", async () => {
    const { pairing, root } = setup();
    for (const name of ["constructor", "toString", "hasOwnProperty", "valueOf"]) { expect(isCreatedProfile(root, "claude-code", name)).toBe(false); createRuntimeProfile(root, "claude-code", name); expect(await requireOwnedProfile(pairing, root, "claude-code", name)).toContain(name); }
  });
  it("a missing, damaged or hostile ledger records nothing, so nothing is removable remotely", async () => {
    const { pairing, root } = setup(); createRuntimeProfile(root, "claude-code", "work");
    for (const text of ["{", "[]", JSON.stringify({ version: 1, created: { "claude-code": ["work"] } }), JSON.stringify({ version: 2, created: { "claude-code": { work: 1 } } }), JSON.stringify({ version: 1, created: { "claude-code": { "../x": 1, work: "now" } } })]) {
      writeFileSync(join(root, CREATED_PROFILES_FILE), text);
      expect((await refusal(() => requireOwnedProfile(pairing, root, "claude-code", "work"))).reason, text.slice(0, 30)).toBe("not_owned");
    }
  });
  it("is Claude Code only; Codex (which may use the Windows Credential Manager) is refused with the reason", async () => {
    const { pairing, root } = setup();
    for (const cli of ["codex", "kiro-cli", "__proto__", undefined, 5]) { const error = await refusal(() => requireOwnedProfile(pairing, root, cli, "work")); expect(error.reason).toBe("unsupported"); }
    expect((await refusal(() => requireOwnedProfile(pairing, root, "codex", "work"))).message).toMatch(/Credential Manager/);
    expect((await refusal(() => requireOwnedProfile(pairing, root, "claude-code", "../escape"))).reason).toBe("invalid_request");
    expect((await refusal(() => requireOwnedProfile(pairing, root, "claude-code", "C:\\Users\\me\\.claude"))).reason).toBe("invalid_request");
  });
});

describe("no link at any level", () => {
  it("refuses when the profile folder itself is a link, and deletes nothing behind it", async () => {
    const { pairing, root } = setup(), victim = scratch(); writeFileSync(join(victim, "keep.txt"), "x");
    createRuntimeProfile(root, "claude-code", "work"); rmSync(join(root, "claude-code", "work"), { recursive: true });
    if (!link(victim, join(root, "claude-code", "work"))) return;
    expect((await refusal(() => requireOwnedProfile(pairing, root, "claude-code", "work"))).reason).toBe("link");
    expect((await refusal(() => removeOwnedProfile(pairing, root, "claude-code", "work"))).reason).toBe("link");
    expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("x");
  });
  it("refuses when the CLI folder, the profile root or the pairing folder is a link", async () => {
    for (const level of ["cli", "root", "pairing"] as const) {
      const real = setup(), other = scratch();
      createRuntimeProfile(real.root, "claude-code", "work");
      let pairing = real.pairing, root = real.root;
      if (level === "cli") { const moved = join(other, "claude-code"); rmSync(moved, { recursive: true, force: true }); mkdirSync(moved); mkdirSync(join(moved, "work")); rmSync(join(real.root, "claude-code"), { recursive: true }); if (!link(moved, join(real.root, "claude-code"))) continue; }
      if (level === "root") { const moved = join(other, "credential-profiles"); mkdirSync(moved, { recursive: true }); rmSync(moved, { recursive: true }); rmSync(real.root, { recursive: true }); mkdirSync(moved, { recursive: true }); mkdirSync(join(moved, "claude-code", "work"), { recursive: true }); writeFileSync(join(moved, CREATED_PROFILES_FILE), JSON.stringify({ version: 1, created: { "claude-code": { work: 1 } } })); if (!link(moved, real.root)) continue; }
      if (level === "pairing") { const alias = join(scratch(), "alias"); if (!link(real.pairing, alias)) continue; pairing = alias; root = credentialProfilesRoot(alias); }
      expect((await refusal(() => requireOwnedProfile(pairing, root, "claude-code", "work"))).reason, level).toBe("link");
      expect(existsSync(join(real.pairing, "credential-profiles")) || level !== "pairing", level).toBe(true);
    }
  });
  it("refuses when anything inside the profile is a link, and removes nothing", async () => {
    const { pairing, root } = setup(), victim = scratch(); writeFileSync(join(victim, "keep.txt"), "x");
    const directory = createRuntimeProfile(root, "claude-code", "work").directory; writeFileSync(join(directory, ".credentials.json"), "secret");
    mkdirSync(join(directory, "deep")); if (!link(victim, join(directory, "deep", "out"))) return;
    expect((await refusal(() => removeOwnedProfile(pairing, root, "claude-code", "work"))).reason).toBe("link");
    expect(existsSync(join(directory, ".credentials.json"))).toBe(true); expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("x");
  });
  it("treats what Windows calls a reparse point (junction and others) as a link, at every level, by asking an inspector", async () => {
    const { pairing, root } = setup(); createRuntimeProfile(root, "claude-code", "work");
    const asked: string[][] = [];
    expect(await requireOwnedProfile(pairing, root, "claude-code", "work", { inspect: paths => { asked.push([...paths]); return paths.map(() => false); } })).toBeTruthy();
    expect(asked[0]).toEqual([pairing, root, join(root, "claude-code"), join(root, "claude-code", "work")]);
    for (let level = 0; level < 4; level++) expect((await refusal(() => requireOwnedProfile(pairing, root, "claude-code", "work", { inspect: paths => paths.map((_, index) => index === level) }))).reason, String(level)).toBe("link");
    // An inspector that cannot answer is "not proven", never "no link".
    expect((await refusal(() => requireOwnedProfile(pairing, root, "claude-code", "work", { inspect: () => { throw new Error("powershell missing"); } }))).reason).toBe("link");
    expect((await refusal(() => requireOwnedProfile(pairing, root, "claude-code", "work", { inspect: () => [false] }))).reason).toBe("link");
  });
  it("never touches a protected home (this Windows user's own sign-in), even when it is the folder in question", async () => {
    const { pairing, root } = setup(); const directory = createRuntimeProfile(root, "claude-code", "work").directory;
    const error = await refusal(() => requireOwnedProfile(pairing, root, "claude-code", "work", { protectedHomes: [directory] }));
    expect(error.reason).toBe("not_owned"); expect(error.message).toMatch(/own sign-in/);
  });
});

describe("remove, and the backups of a sign-out", () => {
  it("removes exactly the one profile folder, its record and its cached sign-in; other profiles and the root stay", async () => {
    const { pairing, root } = setup();
    for (const name of ["work", "home"]) { const directory = createRuntimeProfile(root, "claude-code", name).directory; writeFileSync(join(directory, ".credentials.json"), "secret"); mkdirSync(join(directory, "backups")); writeFileSync(join(directory, "backups", "x"), "y"); }
    rememberCredentialStatus(root, "claude-code", "work", { loggedIn: true, identity: { maskedEmail: "ab***@example.com", plan: "team" } }); rememberCredentialStatus(root, "claude-code", "home", { loggedIn: true });
    await removeOwnedProfile(pairing, root, "claude-code", "work");
    expect(existsSync(join(root, "claude-code", "work"))).toBe(false); expect(existsSync(join(root, "claude-code", "home", ".credentials.json"))).toBe(true);
    expect(isCreatedProfile(root, "claude-code", "work")).toBe(false); expect(isCreatedProfile(root, "claude-code", "home")).toBe(true);
    expect(cachedCredentialStatus(root, "claude-code", "work")).toBeNull(); expect(cachedCredentialStatus(root, "claude-code", "home")?.loggedIn).toBe(true);
    expect((await refusal(() => removeOwnedProfile(pairing, root, "claude-code", "work"))).reason).toBe("not_found");
  });
  it("deletes backups\\.claude.json.backup* only: plain files with that name, nothing else, nothing followed", async () => {
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
  it("refuses a backups folder or a backup entry that is a link", async () => {
    const { root } = setup(), directory = createRuntimeProfile(root, "claude-code", "work").directory, victim = scratch(); writeFileSync(join(victim, ".claude.json.backup"), "x");
    if (!link(victim, join(directory, "backups"))) return;
    expect((await refusal(() => deleteProfileBackups(directory))).reason).toBe("link"); expect(existsSync(join(victim, ".claude.json.backup"))).toBe(true);
  });
});

describe("remove is rename, verify, then delete (a swap between the check and the delete)", () => {
  it("a folder swapped for a link after the checks is renamed as the link itself, found to be a link, put back, and nothing behind it is deleted", async () => {
    const { pairing, root } = setup(), victim = scratch(); writeFileSync(join(victim, "keep.txt"), "x");
    const directory = createRuntimeProfile(root, "claude-code", "work").directory;
    let swapped = false;
    const error = await refusal(() => removeOwnedProfile(pairing, root, "claude-code", "work", { afterChecks: () => { rmSync(directory, { recursive: true }); swapped = link(victim, directory); } }));
    if (!swapped) return;
    expect(error.reason).toBe("link"); expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("x");
    expect(existsSync(join(directory, "keep.txt"))).toBe(true);                                  // the link is back under the profile's name, untouched
    expect(readdirSync(join(root, "claude-code")).filter(name => name.startsWith(".removing-"))).toEqual([]);
  });
  it("a link planted INSIDE after the checks is also found after the rename, and the profile stays whole", async () => {
    const { pairing, root } = setup(), victim = scratch(); writeFileSync(join(victim, "keep.txt"), "x");
    const directory = createRuntimeProfile(root, "claude-code", "work").directory; writeFileSync(join(directory, ".credentials.json"), "secret");
    let planted = false;
    const error = await refusal(() => removeOwnedProfile(pairing, root, "claude-code", "work", { afterChecks: () => { planted = link(victim, join(directory, "late")); } }));
    if (!planted) return;
    expect(error.reason).toBe("link"); expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("x"); expect(existsSync(join(directory, ".credentials.json"))).toBe(true);
  });
  it("asks the inspector about the renamed folder too, and a reparse point found there puts the name back", async () => {
    const { pairing, root } = setup(), directory = createRuntimeProfile(root, "claude-code", "work").directory; writeFileSync(join(directory, "f"), "x");
    const asked: string[][] = [];
    const error = await refusal(() => removeOwnedProfile(pairing, root, "claude-code", "work", { inspect: paths => { asked.push([...paths]); return paths.map(() => asked.length === 2); } }));
    expect(error.reason).toBe("link"); expect(asked).toHaveLength(2); expect(asked[1]).toHaveLength(1); expect(asked[1]![0]).toMatch(/\.removing-[a-f0-9]{16}$/);
    expect(existsSync(join(directory, "f"))).toBe(true); expect(isCreatedProfile(root, "claude-code", "work")).toBe(true);
    await removeOwnedProfile(pairing, root, "claude-code", "work"); expect(existsSync(directory)).toBe(false);
  });
  it("the temporary name is not a valid profile name, so it is never listed or selectable", async () => {
    const { pairing, root } = setup(), directory = createRuntimeProfile(root, "claude-code", "work").directory;
    let seen: string[] = [];
    await removeOwnedProfile(pairing, root, "claude-code", "work", { inspect: paths => { seen = readdirSync(join(root, "claude-code")); return paths.map(() => false); } });
    expect(seen).toHaveLength(1); expect(seen[0]).toMatch(/^\.removing-/); expect(existsSync(directory)).toBe(false); expect(readdirSync(join(root, "claude-code"))).toEqual([]);
  });
});

describe("the folder above is checked again after the rename, and a leftover is never silent", () => {
  it("a CLI folder swapped for a link after the checks takes the rename elsewhere: found, put back, nothing behind the link deleted", async () => {
    const { pairing, root } = setup(), victim = scratch(); mkdirSync(join(victim, "work")); writeFileSync(join(victim, "work", "keep.txt"), "x");
    createRuntimeProfile(root, "claude-code", "work");
    let swapped = false;
    const error = await refusal(() => removeOwnedProfile(pairing, root, "claude-code", "work", { afterChecks: () => {
      rmSync(join(root, "claude-code"), { recursive: true }); swapped = link(victim, join(root, "claude-code")); } }));
    if (!swapped) return;
    expect(error.reason).toBe("link"); expect(error.message).toMatch(/not inside this Runtime's profile folder/);
    expect(readFileSync(join(victim, "work", "keep.txt"), "utf8")).toBe("x"); expect(readdirSync(victim)).toEqual(["work"]);
  });
  it("when it can be neither deleted nor put back, the error names the temporary folder's whereabouts (locally) and the folder is listed, never touched", async () => {
    const { pairing, root } = setup(), directory = createRuntimeProfile(root, "claude-code", "work").directory; writeFileSync(join(directory, ".credentials.json"), "secret");
    const error = await removeOwnedProfile(pairing, root, "claude-code", "work", { inspect: paths => { if (paths.length === 1) writeFileSync(directory, "in the way"); return paths.map(() => paths.length === 1); } }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toMatch(/left under a temporary name; see agend-runtime profile list/);
    const left = listRemovalLeftovers(root, "claude-code"); expect(left).toHaveLength(1); expect(left[0]).toMatch(/^\.removing-[a-f0-9]{16}$/);
    expect(readFileSync(join(root, "claude-code", left[0]!, ".credentials.json"), "utf8")).toBe("secret");
    expect(isCreatedProfile(root, "claude-code", "work")).toBe(true);                         // the record is not dropped for something that was not removed
  });
  it("lists nothing when there is none, ignores profile-looking folders and files and links, and is Claude Code only", () => {
    const { root } = setup(); expect(listRemovalLeftovers(root, "claude-code")).toEqual([]);
    createRuntimeProfile(root, "claude-code", "work"); mkdirSync(join(root, "claude-code", ".removing-xyz")); writeFileSync(join(root, "claude-code", ".removing-0123456789abcdef"), "a file");
    expect(listRemovalLeftovers(root, "claude-code")).toEqual([]); mkdirSync(join(root, "claude-code", ".removing-0123456789abcdef.d"));
    expect(listRemovalLeftovers(root, "claude-code")).toEqual([]); expect(() => listRemovalLeftovers(root, "codex")).toThrow(/Claude Code only/);
  });
});
