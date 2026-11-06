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
  const changed = vi.fn(); const inUse = vi.fn((): "task" | "pane" | "unknown" | undefined => undefined); const defaultProfile = vi.fn((): string | undefined => undefined);
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
    await expect(ask(f, "signin.write", { sessionId, input: `\x15${CODE}\r` })).resolves.toEqual({ accepted: true }); expect(child.written).toBe(`${CODE}\r`);
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

describe("Console sign-in is not offered from AgEnD (B3)", () => {
  it("answers `console` with a fixed unsupported text that names the command to run on that computer; the protocol still carries both values", async () => {
    const f = fixture(); f.on();
    expect(parseRuntimeRemotePayload("signin.start", { cli: "claude-code", profile: "work", method: "console", actor })).toMatchObject({ method: "console" });
    const error = (await ask(f, "signin.start", { cli: "claude-code", profile: "work", method: "console", actor }).catch((e: Error) => e)) as Error;
    expect(error.message).toMatch(/Console account is not supported from AgEnD.*On that computer run: agend-runtime login claude-code NAME/);
    expect(f.spawned).toHaveLength(0); expect(existsSync(join(f.root, "claude-code", "work"))).toBe(false);
    expect(f.audit().at(-1)).toMatchObject({ action: "signin", outcome: "refused", reason: "unsupported" });
  });
  it("a subscription sign-in builds --claudeai and never --console", async () => {
    const f = fixture(); f.on(); await ask(f, "signin.start", { cli: "claude-code", profile: "work", method: "subscription", actor });
    expect(f.spawned[0]!.args).toEqual(["auth", "login", "--claudeai"]);
  });
});

describe("what a refusal leaves behind, and the record of a code", () => {
  const start = (f: F, profile: string) => ask(f, "signin.start", { cli: "claude-code", profile, method: "subscription", actor });
  it("a start that is refused (busy, too fast, no CLI, in use) creates no folder and leaves no `started` line", async () => {
    const f = fixture(); f.on(); await start(f, "work");
    await expect(start(f, "second")).rejects.toThrow(/Another sign-in/); expect(existsSync(join(f.root, "claude-code", "second"))).toBe(false);
    const g = fixture({ find: async () => null }); g.on(); await expect(start(g, "third")).rejects.toThrow(/not installed/); expect(existsSync(join(g.root, "claude-code", "third"))).toBe(false);
    expect(g.audit().map(row => `${row.outcome}`)).toEqual(["refused"]);
  });
  it("records the code's submission (who, when, which profile) and never its content", async () => {
    const f = fixture(); f.on(); const { sessionId } = await start(f, "work"); f.children[0]!.stdout.write(`If the browser didn't open, visit: ${URL_OK}\nPaste code here if prompted >`);
    await ask(f, "signin.write", { sessionId, input: `\x15${CODE}\r` });
    expect(f.audit().filter(row => row.action === "signin.write").map(row => `${row.actor}:${row.outcome}:${row.profile}`)).toEqual([`${actor}:started:work`, `${actor}:ok:work`]);
    expect(f.auditText()).not.toContain(CODE);
    await expect(ask(f, "signin.write", { sessionId, input: "\x15SECOND\r" })).rejects.toThrow(/one code/);
    expect(f.audit().at(-1)).toMatchObject({ action: "signin.write", outcome: "refused" });
  });
  it("a flood of refused requests from ever-changing actors writes a handful of lines, and the real operations that follow are all there", async () => {
    const f = fixture(); owned(f);
    for (let i = 0; i < 300; i++) await ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor: `attacker-${i}` }).catch(() => {});
    expect(f.audit()).toHaveLength(1); f.on();
    await ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor });
    expect(f.audit().map(row => `${row.action}:${row.outcome}`)).toEqual(["profile.remove:refused", "profile.remove:refused", "profile.remove:started", "profile.remove:ok"]);
    expect(f.audit()[1]).toMatchObject({ repeated: 299 });
  });
});

describe("a switch that is turned off, or runs out, ends the sign-in by itself (item 10)", () => {
  it("looks at the switch every few seconds while a sign-in is open, ends it, records it, and stops looking", async () => {
    vi.useFakeTimers(); const f = fixture({ now: () => Date.now(), switchWatchMs: 3000 }); setRemoteSwitch(f.pairing, "accounts", true, undefined, Date.now());
    const { sessionId } = await ask(f, "signin.start", { cli: "claude-code", profile: "work", method: "subscription", actor });
    await vi.advanceTimersByTimeAsync(9000); expect(f.children[0]!.killed).toBe(false);
    setRemoteSwitch(f.pairing, "accounts", false, undefined, Date.now()); await vi.advanceTimersByTimeAsync(3100);
    expect(f.children[0]!.killed).toBe(true); expect(f.audit().at(-1)).toMatchObject({ action: "signin", outcome: "failed", reason: "switch_off" });
    const lines = f.audit().length; await vi.advanceTimersByTimeAsync(30_000); expect(f.audit()).toHaveLength(lines);
    await expect(ask(f, "signin.capture", { sessionId })).rejects.toThrow(/./);
  });
  it("also when a timed switch runs out, with no request at all in between", async () => {
    vi.useFakeTimers(); const f = fixture({ now: () => Date.now(), switchWatchMs: 3000 }); setRemoteSwitch(f.pairing, "accounts", true, 60_000, Date.now());
    await ask(f, "signin.start", { cli: "claude-code", profile: "work", method: "subscription", actor });
    await vi.advanceTimersByTimeAsync(57_000); expect(f.children[0]!.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(7000); expect(f.children[0]!.killed).toBe(true); expect(f.audit().at(-1)).toMatchObject({ reason: "switch_off" });
  });
  it("a child that cannot be shown gone is killed again at the next look, not forgotten", async () => {
    vi.useFakeTimers(); let canKill = false;
    const f = fixture({ now: () => Date.now(), switchWatchMs: 3000, signIn: { scratchRoot: scratch(), kill: child => { if (canKill) (child as unknown as FakeChild).kill(); },
      spawn: () => new FakeChild() as unknown as ChildProcess } });
    setRemoteSwitch(f.pairing, "accounts", true, undefined, Date.now()); await ask(f, "signin.start", { cli: "claude-code", profile: "work", method: "subscription", actor });
    setRemoteSwitch(f.pairing, "accounts", false, undefined, Date.now()); await vi.advanceTimersByTimeAsync(3100 + 5100);
    expect(f.audit().some(row => row.action === "signin" && row.outcome === "failed")).toBe(false);
    canKill = true; await vi.advanceTimersByTimeAsync(10_000);
    expect(f.audit().at(-1)).toMatchObject({ action: "signin", outcome: "failed", reason: "switch_off" });
  });
  it("the ten-minute timeout that fails to end the child is retried too", async () => {
    vi.useFakeTimers(); let canKill = false;
    const f = fixture({ now: () => Date.now(), switchWatchMs: 3000, signIn: { scratchRoot: scratch(), kill: child => { if (canKill) (child as unknown as FakeChild).kill(); },
      spawn: () => new FakeChild() as unknown as ChildProcess } });
    setRemoteSwitch(f.pairing, "accounts", true, 3 * 3_600_000, Date.now()); await ask(f, "signin.start", { cli: "claude-code", profile: "work", method: "subscription", actor });
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 6000); expect(f.audit().some(row => row.reason === "timeout")).toBe(false);
    canKill = true; await vi.advanceTimersByTimeAsync(10_000); expect(f.audit().at(-1)).toMatchObject({ action: "signin", outcome: "failed", reason: "timeout" });
  });
});

describe("one operation at a time on a profile (item 12)", () => {
  it("a sign-out and a remove of the same profile cannot overlap; the second gets `busy`; different profiles do not block each other", async () => {
    const f = fixture(); f.on(); owned(f); owned(f, "home");
    let release!: () => void; f.runLogout.mockImplementation(() => new Promise(done => { release = () => { f.setAnswer({ loggedIn: false }); done(0); }; }));
    const first = ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor }); await vi.waitFor(() => expect(f.runLogout).toHaveBeenCalled());
    await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/Another operation on "work" is in progress/);
    await expect(ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/Another operation/);
    await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "home", actor })).resolves.toEqual({ removed: true });
    expect(existsSync(join(f.root, "claude-code", "work"))).toBe(true);
    release(); await expect(first).resolves.toEqual({ loggedIn: false });
    f.tick(6000); await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).resolves.toEqual({ removed: true });
    expect(f.audit().filter(row => row.reason === "busy").map(row => row.action)).toEqual(["profile.remove", "profile.signout"]);   // one line per kind
  });
  it("frees the lock when the operation fails, so the next request is not stuck", async () => {
    const f = fixture(); f.on(); owned(f); f.setAnswer({ loggedIn: true }); f.runLogout.mockResolvedValue(1);
    await expect(ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/still signed in/);
    f.setAnswer({ loggedIn: false }); f.tick(6000); await expect(ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor })).resolves.toEqual({ loggedIn: false });
  });
  it("a sign-in that lost its close (the child ended, nobody closed it) does not keep the next one out", async () => {
    const f = fixture(); f.on(); await ask(f, "signin.start", { cli: "claude-code", profile: "work", method: "subscription", actor });
    f.children[0]!.end(1); f.tick(6000);
    await expect(ask(f, "signin.start", { cli: "claude-code", profile: "home", method: "subscription", actor })).resolves.toMatchObject({ sessionId: expect.stringMatching(/^[a-f0-9]{32}$/) });
    expect(f.children).toHaveLength(2);
  });
});

describe("every refusal that changes nothing is made before `started` (the flood review)", () => {
  const startReq = (profile: string, extra: Record<string, unknown> = {}) => ({ cli: "claude-code", profile, method: "subscription", actor, ...extra });
  const lines = (f: F, action?: string) => f.audit().filter(row => !action || row.action === action);
  it("200 wrong writes to an open sign-in add a handful of lines, and the real operations afterwards are all recorded", async () => {
    const f = fixture(); f.on(); const { sessionId } = await ask(f, "signin.start", startReq("work")); const before = f.audit().length;
    for (let i = 0; i < 200; i++) await ask(f, "signin.write", { sessionId, input: i % 3 ? "not a code!" : `\x15CODE${i}\r` }).catch(() => {});   // malformed, or valid but no prompt is showing
    expect(f.audit().length - before).toBeLessThanOrEqual(2); expect(f.audit().some(row => row.action === "signin.write" && row.outcome === "started")).toBe(false);
    f.children[0]!.stdout.write(`If the browser didn't open, visit: ${URL_OK}\nPaste code here if prompted >`);
    await ask(f, "signin.write", { sessionId, input: `\x15${CODE}\r` });
    for (let i = 0; i < 200; i++) await ask(f, "signin.write", { sessionId, input: `\x15SECOND${i}\r` }).catch(() => {});   // a second code, and a child that has the code already
    f.children[0]!.end(0);
    for (let i = 0; i < 200; i++) await ask(f, "signin.write", { sessionId, input: `\x15LATE${i}\r` }).catch(() => {});    // the child has ended
    expect(f.audit().length - before).toBeLessThanOrEqual(8);
    expect(lines(f, "signin.write").filter(row => row.outcome === "started" || row.outcome === "ok")).toHaveLength(2);
    expect(lines(f, "signin.write").some(row => typeof row.repeated === "number")).toBe(true);
    await ask(f, "signin.close", { sessionId }); f.tick(6000); owned(f, "other");
    await ask(f, "accounts.remove", { cli: "claude-code", profile: "other", actor });
    expect(f.audit().slice(-2).map(row => `${row.action}:${row.outcome}`)).toEqual(["profile.remove:started", "profile.remove:ok"]);
    expect(f.auditText()).not.toMatch(/CODE\d|SECOND|LATE|SECRETCODE/);
  });
  it("sign-in start: a busy slot, a console request, a name clash, a missing CLI and a too-fast start write no `started` and create no folder", async () => {
    const f = fixture(); f.on(); owned(f, "Taken"); await ask(f, "signin.start", startReq("work"));
    const names = ["a1", "a2", "a3"];
    for (const name of names) await expect(ask(f, "signin.start", startReq(name))).rejects.toThrow(/Another sign-in/);
    for (const name of names) await expect(ask(f, "signin.start", startReq(name, { method: "console" }))).rejects.toThrow(/Console/);
    expect(lines(f, "signin").filter(row => row.outcome === "started")).toHaveLength(1);
    expect(names.some(name => existsSync(join(f.root, "claude-code", name)))).toBe(false);
    const g = fixture(); g.on(); owned(g, "Taken");
    await expect(ask(g, "signin.start", startReq("taken"))).rejects.toThrow(/same folder as "Taken"/);
    expect(g.audit().map(row => `${row.outcome}:${row.reason}`)).toEqual(["refused:invalid_request"]); expect(existsSync(join(g.root, "claude-code", "taken"))).toBe(process.platform === "win32");
  });
  it("sign-out and remove: unowned, in use, unconfirmed, default and too-fast requests are all refusals only", async () => {
    const f = fixture(); f.on(); owned(f); mkdirSync(join(f.root, "claude-code", "byhand"), { recursive: true });
    const refuse = async (operation: string, profile: string) => { await ask(f, operation, { cli: "claude-code", profile, actor }).catch(() => {}); };
    for (let i = 0; i < 20; i++) await refuse("accounts.signout", "byhand");
    f.inUse.mockReturnValue("task"); for (let i = 0; i < 20; i++) { await refuse("accounts.signout", "work"); await refuse("accounts.remove", "work"); }
    f.inUse.mockReturnValue("unknown"); for (let i = 0; i < 20; i++) await refuse("accounts.remove", "work");
    f.inUse.mockReturnValue(undefined); f.defaultProfile.mockReturnValue("work"); for (let i = 0; i < 20; i++) await refuse("accounts.remove", "work");
    expect(f.audit().some(row => row.outcome === "started")).toBe(false); expect(f.audit().length).toBeLessThanOrEqual(6);
    expect(f.audit().map(row => row.reason).sort()).toEqual(["default_profile", "in_use", "in_use", "not_owned", "unconfirmed"].sort());
  });
  it("install: a CLI id outside the installer's table is refused before `started`", async () => {
    const f = fixture({ install: async () => ({ version: "2.1.318" }), knowsCli: cli => cli === "claude-code" }); f.on("install");
    for (let i = 0; i < 20; i++) await ask(f, "cli.install", { cli: "kiro-cli", actor }).catch(() => {});
    expect(f.audit().map(row => `${row.outcome}:${row.reason}`)).toEqual(["refused:unsupported"]);
    await expect(ask(f, "cli.install", { cli: "claude-code", actor })).resolves.toEqual({ version: "2.1.318" });
  });
});

describe("how a sign-in ends (review round 2)", () => {
  it("a sign-in that ended by itself and was never closed is ended the normal way when the next one starts: its result is recorded, its metadata is cleared", async () => {
    const f = fixture(); f.on(); await ask(f, "signin.start", { cli: "claude-code", profile: "one", method: "subscription", actor });
    f.setAnswer({ loggedIn: true, identity: { maskedEmail: "ab***@example.com", plan: "pro" } }); await ask(f, "accounts.check", { cli: "claude-code", profile: "one" });
    f.children[0]!.end(0); f.tick(6000);
    await ask(f, "signin.start", { cli: "claude-code", profile: "two", method: "subscription", actor });
    expect(f.audit().map(row => `${row.action}:${row.outcome}:${row.profile}`)).toEqual(["signin:started:one", "profile.add:ok:one", "signin:ok:one", "signin:started:two", "profile.add:ok:two"]);
  });
  it("one that ended without being signed in is recorded as failed", async () => {
    const f = fixture(); f.on(); await ask(f, "signin.start", { cli: "claude-code", profile: "one", method: "subscription", actor });
    f.children[0]!.end(1); f.tick(6000); await ask(f, "signin.start", { cli: "claude-code", profile: "two", method: "subscription", actor });
    expect(f.audit().filter(row => row.profile === "one" && row.action === "signin").map(row => `${row.outcome}:${row.reason ?? ""}`)).toEqual(["started:", "failed:failed"]);
  });
  it("two closes at the same time write one end record", async () => {
    const f = fixture(); f.on(); const { sessionId } = await ask(f, "signin.start", { cli: "claude-code", profile: "one", method: "subscription", actor });
    const results = await Promise.allSettled([ask(f, "signin.close", { sessionId }), ask(f, "signin.close", { sessionId }), ask(f, "signin.close", { sessionId })]);
    expect(results.some(result => result.status === "fulfilled")).toBe(true);
    expect(f.audit().filter(row => row.action === "signin" && row.outcome !== "started")).toHaveLength(1);
  });
  it("a close that arrives after a timeout or switch end does not write a second record", async () => {
    vi.useFakeTimers(); const f = fixture({ now: () => Date.now(), switchWatchMs: 3000 }); setRemoteSwitch(f.pairing, "accounts", true, undefined, Date.now());
    const { sessionId } = await ask(f, "signin.start", { cli: "claude-code", profile: "one", method: "subscription", actor });
    setRemoteSwitch(f.pairing, "accounts", false, undefined, Date.now()); await vi.advanceTimersByTimeAsync(3100);
    await ask(f, "signin.close", { sessionId }).catch(() => {});
    expect(f.audit().filter(row => row.action === "signin" && row.outcome !== "started")).toHaveLength(1);
  });
});

describe("a profile cannot be signed out or removed in quick succession (item 8)", () => {
  it("at least five seconds between two changes of one profile; another profile is not held back; a refused try does not extend the wait", async () => {
    const f = fixture(); f.on(); owned(f); owned(f, "home"); f.setAnswer({ loggedIn: true }); f.runLogout.mockImplementation(async () => { f.setAnswer({ loggedIn: false }); return 0; });
    await expect(ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor })).resolves.toEqual({ loggedIn: false });
    for (const operation of ["accounts.signout", "accounts.remove"]) await expect(ask(f, operation, { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/was just changed; wait a few seconds/);
    await expect(ask(f, "accounts.signout", { cli: "claude-code", profile: "home", actor })).resolves.toEqual({ loggedIn: false });
    f.tick(2000); await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/wait a few seconds/);
    f.tick(3100); await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).resolves.toEqual({ removed: true });
    expect(f.audit().filter(row => row.reason === "rate_limited").length).toBeLessThanOrEqual(3);   // folded per (action, reason); the count of the last one goes out when the next real operation starts
  });
  it("the wait is by lower-case name and is not taken by a request that is refused for another reason", async () => {
    const f = fixture(); f.on(); owned(f); f.inUse.mockReturnValueOnce("task");
    await expect(ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/running task/);
    f.setAnswer({ loggedIn: false }); await expect(ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor })).resolves.toEqual({ loggedIn: false });
  });
});
