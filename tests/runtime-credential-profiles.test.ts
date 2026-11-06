import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CREDENTIAL_PROFILE_NAME, assertCredentialProfileCli, assertCredentialProfileName, cachedCredentialLogin, credentialProfileDirectory, credentialProfileReport, credentialProfilesRoot,
  ensureCredentialProfile, listCredentialProfileNames, parseCredentialProfileReport, rememberCredentialLogin, requireCredentialProfile, validCredentialProfileName, withCredentialProfile,
} from "../src/runtime-credential-profiles.js";
import { credentialProfileHome, isCredentialProfileName } from "../src/backend/credential-profile.js";
import { nativeCliEnvironment, probeCredentialProfileLogin, type NativeCliExecutable } from "../src/windows-cli-worker.js";

const directories: string[] = [];
function root(): string { const path = mkdtempSync(join(tmpdir(), "agend-credential-profiles-")); directories.push(path); return credentialProfilesRoot(path); }
afterEach(() => { for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); } });

describe("credential profile names", () => {
  it("accepts the same names the Linux/WSL credential_profile accepts", () => {
    for (const name of ["work", "Work-2", "a", "claude.personal", "x_y-z.1", "A".repeat(64)]) { expect(validCredentialProfileName(name), name).toBe(true); expect(isCredentialProfileName(name), name).toBe(true); }
  });
  it("refuses a path, a drive, a traversal, a link-looking or empty value; no name is ever cleaned up into a different one", () => {
    for (const bad of ["", " ", "..", ".", "../x", "..\\x", "a/b", "a\\b", "C:\\Users\\me\\.claude", "C:", "\\\\server\\share", "/etc", "~", "~/x", "work ", " work", "wo rk", "wo\0rk", "wo\nrk", "-work", ".work", "A".repeat(65), "wörk", "work;calc"]) {
      expect(validCredentialProfileName(bad), JSON.stringify(bad)).toBe(false);
      expect(() => assertCredentialProfileName(bad)).toThrow(/Credential profile names/);
    }
    for (const bad of [undefined, null, 5, {}, [], ["work"], true]) expect(validCredentialProfileName(bad)).toBe(false);
  });
  it("is a strict subset of the Linux rule: Windows device names and trailing dots are refused because they alias another folder", () => {
    for (const bad of ["con", "CON", "nul", "Aux", "prn", "com1", "LPT9", "com¹", "con.txt", "nul.anything", "work.", "work..", "conin$"]) expect(validCredentialProfileName(bad), bad).toBe(false);
    for (const ok of ["console", "company", "com10", "lpt", "nulled", "icon.x"]) expect(validCredentialProfileName(ok), ok).toBe(true);
    // Every name accepted here is accepted by the Linux rule (never the other way round).
    expect(CREDENTIAL_PROFILE_NAME.source).toBe("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
  });
  it("only Claude Code has a credential home on a Windows Runtime", () => {
    expect(assertCredentialProfileCli("claude-code")).toBe("claude-code");
    for (const bad of ["codex", "kiro-cli", "", undefined, "__proto__", "constructor", "toString"]) expect(() => assertCredentialProfileCli(bad)).toThrow(/Claude Code only/);
  });
});

describe("the name -> folder step", () => {
  it("joins under the Runtime's own root and never anywhere else", () => {
    const base = root();
    expect(credentialProfileDirectory(base, "claude-code", "work")).toBe(join(base, "claude-code", "work"));
    for (const bad of ["../escape", "..", "a/../../b", "C:\\x", "/abs"]) expect(() => credentialProfileDirectory(base, "claude-code", bad)).toThrow();
    // The same layout as the Linux profile home, but under the Runtime's profile.
    expect(credentialProfileHome("/data", "claude-code", "work")).toBe(resolve("/data", "credential-profiles", "claude-code", "work"));
  });
  it("fails closed for an unknown profile with the next step, and never creates it", () => {
    const base = root();
    expect(() => requireCredentialProfile(base, "claude-code", "work")).toThrow(/does not exist on this computer.*agend-runtime login claude-code work/);
    expect(() => requireCredentialProfile(base, "claude-code", "../work")).toThrow(/Credential profile names/);
    expect(listCredentialProfileNames(base, "claude-code")).toEqual([]);
  });
  it("ensure creates a private real folder, is idempotent, and refuses a name that is the same Windows folder as another", () => {
    const base = root(), directory = ensureCredentialProfile(base, "claude-code", "Work");
    expect(directory).toBe(join(base, "claude-code", "Work")); expect(statSync(directory).isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(statSync(directory).mode & 0o077).toBe(0);
    expect(ensureCredentialProfile(base, "claude-code", "Work")).toBe(directory);
    expect(() => ensureCredentialProfile(base, "claude-code", "work")).toThrow(/same folder as "Work"/);
    expect(requireCredentialProfile(base, "claude-code", "Work")).toBe(directory);
  });
  it("does not follow a link: a profile that is a symlink is neither listed nor usable", () => {
    const base = root(); ensureCredentialProfile(base, "claude-code", "real");
    const outside = mkdtempSync(join(tmpdir(), "agend-credential-outside-")); directories.push(outside);
    symlinkSync(outside, join(base, "claude-code", "linked"));
    expect(listCredentialProfileNames(base, "claude-code")).toEqual(["real"]);
    expect(() => requireCredentialProfile(base, "claude-code", "linked")).toThrow(/must be a real folder|does not exist/);
  });
  it("lists only valid, real, folder entries", () => {
    const base = root(); for (const name of ["b", "a"]) ensureCredentialProfile(base, "claude-code", name);
    writeFileSync(join(base, "claude-code", "file.txt"), "x"); mkdirSync(join(base, "claude-code", "bad name"));
    expect(listCredentialProfileNames(base, "claude-code")).toEqual(["a", "b"]);
    expect(readdirSync(join(base, "claude-code")).sort()).toContain("bad name");
  });
});

describe("what is reported back", () => {
  it("is names and a signed-in yes/no only, from the disk plus the last check", () => {
    const base = root(); for (const name of ["work", "home", "new"]) ensureCredentialProfile(base, "claude-code", name);
    rememberCredentialLogin(base, "claude-code", "work", true); rememberCredentialLogin(base, "claude-code", "home", false);
    expect(cachedCredentialLogin(base, "claude-code", "work")).toBe(true); expect(cachedCredentialLogin(base, "claude-code", "new")).toBeNull();
    const report = credentialProfileReport(base, "work");
    expect(report).toEqual({ profiles: [{ name: "home", loggedIn: false }, { name: "new", loggedIn: null }, { name: "work", loggedIn: true }], default: "work" });
    expect(JSON.stringify(report)).not.toContain(base);
    // A default that is not a profile on disk is not reported.
    expect(credentialProfileReport(base, "gone").default).toBeUndefined();
  });
  it("is parsed closed: a path, an e-mail, a token or an unknown key is a protocol error", () => {
    expect(parseCredentialProfileReport({ profiles: [{ name: "work", loggedIn: true }], default: "work" })).toEqual({ profiles: [{ name: "work", loggedIn: true }], default: "work" });
    for (const bad of [null, [], "x", { profiles: "x" }, { profiles: [{ name: "work", loggedIn: true, path: "C:\\x" }] }, { profiles: [{ name: "work", loggedIn: true, email: "a@b.c" }] },
      { profiles: [{ name: "C:\\x", loggedIn: true }] }, { profiles: [{ name: "work", loggedIn: "yes" }] }, { profiles: [{ name: "a", loggedIn: true }, { name: "A", loggedIn: true }] },
      { profiles: [], default: "work" }, { profiles: [{ name: "work", loggedIn: true }], token: "x" }, { profiles: Array.from({ length: 65 }, (_, i) => ({ name: `p${i}`, loggedIn: null })) }])
      expect(() => parseCredentialProfileReport(bad), JSON.stringify(bad)).toThrow(/Invalid credential profile report/);
  });
});

describe("the environment a CLI run gets", () => {
  it("puts the profile folder in CLAUDE_CONFIG_DIR and removes any ambient value, whatever its letter case", () => {
    const env = withCredentialProfile({ PATH: "p", CLAUDE_CONFIG_DIR: "C:\\ambient", Claude_Config_Dir: "C:\\other", claude_config_dir: "C:\\third", HOME: "h" }, "claude-code", "C:\\rt\\credential-profiles\\claude-code\\work");
    expect(Object.keys(env).filter(key => key.toUpperCase() === "CLAUDE_CONFIG_DIR")).toEqual(["CLAUDE_CONFIG_DIR"]);
    expect(env.CLAUDE_CONFIG_DIR).toBe("C:\\rt\\credential-profiles\\claude-code\\work"); expect(env.PATH).toBe("p"); expect(env.HOME).toBe("h");
    expect(() => withCredentialProfile({}, "codex", "C:\\x")).toThrow();
  });
  it("is applied on top of the runner's allowlist: no provider key or token comes along", () => {
    const env = withCredentialProfile(nativeCliEnvironment({ PATH: "p", ANTHROPIC_API_KEY: "sk-secret", CLAUDE_CODE_OAUTH_TOKEN: "t", USERPROFILE: "C:\\Users\\u" }), "claude-code", "C:\\p\\work");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined(); expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); expect(env.CLAUDE_CONFIG_DIR).toBe("C:\\p\\work"); expect(env.USERPROFILE).toBe("C:\\Users\\u");
  });
});

describe("is a profile signed in?", () => {
  const executable: NativeCliExecutable = { path: "C:\\claude.exe", command: "C:\\node.exe", args: ["C:\\cli.js"] };
  it("asks the CLI's own status command under that folder only (never a login)", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const ask = (json: string, ok = true) => probeCredentialProfileLogin("claude-code", "C:\\p\\work", async () => executable, async (_entry, args, env) => { calls.push({ args, env }); return { ok, text: json }; });
    expect(await ask('{"loggedIn":true}')).toBe(true);
    expect(await ask('{"loggedIn":false}')).toBe(false);
    expect(await ask("not json")).toBeNull();
    expect(await ask("", false)).toBeNull();
    for (const call of calls) { expect(call.args.slice(-2)).toEqual(["auth", "status"]); expect(call.args).not.toContain("login"); expect(call.env.CLAUDE_CONFIG_DIR).toBe("C:\\p\\work"); }
  });
  it("is unknown (null), never true, when the CLI cannot be found", async () => {
    expect(await probeCredentialProfileLogin("claude-code", "C:\\p\\work", async () => null)).toBeNull();
  });
});
