import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeMain } from "../src/runtime-cli.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { cachedCredentialLogin, cachedCredentialStatus, credentialProfilesRoot, ensureCredentialProfile } from "../src/runtime-credential-profiles.js";

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); } });
const scratch = (): string => { const path = mkdtempSync(join(tmpdir(), "agend-runtime-cli-credential-")); directories.push(path); return path; };
function setup() {
  const home = scratch(), program = scratch(), runtimeHome = join(home, ".agend-runtime"), root = credentialProfilesRoot(runtimeHome);
  const out: string[] = []; vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { out.push(String(chunk)); return true; });
  const probeLogin = vi.fn(async (_cli: "claude-code", _directory: string): Promise<boolean | null> => true);
  const runLogin = vi.fn(async (_exe: unknown, _args: string[], _env: NodeJS.ProcessEnv): Promise<number> => 0);
  const probeStatus = vi.fn(async (_cli: "claude-code", _directory: string): Promise<{ loggedIn: boolean | null; identity?: Record<string, unknown> }> => ({ loggedIn: true }));
  const run = (argv: string[], extra: Record<string, unknown> = {}) => runtimeMain(argv, { home, programDirectory: program, env: {}, probeLogin, runLogin, ...extra } as never);
  const runWithStatus = (argv: string[], extra: Record<string, unknown> = {}) => runtimeMain(argv, { home, programDirectory: program, env: {}, probeStatus, runLogin, ...extra } as never);
  return { home, runtimeHome, root, out, probeLogin, probeStatus, runLogin, run, runWithStatus, text: () => out.join("") };
}

describe("agend-runtime login claude-code NAME", () => {
  it("creates the named folder under this Runtime's profile, runs `claude auth login` there, and confirms it", async () => {
    const f = setup(); await f.run(["login", "claude-code", "work"]);
    const directory = join(f.root, "claude-code", "work"); expect(existsSync(directory)).toBe(true);
    expect(f.runLogin).toHaveBeenCalledTimes(1);
    const [, args, env] = f.runLogin.mock.calls[0]; expect(args).toEqual(["auth", "login"]); expect(env.CLAUDE_CONFIG_DIR).toBe(directory);
    expect(f.probeLogin).toHaveBeenCalledWith("claude-code", directory); expect(cachedCredentialLogin(f.root, "claude-code", "work")).toBe(true);
    expect(f.text()).toMatch(/never uploaded/); expect(f.text()).toMatch(/is signed in/);
  });
  it("replaces an ambient CLAUDE_CONFIG_DIR instead of combining with it", async () => {
    const f = setup(); await f.run(["login", "claude-code", "work"], { env: { CLAUDE_CONFIG_DIR: "C:\\somebody\\else", Claude_Config_Dir: "C:\\again" } });
    const env = f.runLogin.mock.calls[0][2]; expect(Object.keys(env).filter(key => key.toUpperCase() === "CLAUDE_CONFIG_DIR")).toEqual(["CLAUDE_CONFIG_DIR"]);
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(f.root, "claude-code", "work"));
  });
  it("says what to do when the sign-in did not complete, and remembers that it is not signed in", async () => {
    const f = setup(); f.probeLogin.mockResolvedValue(false);
    await expect(f.run(["login", "claude-code", "work"])).rejects.toThrow(/"work" is not signed in yet.*Run the same login command again/);
    expect(cachedCredentialLogin(f.root, "claude-code", "work")).toBe(false);
    f.runLogin.mockResolvedValue(1); f.probeLogin.mockResolvedValue(true);
    await expect(f.run(["login", "claude-code", "work"])).rejects.toThrow(/exited with 1/);
  });
  it.each(["../x", "..\\x", "C:\\Users\\me\\.claude", "a/b", "con", "work.", "", " work"])("refuses the name %j without creating anything or starting a CLI", async bad => {
    const f = setup();
    await expect(f.run(["login", "claude-code", bad])).rejects.toThrow();
    expect(f.runLogin).not.toHaveBeenCalled(); expect(existsSync(join(f.root, "claude-code"))).toBe(false);
  });
  it("supports Claude Code only, and takes no server, name or credential-profile option", async () => {
    const f = setup();
    await expect(f.run(["login", "codex", "work"])).rejects.toThrow(/Claude Code only/);
    await expect(f.run(["login", "claude-code"])).rejects.toThrow(/Usage/);
    await expect(f.run(["login", "claude-code", "work", "extra"])).rejects.toThrow();
    await expect(f.run(["login", "claude-code", "work", "--server", "https://x.test"])).rejects.toThrow(/Usage|only by connect/);
    expect(f.runLogin).not.toHaveBeenCalled();
  });
  it("uses the folder of --profile / AGEND_RUNTIME_HOME when given, so one Runtime profile owns its own accounts", async () => {
    const f = setup(), other = scratch();
    await f.run(["login", "claude-code", "work", "--profile", other]);
    expect(existsSync(join(other, "credential-profiles", "claude-code", "work"))).toBe(true); expect(existsSync(f.root)).toBe(false);
    const env = scratch(); await f.run(["login", "claude-code", "home"], { env: { AGEND_RUNTIME_HOME: env } });
    expect(existsSync(join(env, "credential-profiles", "claude-code", "home"))).toBe(true);
  });
});

describe("agend-runtime profile list / default", () => {
  it("lists each profile with its live sign-in state, and says how to create one when there is none", async () => {
    const f = setup(); await f.run(["profile", "list"]); expect(f.text()).toMatch(/No credential profiles yet.*agend-runtime login claude-code NAME/);
    ensureCredentialProfile(f.root, "claude-code", "work"); ensureCredentialProfile(f.root, "claude-code", "home"); ensureCredentialProfile(f.root, "claude-code", "odd");
    f.probeLogin.mockImplementation(async (_cli, directory) => directory.endsWith("work") ? true : directory.endsWith("home") ? false : null);
    f.out.length = 0; await f.run(["profile", "list"]);
    expect(f.text().split("\n").filter(Boolean)).toEqual(["home\tnot signed in", "odd\tnot checked", "work\tsigned in"]);
    expect(f.text()).not.toContain(f.root);
  });
  it("sets and clears this pairing's default, after checking that it exists and is signed in", async () => {
    const f = setup(); ensureCredentialProfile(f.root, "claude-code", "work");
    const store = () => new RuntimeClientStore(f.runtimeHome);
    await f.run(["profile", "default", "work"]); expect(store().credentialDefault()).toBe("work");
    await f.run(["profile", "default", "--clear"]); expect(store().credentialDefault()).toBeUndefined();
    await expect(f.run(["profile", "default", "ghost"])).rejects.toThrow(/does not exist on this computer/);
    f.probeLogin.mockResolvedValueOnce(false); await expect(f.run(["profile", "default", "work"])).rejects.toThrow(/not signed in/);
    f.probeLogin.mockResolvedValueOnce(null); await expect(f.run(["profile", "default", "work"])).rejects.toThrow(/could not confirm/);
    await expect(f.run(["profile", "default", "../work"])).rejects.toThrow(/Credential profile names/);
    expect(store().credentialDefault()).toBeUndefined();
  });
  it("rejects malformed profile commands", async () => {
    const f = setup();
    for (const argv of [["profile"], ["profile", "unknown"], ["profile", "default"], ["profile", "default", "a", "b"], ["profile", "default", "a", "--clear"], ["profile", "list", "extra"], ["profile", "list", "--clear"]])
      await expect(f.run(argv), argv.join(" ")).rejects.toThrow();
  });
  it("keeps a default only for as long as the pairing: disconnect forgets it with the connection", () => {
    const store = new RuntimeClientStore(scratch()); store.setCredentialDefault("work"); expect(store.credentialDefault()).toBe("work");
    store.forgetCredentials(); expect(store.credentialDefault()).toBeUndefined();
    expect(() => store.setCredentialDefault("../work")).toThrow(/Credential profile names/);
  });
  it("status reports names and signed-in state, never a folder or an account", async () => {
    const f = setup(); ensureCredentialProfile(f.root, "claude-code", "work");
    await f.run(["profile", "list"]); f.out.length = 0; await f.run(["status"]);
    const status = JSON.parse(f.text()); expect(status.credentialProfiles).toEqual({ profiles: [{ name: "work", loggedIn: true, created: false }] });   // a folder made without the Runtime recording it (#3190 Part 3c)
    expect(JSON.stringify(status.credentialProfiles)).not.toContain(f.root);
  });
});

describe("arguments", () => {
  it("--credential-profile belongs to connect only, and a pairing code is still never accepted as an argument", async () => {
    const f = setup();
    await expect(f.run(["status", "--credential-profile", "work"])).rejects.toThrow(/used only by connect/);
    await expect(f.run(["connect", "123456"])).rejects.toThrow(/Pairing codes must be entered interactively/);
    await expect(f.run(["run", "work"])).rejects.toThrow(/Pairing codes must be entered interactively/);
    await expect(f.run(["connect", "--credential-profile"])).rejects.toThrow(/Invalid runtime arguments/);
    const help = readFileSync(resolve("src/runtime-cli.ts"), "utf8"); expect(help).toContain("--credential-profile NAME");
  });
});

describe("the account behind a profile, in agend-runtime's own output (masked, as AgEnD shows it)", () => {
  it("login says which account was signed in, as a masked address and plan, and remembers it for the running Runtime to report", async () => {
    const f = setup(); f.probeStatus.mockResolvedValue({ loggedIn: true, identity: { maskedEmail: "al***@example.com", plan: "team" } });
    await f.runWithStatus(["login", "claude-code", "work"]);
    expect(f.text()).toContain('Credential profile "work" is signed in (al***@example.com · team).');
    expect(cachedCredentialStatus(f.root, "claude-code", "work")).toEqual({ loggedIn: true, identity: { maskedEmail: "al***@example.com", plan: "team" } });
    expect(f.text()).not.toMatch(/alice|fixture/);
  });
  it("profile list adds the masked account, or API key, as a third column", async () => {
    const f = setup(); for (const name of ["work", "key", "plain"]) ensureCredentialProfile(f.root, "claude-code", name);
    f.probeStatus.mockImplementation(async (_cli, directory) => directory.endsWith("work") ? { loggedIn: true, identity: { maskedEmail: "al***@example.com", plan: "max" } } : directory.endsWith("key") ? { loggedIn: true, identity: { apiKey: true } } : { loggedIn: true });
    await f.runWithStatus(["profile", "list"]);
    expect(f.text().split("\n").filter(Boolean)).toEqual(["key\tsigned in\tAPI key", "plain\tsigned in", "work\tsigned in\tal***@example.com · max"]);
  });
  it("profile default and a boolean-only check keep nothing stale: the account is whatever the last answer said", async () => {
    const f = setup(); ensureCredentialProfile(f.root, "claude-code", "work");
    f.probeStatus.mockResolvedValue({ loggedIn: true, identity: { maskedEmail: "al***@example.com", plan: "team" } });
    await f.runWithStatus(["profile", "default", "work"]); expect(cachedCredentialStatus(f.root, "claude-code", "work")?.identity).toEqual({ maskedEmail: "al***@example.com", plan: "team" });
    await f.run(["profile", "list"]); expect(cachedCredentialStatus(f.root, "claude-code", "work")).toEqual({ loggedIn: true });
  });
});

describe("profile default while the Runtime is running", () => {
  it("works with the Runtime's profile lock held (no need to stop it), and the Runtime reads the new default", async () => {
    const f = setup(); ensureCredentialProfile(f.root, "claude-code", "work"); ensureCredentialProfile(f.root, "claude-code", "home");
    const running = new RuntimeClientStore(f.runtimeHome), unlock = running.lock("a-running-runtime");   // what `run` holds for as long as it is connected
    try {
      await f.run(["profile", "default", "work"]); expect(running.credentialDefault()).toBe("work");
      await f.run(["profile", "default", "home"]); expect(running.credentialDefault()).toBe("home");
      expect(f.text()).toMatch(/A running Runtime uses it from the next run or new terminal/); expect(f.text()).not.toMatch(/Restart the Runtime/);
      await f.run(["profile", "default", "--clear"]); expect(running.credentialDefault()).toBeUndefined();
    } finally { unlock(); }
  });
  it("still refuses what it always refused with the lock held: the commands that rewrite the connection", async () => {
    const f = setup(), running = new RuntimeClientStore(f.runtimeHome), unlock = running.lock("a-running-runtime");
    try { await expect(f.run(["disconnect"])).rejects.toThrow(/Another runtime already uses this profile/); } finally { unlock(); }
  });
});


describe("profile default against a removal that AgEnD carries out at the same time", () => {
  it("a profile that is taken away while its sign-in is being probed is not made the default", async () => {
    const f = setup(); const directory = ensureCredentialProfile(f.root, "claude-code", "work");
    const { renameSync } = await import("node:fs");
    await expect(f.runWithStatus(["profile", "default", "work"], { probeStatus: async () => { renameSync(directory, `${directory}.gone`); return { loggedIn: true }; } })).rejects.toThrow(/does not exist/);
    expect(new RuntimeClientStore(f.runtimeHome).credentialDefault()).toBeUndefined();
  });
  it("a profile that is taken away right after the default was written: the default goes back to what it was, and the command says why", async () => {
    const f = setup(); ensureCredentialProfile(f.root, "claude-code", "other"); const directory = ensureCredentialProfile(f.root, "claude-code", "work");
    await f.run(["profile", "default", "other"]);
    const { renameSync } = await import("node:fs"); const original = RuntimeClientStore.prototype.setCredentialDefault; let moved = false;
    vi.spyOn(RuntimeClientStore.prototype, "setCredentialDefault").mockImplementation(function (this: RuntimeClientStore, name: string | undefined) { original.call(this, name); if (name === "work" && !moved) { moved = true; renameSync(directory, `${directory}.gone`); } });
    await expect(f.run(["profile", "default", "work"])).rejects.toThrow(/being removed or is gone, so it was not made the default/);
    expect(new RuntimeClientStore(f.runtimeHome).credentialDefault()).toBe("other");
  });
  it("with nothing in the way the default is set as before", async () => {
    const f = setup(); ensureCredentialProfile(f.root, "claude-code", "work"); await f.run(["profile", "default", "work"]); expect(new RuntimeClientStore(f.runtimeHome).credentialDefault()).toBe("work");
  });
});
