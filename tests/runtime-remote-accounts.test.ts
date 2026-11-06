import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteAccounts, type RemoteAccountsDeps, type RemoteStatusAnswer } from "../src/runtime-remote-accounts.js";
import { cachedCredentialStatus, credentialProfilesRoot } from "../src/runtime-credential-profiles.js";
import { createRuntimeProfile, isCreatedProfile } from "../src/runtime-profile-ownership.js";
import { AUDIT_FILE, setRemoteSwitch } from "../src/runtime-remote-setup.js";
import { parseRuntimeRemotePayload } from "../src/runtime-protocol.js";
import { REDUCED_CODE_PROMPT, REDUCED_SUCCESS, REDUCED_URL_PREFIX } from "../src/runtime-signin.js";

const URL_OK = "https://claude.com/cai/oauth/authorize?code=true&client_id=fixture&response_type=code&state=STATE-NEVER-LOGGED";
const CODE = "SECRETCODE123-abc";
const directories: string[] = [];
const scratch = (): string => { const path = mkdtempSync(join(tmpdir(), "agend-remote-accounts-")); directories.push(path); return path; };
afterEach(() => { vi.useRealTimers(); for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); } });

class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); pid = 77; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; killed = false; written = "";
  constructor() { super(); this.stdin.on("data", chunk => { this.written += chunk.toString(); }); }
  end(code: number): void { this.exitCode = code; this.emit("close", code); }
  kill(): boolean { this.killed = true; queueMicrotask(() => { if (this.exitCode === null) this.end(1); }); return true; }
}
function fixture(extra: Partial<RemoteAccountsDeps> = {}) {
  const pairing = scratch(), root = credentialProfilesRoot(pairing), children: FakeChild[] = [], spawned: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = [];
  let now = 1_700_000_000_000;
  let answer: RemoteStatusAnswer = { loggedIn: false };
  const status = vi.fn(async (): Promise<RemoteStatusAnswer> => answer);
  const runLogout = vi.fn(async (): Promise<number | null> => { answer = { loggedIn: false }; return 0; });
  const changed = vi.fn(); const inUse = vi.fn((): "task" | "pane" | undefined => undefined); const defaultProfile = vi.fn((): string | undefined => undefined);
  const deps: RemoteAccountsDeps = { pairingDirectory: pairing, credentialRoot: root, now: () => now, status, find: async () => ({ path: "claude.exe", command: "claude.exe", args: [] }), environment: () => ({ PATH: "p" }),
    runLogout, inUse, defaultProfile, changed,
    signIn: { scratchRoot: scratch(), spawn: (_c, args, options) => { spawned.push({ args, env: options.env }); const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess; } },
    ...extra };
  const accounts = new RemoteAccounts(deps);
  return { accounts, pairing, root, children, spawned, status, runLogout, changed, inUse, defaultProfile, tick: (ms: number) => { now += ms; }, setAnswer: (value: RemoteStatusAnswer) => { answer = value; },
    on: (name: "accounts" | "install" = "accounts") => setRemoteSwitch(pairing, name, true, undefined, now),
    audit: (): Array<Record<string, unknown>> => existsSync(join(pairing, AUDIT_FILE)) ? readFileSync(join(pairing, AUDIT_FILE), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [],
    auditText: (): string => existsSync(join(pairing, AUDIT_FILE)) ? readFileSync(join(pairing, AUDIT_FILE), "utf8") : "" };
}
type F = ReturnType<typeof fixture>;
const ask = (f: F, operation: string, payload: unknown): Promise<any> => f.accounts.handle(operation, payload);
const actor = "admin:u1";
const owned = (f: F, name = "work"): string => createRuntimeProfile(f.root, "claude-code", name).directory;

describe("switches gate every operation", () => {
  it("refuses each accounts operation while its switch is off, with the command to run on that computer, and records the refusal", async () => {
    const f = fixture(); owned(f);
    const requests: Array<[string, unknown]> = [["signin.start", { cli: "claude-code", profile: "work", method: "subscription", actor }], ["accounts.signout", { cli: "claude-code", profile: "work", actor }],
      ["accounts.remove", { cli: "claude-code", profile: "work", actor }], ["accounts.check", { cli: "claude-code", profile: "work" }]];
    for (const [operation, payload] of requests) await expect(ask(f, operation, payload), operation).rejects.toThrow(/turned off.*agend-runtime remote-setup accounts on/);
    await expect(ask(f, "cli.install", { cli: "claude-code", actor })).rejects.toThrow(/agend-runtime remote-setup install on/);
    expect(f.spawned).toHaveLength(0); expect(f.runLogout).not.toHaveBeenCalled(); expect(existsSync(join(f.root, "claude-code", "work"))).toBe(true);
    expect(f.audit().filter(row => row.outcome === "refused" && row.reason === "switch_off").map(row => row.action)).toEqual(["signin", "profile.signout", "profile.remove", "cli.install"]);
  });
  it("keeps the two scopes independent", async () => {
    const f = fixture({ install: async () => ({ version: "2.1.318" }) }); owned(f); f.on("install");
    await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/accounts.*turned off/);
    await expect(ask(f, "cli.install", { cli: "claude-code", actor })).resolves.toEqual({ version: "2.1.318" });
    f.on("accounts"); setRemoteSwitch(f.pairing, "install", false);
    await expect(ask(f, "cli.install", { cli: "claude-code", actor })).rejects.toThrow(/install.*turned off/);
    await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).resolves.toEqual({ removed: true });
  });
  it("a switch that expires stops the next request", async () => {
    const f = fixture(); owned(f); setRemoteSwitch(f.pairing, "accounts", true, 60_000, 1_700_000_000_000);
    await expect(ask(f, "accounts.check", { cli: "claude-code", profile: "work" })).resolves.toMatchObject({ loggedIn: false });
    f.tick(61_000); await expect(ask(f, "accounts.check", { cli: "claude-code", profile: "work" })).rejects.toThrow(/turned off/);
  });
  it("reports the switches (read only) without needing either to be on", async () => {
    const f = fixture(); expect(await ask(f, "accounts.switches", {})).toEqual({ accounts: { on: false }, install: { on: false } });
    f.on("accounts"); expect((await ask(f, "accounts.switches", {})).accounts).toEqual({ on: true });
    await expect(ask(f, "accounts.switches", { accounts: true })).rejects.toThrow(/unknown field/);
  });
  it("turning the switch off ends a sign-in that is still open", async () => {
    const f = fixture(); f.on();
    const { sessionId } = await ask(f, "signin.start", { cli: "claude-code", profile: "work", method: "subscription", actor });
    setRemoteSwitch(f.pairing, "accounts", false, undefined, 1_700_000_000_000);
    await expect(ask(f, "signin.capture", { sessionId })).rejects.toThrow(/turned off/);
    expect(f.children[0]!.killed).toBe(true); expect(f.audit().at(-1)).toMatchObject({ action: "signin", outcome: "failed", reason: "switch_off" });
  });
});

describe("the request has only names and ids", () => {
  it("is a closed shape: an argv, a command, a path, an environment or any extra field is refused, naming the field only", async () => {
    const f = fixture(); f.on(); owned(f);
    const good = { cli: "claude-code", profile: "work", method: "subscription", actor };
    for (const extra of [{ argv: ["cmd", "/c", "calc"] }, { command: "calc" }, { path: "C:\\x" }, { env: { CLAUDE_CONFIG_DIR: "C:\\x" } }, { cwd: "C:\\" }, { configDir: "C:\\x" }]) {
      const key = Object.keys(extra)[0]!;
      await expect(ask(f, "signin.start", { ...good, ...extra }), key).rejects.toThrow(/./);
      expect(() => parseRuntimeRemotePayload("signin.start", { ...good, ...extra })).toThrow(/unknown field/);
    }
    expect(f.spawned).toHaveLength(0);
    for (const bad of [{ profile: "C:\\Users\\me\\.claude" }, { profile: "../x" }, { profile: "a/b" }, { profile: "" }, { cli: "claude-code && calc" }, { cli: "CLAUDE" }, { method: "device" }, { actor: "a b" }, { actor: "x@y.com" }, { profile: 5 }]) {
      expect(() => parseRuntimeRemotePayload("signin.start", { ...good, ...bad }), JSON.stringify(bad)).toThrow(/Invalid signin.start request: (profile|cli|method|actor)/);
    }
    expect(() => parseRuntimeRemotePayload("signin.start", null)).toThrow(/payload/); expect(() => parseRuntimeRemotePayload("signin.start", [])).toThrow(/payload/);
    expect(() => parseRuntimeRemotePayload("signin.write", { sessionId: "0".repeat(32), input: "é".repeat(2100) })).toThrow(/input/);
    await expect(ask(f, "launch.anything", {})).rejects.toThrow(/Unknown runtime operation/);
  });
  it("names no value in the error: a rejected code is not echoed", () => {
    try { parseRuntimeRemotePayload("signin.write", { sessionId: "bad", input: CODE }); } catch (error) { expect((error as Error).message).not.toContain(CODE); expect((error as Error).message).toBe("Invalid signin.write request: sessionId"); }
  });
  it("only Claude Code: Codex is refused with the reason, for every operation", async () => {
    const f = fixture(); f.on(); f.on("install");
    for (const [operation, payload] of [["signin.start", { cli: "codex", profile: "work", method: "subscription", actor }], ["accounts.check", { cli: "codex", profile: "work" }], ["accounts.signout", { cli: "codex", profile: "work", actor }], ["accounts.remove", { cli: "codex", profile: "work", actor }]] as Array<[string, unknown]>) {
      await expect(ask(f, operation, payload), operation).rejects.toThrow(/Only Claude Code.*Windows Credential Manager/);
    }
    expect(f.spawned).toHaveLength(0);
  });
});

describe("add account and sign in (Runtime side of RuntimeSignInTransport)", () => {
  async function begin(f: F, name = "work") {
    const { sessionId } = await ask(f, "signin.start", { cli: "claude-code", profile: name, method: "subscription", actor });
    return { sessionId, child: f.children.at(-1)! };
  }
  it("creates the profile (and records that the Runtime made it), then runs the CLI under that folder with the profile's variable", async () => {
    const f = fixture(); f.on();
    const { sessionId } = await begin(f);
    expect(isCreatedProfile(f.root, "claude-code", "work")).toBe(true);
    expect(f.spawned[0]!.args).toEqual(["auth", "login", "--claudeai"]);
    expect(f.spawned[0]!.env).toMatchObject({ CLAUDE_CONFIG_DIR: join(f.root, "claude-code", "work"), BROWSER: "true", PATH: "p" });
    expect(sessionId).toMatch(/^[a-f0-9]{32}$/);
    expect(f.audit().map(row => `${row.action}:${row.outcome}`)).toEqual(["signin:started", "profile.add:ok"]);
  });
  it("end to end: the screen carries the URL and prompt; one code goes in; success is the CLI's own `auth status`, not output text; the record never holds a URL, code or e-mail", async () => {
    const f = fixture(); f.on(); const { sessionId, child } = await begin(f);
    child.stdout.write(`Opening browser to sign in…\nIf the browser didn't open, visit: ${URL_OK}\nPaste code here if prompted >`);
    expect(await ask(f, "signin.capture", { sessionId })).toEqual({ screen: `${REDUCED_URL_PREFIX}${URL_OK}\n${REDUCED_CODE_PROMPT}\n` });
    expect(await ask(f, "signin.status", { sessionId })).toEqual({ alive: true });
    await expect(ask(f, "signin.write", { sessionId, input: "\x1b[B\r" })).rejects.toThrow(/not a sign-in code/);
    await expect(ask(f, "signin.write", { sessionId, input: `\x15${CODE}\r` })).resolves.toEqual({ accepted: true }); expect(child.written).toBe(`${CODE}\n`);
    await expect(ask(f, "signin.write", { sessionId, input: "\x15SECOND\r" })).rejects.toThrow(/one code/);
    child.stdout.write("\nLogged in as alice@example.com\n"); child.end(0);
    expect((await ask(f, "signin.capture", { sessionId })).screen).toBe(`${REDUCED_SUCCESS}\n`);
    expect(await ask(f, "signin.status", { sessionId })).toEqual({ alive: false, exitCode: 0 });
    f.setAnswer({ loggedIn: true, identity: { maskedEmail: "al***@example.com", plan: "team" } });
    expect(await ask(f, "accounts.check", { cli: "claude-code", profile: "work" })).toEqual({ loggedIn: true, identity: { maskedEmail: "al***@example.com", plan: "team" } });
    expect(cachedCredentialStatus(f.root, "claude-code", "work")).toEqual({ loggedIn: true, identity: { maskedEmail: "al***@example.com", plan: "team" } });
    expect(f.changed).toHaveBeenCalled();
    await expect(ask(f, "signin.close", { sessionId })).resolves.toEqual({ closed: true });
    expect(child.killed || child.exitCode === 0).toBe(true);
    expect(f.audit().at(-1)).toMatchObject({ actor, action: "signin", outcome: "ok", cli: "claude-code", profile: "work" });
    const text = f.auditText(); for (const secret of [URL_OK, "STATE-NEVER-LOGGED", CODE, "alice", "example.com", "oauth", "Logged in"]) expect(text, secret).not.toContain(secret);
  });
  it("a sign-in that ends without being signed in is recorded as failed", async () => {
    const f = fixture(); f.on(); const { sessionId, child } = await begin(f);
    child.stdout.write(`If the browser didn't open, visit: ${URL_OK}\nPaste code here if prompted >`); await ask(f, "signin.write", { sessionId, input: `${CODE}\r` });
    child.stdout.write("\nLogin failed: Request failed with status code 400\n"); child.end(1);
    expect((await ask(f, "signin.capture", { sessionId })).screen).toBe("Login failed: Request failed with status code 400\n");
    f.setAnswer({ loggedIn: false }); expect(await ask(f, "accounts.check", { cli: "claude-code", profile: "work" })).toEqual({ loggedIn: false });
    await ask(f, "signin.close", { sessionId });
    expect(f.audit().at(-1)).toMatchObject({ action: "signin", outcome: "failed", reason: "failed" });
  });
  it("one sign-in at a time and no too-fast starts, whatever the server asks, and the second leaves no child", async () => {
    const f = fixture(); f.on(); const { sessionId } = await begin(f);
    await expect(ask(f, "signin.start", { cli: "claude-code", profile: "home", method: "subscription", actor })).rejects.toThrow(/Another sign-in/);
    expect(f.children).toHaveLength(1);
    await ask(f, "signin.close", { sessionId });
    await expect(ask(f, "signin.start", { cli: "claude-code", profile: "home", method: "subscription", actor })).rejects.toThrow(/too quickly/);
    f.tick(6000); await begin(f, "home"); expect(f.children).toHaveLength(2);
  });
  it("times out after ten minutes by itself, leaves no child, and records the timeout", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.on(); const { child } = await begin(f);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 50);
    expect(child.killed).toBe(true); expect(f.audit().at(-1)).toMatchObject({ action: "signin", outcome: "failed", reason: "timeout" });
  });
  it("refuses to sign in a folder the Runtime did not create, or one that is in use, and cannot be steered to another account's id", async () => {
    const f = fixture(); f.on(); mkdirSync(join(f.root, "claude-code", "byhand"), { recursive: true });
    await expect(ask(f, "signin.start", { cli: "claude-code", profile: "byhand", method: "subscription", actor })).rejects.toThrow(/not created by this Runtime/);
    owned(f, "busy"); f.inUse.mockReturnValue("task");
    await expect(ask(f, "signin.start", { cli: "claude-code", profile: "busy", method: "subscription", actor })).rejects.toThrow(/in use by a running task/);
    expect(f.spawned).toHaveLength(0);
    await expect(ask(f, "signin.capture", { sessionId: "0".repeat(32) })).rejects.toThrow(/no longer running/);
    await expect(ask(f, "signin.write", { sessionId: "0".repeat(32), input: "x" })).rejects.toThrow(/no longer running/);
  });
  it("says so when Claude Code is not installed", async () => {
    const f = fixture({ find: async () => null }); f.on();
    await expect(ask(f, "signin.start", { cli: "claude-code", profile: "work", method: "subscription", actor })).rejects.toThrow(/Claude Code is not installed/);
  });
  it("a protocol error from an unmasked identity names the field only: the CLI-side read is checked again before anything is stored or sent", async () => {
    const f = fixture(); f.on(); owned(f);
    f.setAnswer({ loggedIn: true, identity: { maskedEmail: "alice@example.com", plan: "team" } });
    const error = await ask(f, "accounts.check", { cli: "claude-code", profile: "work" }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error); expect(String((error as Error).message)).not.toContain("alice");
    expect(cachedCredentialStatus(f.root, "claude-code", "work")?.identity).toBeUndefined();
    f.setAnswer({ loggedIn: true, identity: { maskedEmail: "al***@example.com", plan: "gold" as never } });
    expect(String(((await ask(f, "accounts.check", { cli: "claude-code", profile: "work" }).catch((e: Error) => e)) as Error).message)).not.toContain("gold");
  });
  it("shows nothing but our own sentences on failure: a path, a stack or output from below becomes one fixed line", async () => {
    const f = fixture({ find: async () => { throw new Error("ENOENT: C:\\Users\\alice\\secret\\claude.exe https://claude.com/x?state=1 alice@example.com"); } }); f.on();
    const error = (await ask(f, "signin.start", { cli: "claude-code", profile: "work", method: "subscription", actor }).catch((e: Error) => e)) as Error;
    expect(error.message).toBe("The operation could not be completed on this computer. Check that computer's Runtime window.");
    expect(f.auditText()).not.toMatch(/alice|secret|claude\.com|ENOENT/);
  });
  it("does nothing, and says why, when the audit log cannot be written", async () => {
    const f = fixture(); f.on(); owned(f); mkdirSync(join(f.pairing, AUDIT_FILE));
    await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/could not write its audit log/);
    expect(existsSync(join(f.root, "claude-code", "work"))).toBe(true);
  });
});

describe("sign out", () => {
  it("runs the vendor's logout under the profile's variable, deletes backups\\.claude.json.backup*, confirms with `auth status`, and records it", async () => {
    const f = fixture(); f.on(); const directory = owned(f); mkdirSync(join(directory, "backups")); writeFileSync(join(directory, "backups", ".claude.json.backup.1"), "old identity"); writeFileSync(join(directory, "backups", "keep"), "x");
    f.setAnswer({ loggedIn: true }); f.runLogout.mockImplementation(async () => { f.setAnswer({ loggedIn: false }); return 0; });
    await expect(ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor })).resolves.toEqual({ loggedIn: false });
    const [executable, args, env] = f.runLogout.mock.calls[0] as unknown as [{ command: string }, string[], NodeJS.ProcessEnv];
    expect(executable.command).toBe("claude.exe"); expect(args).toEqual(["auth", "logout"]); expect(env.CLAUDE_CONFIG_DIR).toBe(directory);
    expect(existsSync(join(directory, "backups", ".claude.json.backup.1"))).toBe(false); expect(existsSync(join(directory, "backups", "keep"))).toBe(true);
    expect(cachedCredentialStatus(f.root, "claude-code", "work")).toEqual({ loggedIn: false });
    expect(f.audit().map(row => `${row.action}:${row.outcome}`)).toEqual(["profile.signout:started", "profile.signout:ok"]);
  });
  it("is a failure, not a success, when the CLI still says signed in afterwards", async () => {
    const f = fixture(); f.on(); owned(f); f.setAnswer({ loggedIn: true }); f.runLogout.mockResolvedValue(1);
    await expect(ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/still signed in/);
    expect(f.audit().at(-1)).toMatchObject({ action: "profile.signout", outcome: "refused" });
  });
  it("is limited like remove: not a profile the Runtime did not create, not one in use, not one being signed in", async () => {
    const f = fixture(); f.on(); mkdirSync(join(f.root, "claude-code", "byhand"), { recursive: true }); owned(f);
    await expect(ask(f, "accounts.signout", { cli: "claude-code", profile: "byhand", actor })).rejects.toThrow(/not created by this Runtime/);
    f.inUse.mockReturnValueOnce("pane"); await expect(ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/running terminal/);
    await ask(f, "signin.start", { cli: "claude-code", profile: "work", method: "subscription", actor });
    await expect(ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/sign-in for "work" is running/);
    expect(f.runLogout).not.toHaveBeenCalled();
  });
});

describe("remove", () => {
  it("deletes only the profile's own folder, writes the audit lines, and forgets the profile", async () => {
    const f = fixture(); f.on(); const directory = owned(f); owned(f, "home"); writeFileSync(join(directory, ".credentials.json"), "secret");
    await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).resolves.toEqual({ removed: true });
    expect(existsSync(directory)).toBe(false); expect(existsSync(join(f.root, "claude-code", "home"))).toBe(true); expect(isCreatedProfile(f.root, "claude-code", "work")).toBe(false);
    expect(f.audit().map(row => `${row.actor}:${row.action}:${row.outcome}:${row.profile}`)).toEqual([`${actor}:profile.remove:started:work`, `${actor}:profile.remove:ok:work`]);
    expect(f.changed).toHaveBeenCalled();
  });
  it("refuses while the pairing's default points to it (only this computer knows), while a task or terminal uses it, and while a sign-in runs, each with its reason in the record", async () => {
    const f = fixture(); f.on(); const directory = owned(f);
    f.defaultProfile.mockReturnValue("Work"); await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/default for agents.*agend-runtime profile default/);
    f.defaultProfile.mockReturnValue(undefined);
    f.inUse.mockReturnValue("task"); await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/running task/);
    f.inUse.mockReturnValue("pane"); await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/running terminal/);
    f.inUse.mockReturnValue(undefined);
    await ask(f, "signin.start", { cli: "claude-code", profile: "work", method: "subscription", actor });
    await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/sign-in for "work" is running/);
    expect(existsSync(directory)).toBe(true);
    expect(f.audit().filter(row => row.action === "profile.remove" && row.outcome === "refused").map(row => row.reason)).toEqual(["default_profile", "in_use", "in_use", "busy"]);
  });
  it("refuses a folder the Runtime did not create, a missing one, and a name that leaves the root; nothing is deleted", async () => {
    const f = fixture(); f.on(); const byhand = join(f.root, "claude-code", "byhand"); mkdirSync(byhand, { recursive: true }); writeFileSync(join(byhand, "x"), "y");
    await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "byhand", actor })).rejects.toThrow(/not created by this Runtime/);
    await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "missing", actor })).rejects.toThrow(/does not exist/);
    for (const name of ["..", "../byhand", "C:\\Windows", "\\\\server\\share", "~"]) await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: name, actor }), name).rejects.toThrow(/Invalid accounts.remove request: profile/);
    expect(existsSync(join(byhand, "x"))).toBe(true);
  });
  it("refuses when the inspector finds a junction or other reparse point, as Windows reports one", async () => {
    const f = fixture({ ownership: { inspect: paths => paths.map((_, index) => index === 2) } }); f.on(); const directory = owned(f);
    await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/link or junction/);
    expect(existsSync(directory)).toBe(true); expect(f.audit().at(-1)).toMatchObject({ outcome: "refused", reason: "link" });
  });
  it("needs a named person for the record", async () => {
    const f = fixture(); f.on(); owned(f);
    await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work" })).rejects.toThrow(/actor/);
    await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor: "" })).rejects.toThrow(/actor/);
  });
});

describe("cli install", () => {
  it("needs the install switch and an installer; without one this Runtime says it cannot, and records the version that landed", async () => {
    const f = fixture(); f.on("install");
    await expect(ask(f, "cli.install", { cli: "claude-code", actor })).rejects.toThrow(/cannot install CLIs/);
    expect(f.audit().at(-1)).toMatchObject({ action: "cli.install", outcome: "refused", reason: "unsupported" });
    const g = fixture({ install: async cli => ({ version: cli === "claude-code" ? "2.1.318" : "0.1.0" }) }); g.on("install");
    expect(g.accounts.canInstall).toBe(true);
    await expect(ask(g, "cli.install", { cli: "claude-code", actor })).resolves.toEqual({ version: "2.1.318" });
    expect(g.audit().at(-1)).toMatchObject({ action: "cli.install", outcome: "ok", cli: "claude-code", detail: "2.1.318" });
  });
});
