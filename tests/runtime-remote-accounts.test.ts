import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CONCURRENT_CHECKS, ProcessNotConfirmedEnded, RemoteAccounts, type RemoteAccountsDeps, type RemoteStatusAnswer } from "../src/runtime-remote-accounts.js";
import { cachedCredentialStatus, credentialProfilesRoot } from "../src/runtime-credential-profiles.js";
import { createRuntimeProfile, isCreatedProfile } from "../src/runtime-profile-ownership.js";
import { appendAudit, AUDIT_FILE, AUDIT_LOCK_FILE, auditLockTiming, setRemoteSwitch } from "../src/runtime-remote-setup.js";
import { parseRuntimeRemotePayload } from "../src/runtime-protocol.js";
import { REDUCED_CODE_PROMPT, REDUCED_SUCCESS, REDUCED_URL_PREFIX } from "../src/runtime-signin.js";

// A second audit writer that runs in the middle of the first one (see the last describe). The hook runs once, synchronously, while the first writer is paused: the
// first fstat that follows (`wait`: after the 25 ms look at an incomplete tail; `failedWrite`: after an audit write failed) is the one whose answer is stale.
const tap = vi.hoisted(() => ({ hook: null as null | { on: "wait" | "failedWrite"; run: () => void }, armed: false, inHook: false, failAuditWrite: false, calls: 0 }));
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>(); const flagsOf = new Map<number, number>();
  const fire = (): void => { const current = tap.hook; if (!current || tap.inHook) return; tap.hook = null; tap.inHook = true; try { current.run(); } finally { tap.inHook = false; } };
  return { ...original,
    openSync: ((path: any, flags?: any, mode?: any) => { const fd = (original.openSync as any)(path, flags, mode); if (typeof flags === "number") flagsOf.set(fd, flags); return fd; }) as typeof original.openSync,
    closeSync: ((fd: number) => { flagsOf.delete(fd); return original.closeSync(fd); }) as typeof original.closeSync,
    writeSync: ((fd: number, buffer: any, offset?: number, length?: number) => {
      if (!tap.failAuditWrite || tap.inHook || typeof buffer === "string" || !((flagsOf.get(fd) ?? 0) & original.constants.O_APPEND)) return (original.writeSync as any)(fd, buffer, offset, length);
      tap.calls++;                                                                          // the audit record's write: three bytes, three bytes, then nothing
      if (tap.calls > 2) { if (tap.hook?.on === "failedWrite") tap.armed = true; return 0; }
      return (original.writeSync as any)(fd, buffer, offset, Math.min(3, length ?? buffer.byteLength));
    }) as typeof original.writeSync,
    fstatSync: ((fd: number, options?: any) => { const result = (original.fstatSync as any)(fd, options); if (tap.armed && !tap.inHook) { tap.armed = false; fire(); } return result; }) as typeof original.fstatSync };
});
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
    runLogout, inUse, inUseNow: (name: string) => (inUse as unknown as (n: string) => unknown)(name) as "task" | "pane" | "unknown" | undefined, defaultProfile, changed,
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
    const f = fixture({ installer: { knows: () => true, install: async () => ({ version: "2.1.318" }) } }); owned(f); f.on("install");
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
    expect(executable.command).toBe("claude.exe"); expect(args).toEqual(["auth", "logout"]); expect(env.CLAUDE_CONFIG_DIR).toMatch(/[\\/]\.working-[a-f0-9]{16}$/); expect(existsSync(directory)).toBe(true);   // the logout ran against the renamed folder; the name is back
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
    const g = fixture({ installer: { knows: () => true, install: async cli => ({ version: cli === "claude-code" ? "2.1.318" : "0.1.0" }) } }); g.on("install");
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
    expect(existsSync(join(f.root, "claude-code", "work"))).toBe(false); expect(readdirSync(join(f.root, "claude-code")).some(name => /^\.working-[a-f0-9]{16}$/.test(name))).toBe(true);   // under its working name while the logout runs
    release(); await expect(first).resolves.toEqual({ loggedIn: false }); expect(existsSync(join(f.root, "claude-code", "work"))).toBe(true);
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
    const f = fixture({ installer: { knows: cli => cli === "claude-code", install: async () => ({ version: "2.1.318" }) } }); f.on("install");
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

describe("concurrent requests (round 3): check and run are separated by awaits, so exclusivity is taken before the first one", () => {
  const startReq = (profile: string) => ({ cli: "claude-code", profile, method: "subscription", actor });
  it("50 sign-ins started at the same moment under 50 names: one succeeds, one `started`, one folder, one child; the rest are one folded refusal", async () => {
    const f = fixture(); f.on();
    const names = Array.from({ length: 50 }, (_, i) => `p${i}`);
    const results = await Promise.allSettled(names.map(name => ask(f, "signin.start", startReq(name))));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected").every(result => /Another sign-in/.test(String((result as PromiseRejectedResult).reason.message)))).toBe(true);
    expect(f.audit().filter(row => row.action === "signin" && row.outcome === "started")).toHaveLength(1);
    expect(f.audit().filter(row => row.action === "profile.add")).toHaveLength(1);
    expect(names.filter(name => existsSync(join(f.root, "claude-code", name)))).toHaveLength(1);
    expect(isCreatedProfile(f.root, "claude-code", names.find(name => existsSync(join(f.root, "claude-code", name)))!)).toBe(true);
    expect(JSON.parse(readFileSync(join(f.root, "created.json"), "utf8")).created["claude-code"]).toBeDefined();
    expect(Object.keys(JSON.parse(readFileSync(join(f.root, "created.json"), "utf8")).created["claude-code"])).toHaveLength(1);
    expect(f.children).toHaveLength(1); expect(f.spawned).toHaveLength(1);
    const refusals = f.audit().filter(row => row.outcome === "refused" && row.reason === "busy");   // the first one, and the count written when the winner's `started` went out
    expect(refusals).toHaveLength(2); expect(refusals[1]).toMatchObject({ repeated: 48 }); expect(typeof refusals[1]!.since).toBe("string");
    expect(f.audit().length).toBeLessThanOrEqual(6);
  });
  it("the same name sent twice at once is stopped by the profile lock, and a start after the first has finished is stopped by the slot", async () => {
    const f = fixture(); f.on();
    const both = await Promise.allSettled([ask(f, "signin.start", startReq("work")), ask(f, "signin.start", startReq("work"))]);
    expect(both.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(f.children).toHaveLength(1);
    await expect(ask(f, "signin.start", startReq("other"))).rejects.toThrow(/Another sign-in/); expect(existsSync(join(f.root, "claude-code", "other"))).toBe(false);
  });
  it("the flag is released when a start is refused or fails, and when the sign-in is closed, so the next start works", async () => {
    const f = fixture({ find: async () => null }); f.on();
    await expect(ask(f, "signin.start", startReq("a"))).rejects.toThrow(/not installed/);
    await expect(ask(f, "signin.start", startReq("b"))).rejects.toThrow(/not installed/);           // not "Another sign-in is starting": the flag was released
    const g = fixture(); g.on(); const { sessionId } = await ask(g, "signin.start", startReq("a")); await ask(g, "signin.close", { sessionId }); g.tick(6000);
    await expect(ask(g, "signin.start", startReq("b"))).resolves.toMatchObject({ sessionId: expect.any(String) });
  });
  it("two installs at the same moment: one runs, the other is refused `busy` before `started`; afterwards the next one runs", async () => {
    let release!: () => void; let calls = 0;
    const f = fixture({ installer: { knows: () => true, install: () => { calls++; return new Promise(done => { release = () => done({ version: "2.1.318" }); }); } } }); f.on("install");
    const first = ask(f, "cli.install", { cli: "claude-code", actor }); await vi.waitFor(() => expect(calls).toBe(1));
    await expect(ask(f, "cli.install", { cli: "codex", actor })).rejects.toThrow(/Another install is running/);
    expect(calls).toBe(1); expect(f.audit().filter(row => row.action === "cli.install" && row.outcome === "started")).toHaveLength(1);
    release(); await expect(first).resolves.toEqual({ version: "2.1.318" });
    const second = ask(f, "cli.install", { cli: "codex", actor }); await vi.waitFor(() => expect(calls).toBe(2)); release(); await second;
  });
  it("sign-outs and removes of one profile at the same moment: one of them runs (the profile lock), the others are `busy`", async () => {
    const f = fixture(); f.on(); owned(f);
    let logouts = 0; f.runLogout.mockImplementation(async () => { logouts++; await new Promise(done => setTimeout(done, 20)); f.setAnswer({ loggedIn: false }); return 0; });
    const results = await Promise.allSettled([...Array(10)].map(() => ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(logouts).toBe(1);
    expect(f.audit().filter(row => row.action === "profile.signout" && row.outcome === "started")).toHaveLength(1);
  });
});

describe("round 3: the order of the pace check, `since`, and the local report", () => {
  it("a request that is too soon is refused before the ownership check (no PowerShell), and the time is taken only when every check passed", async () => {
    let inspected = 0; const f = fixture({ ownership: { inspect: paths => { inspected++; return paths.map(() => false); } } }); f.on(); owned(f);
    f.setAnswer({ loggedIn: true }); f.runLogout.mockImplementation(async () => { f.setAnswer({ loggedIn: false }); return 0; });
    await ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor }); const seen = inspected; expect(seen).toBeGreaterThan(0);
    await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/wait a few seconds/);
    expect(inspected).toBe(seen);                                                                 // not asked again
    f.inUse.mockReturnValue("task"); f.tick(6000);
    await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/running task/);   // refused for another reason: no new wait
    f.inUse.mockReturnValue(undefined); await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).resolves.toEqual({ removed: true });
  });
  it("a profile name that was never owned does not enter the pace table (it is refused for ownership first, and only owned names are marked)", async () => {
    const f = fixture(); f.on(); mkdirSync(join(f.root, "claude-code", "byhand"), { recursive: true });
    for (let i = 0; i < 3; i++) await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "byhand", actor })).rejects.toThrow(/not created by this Runtime/);
  });
  it("tells the person at this computer, and only them, when a removal can be neither finished nor undone", async () => {
    const report = vi.fn(); const f = fixture({ report, ownership: { inspect: paths => { if (paths.length === 1) writeFileSync(join(f.root, "claude-code", "work"), "in the way"); return paths.map(() => paths.length === 1); } } });
    f.on(); owned(f);
    const error = (await ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor }).catch((e: Error) => e)) as Error;
    expect(error.message).toBe("The operation could not be completed on this computer. Check that computer's Runtime window.");
    expect(report).toHaveBeenCalledTimes(1); expect(report.mock.calls[0]![0]).toMatch(/could not finish and could not be undone.*agend-runtime profile list/); expect(report.mock.calls[0]![0]).not.toMatch(/[A-Za-z]:\\|\/tmp|\.removing/);
    expect(f.auditText()).not.toMatch(/removing|profile list/);
  });
});


// ---------------------------------------------------------------- review of the upstream PR: fences at the edges of every effect
function held<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const NOT_AVAILABLE = /stopping or its connection changed/;
const startReq2 = (profile: string) => ({ cli: "claude-code", profile, method: "subscription", actor });
/** An inspector seam that lets the first calls through and holds the call number `at` (1-based) until released; every call is counted. */
function holdInspect(at: number) { const gate = held(); let calls = 0; return { gate, calls: () => calls, inspect: async (paths: readonly string[]) => { calls++; if (calls === at) await gate.promise; return paths.map(() => false); } }; }
const nothingCreated = (f: F, name: string) => !existsSync(join(f.root, "claude-code", name)) && f.spawned.length === 0;

describe("P1: stop and a changed connection fence the work that is waiting (and wait for it)", () => {
  it("a start waiting in `find` when the Runtime stops: stop waits for it to unwind, and nothing is created or started when the lookup answers", async () => {
    const lookup = held<{ path: string; command: string; args: string[] }>(); const f = fixture({ find: () => lookup.promise }); f.on();
    const request = ask(f, "signin.start", startReq2("late")).catch((e: Error) => e); await new Promise(done => setTimeout(done, 20));
    let stopped = false; const stopping = f.accounts.stop().then(() => { stopped = true; }); await new Promise(done => setTimeout(done, 30));
    expect(stopped).toBe(false);                                                                   // stop is holding for the request that is still in flight
    lookup.resolve({ path: "claude.exe", command: "claude.exe", args: [] }); await stopping;
    const error = await request; expect(error).toBeInstanceOf(Error); expect((error as Error).message).toMatch(NOT_AVAILABLE);
    expect(nothingCreated(f, "late")).toBe(true); expect(f.audit().some(row => row.outcome === "started" || row.action === "profile.add")).toBe(false);
  });
  it("after stop, nothing is admitted at all (every operation answers that the Runtime is stopping)", async () => {
    const f = fixture(); f.on(); owned(f); await f.accounts.stop();
    for (const [operation, payload] of [["signin.start", startReq2("x")], ["accounts.signout", { cli: "claude-code", profile: "work", actor }], ["accounts.remove", { cli: "claude-code", profile: "work", actor }],
      ["accounts.check", { cli: "claude-code", profile: "work" }], ["accounts.switches", {}], ["signin.close", { sessionId: "0".repeat(32) }]] as Array<[string, unknown]>) await expect(ask(f, operation, payload), operation).rejects.toThrow(NOT_AVAILABLE);
    expect(f.runLogout).not.toHaveBeenCalled(); expect(existsSync(join(f.root, "claude-code", "work"))).toBe(true);
  });
  it("stop ends an open sign-in and waits for a sign-out that is running (the process is owned until it has finished)", async () => {
    const f = fixture(); f.on(); owned(f, "other"); const { sessionId } = await ask(f, "signin.start", startReq2("work")); expect(sessionId).toMatch(/^[a-f0-9]{32}$/);
    let release!: () => void; f.runLogout.mockImplementation(() => new Promise(done => { release = () => done(0); }));
    f.tick(6000); const signout = ask(f, "accounts.signout", { cli: "claude-code", profile: "other", actor }).catch((e: Error) => e); await vi.waitFor(() => expect(f.runLogout).toHaveBeenCalled());
    let stopped = false; const stopping = f.accounts.stop().then(() => { stopped = true; }); await new Promise(done => setTimeout(done, 30));
    expect(stopped).toBe(false); release(); await stopping; await signout;
    expect(f.children[0]!.killed).toBe(true); expect(f.accounts.idle()).toBe(true);
  });
  it("a connection that changes while a start waits: the old request may not create or start anything, and the new one is unaffected", async () => {
    const lookup = held<{ path: string; command: string; args: string[] }>(); const f = fixture({ find: () => lookup.promise }); f.on();
    const request = ask(f, "signin.start", startReq2("late")).catch((e: Error) => e); await new Promise(done => setTimeout(done, 20));
    f.accounts.connectionChanged(); lookup.resolve({ path: "claude.exe", command: "claude.exe", args: [] });
    expect(((await request) as Error).message).toMatch(NOT_AVAILABLE); expect(nothingCreated(f, "late")).toBe(true);
    const g = fixture(); g.on(); g.accounts.connectionChanged(); await expect(ask(g, "signin.start", startReq2("fresh"))).resolves.toMatchObject({ sessionId: expect.any(String) });   // a request that arrives after the change is the new connection's
  });
  it("a request that says its own connection is no longer the live one is refused before it does anything", async () => {
    const f = fixture(); f.on(); let live = true;
    const request = f.accounts.handle("signin.start", startReq2("x"), () => live); live = false;
    await expect(request).rejects.toThrow(/./); expect(nothingCreated(f, "x")).toBe(true);
    await expect(f.accounts.handle("accounts.switches", {}, () => false)).rejects.toThrow(NOT_AVAILABLE);
  });
  it("a sign-in opened over a connection is ended when that connection changes, and recorded", async () => {
    const f = fixture(); f.on(); await ask(f, "signin.start", startReq2("work"));
    f.accounts.connectionChanged(); await vi.waitFor(() => expect(f.children[0]!.killed).toBe(true));
    await vi.waitFor(() => expect(f.audit().at(-1)).toMatchObject({ action: "signin", outcome: "failed" })); expect(f.accounts.idle()).toBe(true);
  });
});

describe("P1: the local switch is looked at again at the edge of every effect", () => {
  it("signin.start: a switch turned off while the CLI lookup waits means no folder, no child and no `started`", async () => {
    const lookup = held<{ path: string; command: string; args: string[] }>(); const f = fixture({ find: () => lookup.promise }); f.on();
    const request = ask(f, "signin.start", startReq2("late")).catch((e: Error) => e); await new Promise(done => setTimeout(done, 20));
    setRemoteSwitch(f.pairing, "accounts", false, undefined, 1_700_000_000_000); lookup.resolve({ path: "claude.exe", command: "claude.exe", args: [] });
    expect(((await request) as Error).message).toMatch(/turned off/); expect(nothingCreated(f, "late")).toBe(true); expect(f.audit().some(row => row.outcome === "started")).toBe(false);
  });
  it("signin.start: a switch that runs out (its --for time passes) while the lookup waits is the same", async () => {
    const lookup = held<{ path: string; command: string; args: string[] }>(); const f = fixture({ find: () => lookup.promise }); setRemoteSwitch(f.pairing, "accounts", true, 60_000, 1_700_000_000_000);
    const request = ask(f, "signin.start", startReq2("late")).catch((e: Error) => e); await new Promise(done => setTimeout(done, 20));
    f.tick(61_000); lookup.resolve({ path: "claude.exe", command: "claude.exe", args: [] });
    expect(((await request) as Error).message).toMatch(/turned off/); expect(nothingCreated(f, "late")).toBe(true);
  });
  it("accounts.signout: switch off while the ownership inspection waits: no logout, the folder is untouched", async () => {
    const hold = holdInspect(1); const f = fixture({ ownership: { inspect: hold.inspect } }); f.on(); const directory = owned(f); writeFileSync(join(directory, ".credentials.json"), "secret");
    const request = ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor }).catch((e: Error) => e); await vi.waitFor(() => expect(hold.calls()).toBe(1));
    setRemoteSwitch(f.pairing, "accounts", false, undefined, 1_700_000_000_000); hold.gate.resolve();
    expect(((await request) as Error).message).toMatch(/turned off/); expect(f.runLogout).not.toHaveBeenCalled(); expect(readFileSync(join(directory, ".credentials.json"), "utf8")).toBe("secret");
    expect(readdirSync(join(f.root, "claude-code")).filter(name => name.startsWith("."))).toEqual([]);
  });
  it("accounts.signout: the switch turned off DURING the logout stops the backups from being deleted", async () => {
    const f = fixture(); f.on(); const directory = owned(f); mkdirSync(join(directory, "backups")); writeFileSync(join(directory, "backups", ".claude.json.backup.1"), "old identity");
    f.runLogout.mockImplementation(async () => { setRemoteSwitch(f.pairing, "accounts", false, undefined, 1_700_000_000_000); return 0; });
    await expect(ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/turned off/);
    expect(readFileSync(join(directory, "backups", ".claude.json.backup.1"), "utf8")).toBe("old identity"); expect(existsSync(directory)).toBe(true);
  });
  it("accounts.remove: switch off, or expired, while the removal's own inspection waits (just before the rename): nothing is renamed or deleted", async () => {
    for (const how of ["off", "expired"] as const) {
      const hold = holdInspect(2); const f = fixture({ ownership: { inspect: hold.inspect } }); if (how === "off") f.on(); else setRemoteSwitch(f.pairing, "accounts", true, 60_000, 1_700_000_000_000);
      const directory = owned(f); writeFileSync(join(directory, ".credentials.json"), "secret");
      const request = ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor }).catch((e: Error) => e); await vi.waitFor(() => expect(hold.calls()).toBe(2));
      if (how === "off") setRemoteSwitch(f.pairing, "accounts", false, undefined, 1_700_000_000_000); else f.tick(61_000); hold.gate.resolve();
      expect(((await request) as Error).message, how).toMatch(/turned off/); expect(readFileSync(join(directory, ".credentials.json"), "utf8")).toBe("secret");
      expect(readdirSync(join(f.root, "claude-code")).filter(name => name.startsWith("."))).toEqual([]); expect(isCreatedProfile(f.root, "claude-code", "work")).toBe(true);
    }
  });
  it("accounts.check: a switch turned off while `auth status` runs means nothing is cached", async () => {
    const answer = held<RemoteStatusAnswer>(); const f = fixture({ status: () => answer.promise }); f.on(); owned(f);
    const request = ask(f, "accounts.check", { cli: "claude-code", profile: "work" }).catch((e: Error) => e); await new Promise(done => setTimeout(done, 20));
    setRemoteSwitch(f.pairing, "accounts", false, undefined, 1_700_000_000_000); answer.resolve({ loggedIn: true });
    expect(((await request) as Error).message).toMatch(/turned off/); expect(cachedCredentialStatus(f.root, "claude-code", "work")).toBeNull();
  });
  it("closing and ending what is already running stays possible with the switch off", async () => {
    const f = fixture(); f.on(); const { sessionId } = await ask(f, "signin.start", startReq2("work")); setRemoteSwitch(f.pairing, "accounts", false, undefined, 1_700_000_000_000);
    await expect(ask(f, "signin.close", { sessionId })).resolves.toEqual({ closed: true }); await expect(ask(f, "accounts.switches", {})).resolves.toMatchObject({ accounts: { on: false } });
    await f.accounts.stop();
  });
});

describe("P2: default and in-use protection holds until the rename (accounts.remove)", () => {
  const removing = async (flip: (f: F) => void) => {
    const hold = holdInspect(2); const f = fixture({ ownership: { inspect: hold.inspect } }); f.on(); const directory = owned(f); writeFileSync(join(directory, ".credentials.json"), "secret");
    const request = ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor }).catch((e: Error) => e); await vi.waitFor(() => expect(hold.calls()).toBe(2));
    flip(f); hold.gate.resolve(); const error = await request;
    expect(readFileSync(join(directory, ".credentials.json"), "utf8")).toBe("secret"); expect(readdirSync(join(f.root, "claude-code")).filter(name => name.startsWith("."))).toEqual([]);
    return { f, error: error as Error };
  };
  it("a task that becomes active during the wait stops the removal", async () => { expect((await removing(f => f.inUse.mockReturnValue("task"))).error.message).toMatch(/running task/); });
  it("a terminal that appears during the wait stops the removal", async () => { expect((await removing(f => f.inUse.mockReturnValue("pane"))).error.message).toMatch(/running terminal/); });
  it("a profile that the local administrator makes the default during the wait stops the removal", async () => { expect((await removing(f => f.defaultProfile.mockReturnValue("Work"))).error.message).toMatch(/default for agents/); });
  it("a default that becomes unreadable during the wait stops the removal as unconfirmed", async () => {
    const { error, f } = await removing(f => f.defaultProfile.mockImplementation(() => { throw new Error("EBUSY C:\\secret\\credential-default.json"); }));
    expect(error.message).toMatch(/could not confirm which credential profile is the default/); expect(error.message).not.toMatch(/secret|EBUSY/); expect(f.audit().some(row => row.reason === "unconfirmed")).toBe(true);
  });
  it("a state that cannot be confirmed during the wait stops it as well", async () => { expect((await removing(f => f.inUse.mockReturnValue("unknown"))).error.message).toMatch(/could not confirm whether a terminal is running/); });
  it("an unreadable default at the start is `unconfirmed` and nothing is removed (it is not read as `no default`)", async () => {
    const f = fixture({ defaultProfile: () => { throw new Error("bad json"); } }); f.on(); const directory = owned(f);
    await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/could not confirm which credential profile is the default/); expect(existsSync(directory)).toBe(true);
    expect(f.audit().at(-1)).toMatchObject({ outcome: "refused", reason: "unconfirmed" });
  });
  it("the profile is reserved for the whole operation: tasks and terminals that would start under it are told to wait", async () => {
    const hold = holdInspect(1); const f = fixture({ ownership: { inspect: hold.inspect } }); f.on(); owned(f);
    const request = ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor }).catch((e: Error) => e); await vi.waitFor(() => expect(hold.calls()).toBe(1));
    expect(f.accounts.profileReserved("work")).toBe(true); expect(f.accounts.profileReserved("WORK")).toBe(true); expect(f.accounts.profileReserved("home")).toBe(false);
    hold.gate.resolve(); await request; expect(f.accounts.profileReserved("work")).toBe(false);
  });
});

describe("P2: sign-out follows no replacement of the checked folder", () => {
  const canary = () => { const dir = scratch(); mkdirSync(join(dir, "backups")); writeFileSync(join(dir, "backups", ".claude.json.backup.1"), "outside identity"); writeFileSync(join(dir, ".credentials.json"), "outside secret"); return dir; };
  const link = (target: string, path: string): boolean => { try { symlinkSync(target, path, "dir"); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return false; throw error; } };
  const intact = (dir: string) => expect(readFileSync(join(dir, "backups", ".claude.json.backup.1"), "utf8")).toBe("outside identity");
  it("a folder replaced by a link while the CLI lookup waits: refused as a link, the logout never runs, the outside folder is untouched", async () => {
    const lookup = held<{ path: string; command: string; args: string[] }>(); const f = fixture({ find: () => lookup.promise }); f.on(); const directory = owned(f), outside = canary();
    const request = ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor }).catch((e: Error) => e); await new Promise(done => setTimeout(done, 20));
    rmSync(directory, { recursive: true }); if (!link(outside, directory)) { lookup.resolve({ path: "c", command: "c", args: [] }); await request; return; }
    lookup.resolve({ path: "claude.exe", command: "claude.exe", args: [] });
    expect(((await request) as Error).message).toMatch(/link/); expect(f.runLogout).not.toHaveBeenCalled(); intact(outside); expect(readFileSync(join(outside, ".credentials.json"), "utf8")).toBe("outside secret");
  });
  it("a folder replaced right after the checks (the last moment before the rename): the link itself is renamed, found, put back; no logout, no backup deletion", async () => {
    const outside = canary(); let swapped = false; let directory = "";
    const f = fixture({ ownership: { afterChecks: () => { rmSync(directory, { recursive: true }); swapped = link(outside, directory); } } }); f.on(); directory = owned(f);
    const error = (await ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor }).catch((e: Error) => e)) as Error;
    if (!swapped) return;
    expect(error.message).toMatch(/link|not inside this Runtime's profile folder/); expect(f.runLogout).not.toHaveBeenCalled(); intact(outside);
    expect(readdirSync(join(f.root, "claude-code")).filter(name => name.startsWith(".working-"))).toEqual([]);
  });
  it("a renamed folder swapped for a link during the logout: the backups are not deleted through it", async () => {
    const outside = canary(); let swapped = false;
    const f = fixture(); f.on(); owned(f);
    (f.runLogout as unknown as { mockImplementation(fn: (e: unknown, a: unknown, env: NodeJS.ProcessEnv) => Promise<number>): void }).mockImplementation(async (_e, _a, env) => { const working = env.CLAUDE_CONFIG_DIR!; rmSync(working, { recursive: true }); swapped = link(outside, working); return 0; });
    const error = (await ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor }).catch((e: Error) => e)) as Error;
    if (!swapped) return;
    expect(error.message).toMatch(/link|not inside this Runtime's profile folder/); intact(outside); expect(readFileSync(join(outside, ".credentials.json"), "utf8")).toBe("outside secret");
  });
  it("the control: an untouched profile signs out normally, deletes its own backups, and gets its name back", async () => {
    const f = fixture(); f.on(); const directory = owned(f); mkdirSync(join(directory, "backups")); writeFileSync(join(directory, "backups", ".claude.json.backup.1"), "mine"); writeFileSync(join(directory, "backups", "keep"), "x");
    await expect(ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor })).resolves.toEqual({ loggedIn: false });
    expect(existsSync(join(directory, "backups", ".claude.json.backup.1"))).toBe(false); expect(existsSync(join(directory, "backups", "keep"))).toBe(true);
    expect(readdirSync(join(f.root, "claude-code"))).toEqual(["work"]);
  });
});

describe("P2: a process that was told to stop is not assumed gone", () => {
  it("a logout that cannot be confirmed ended keeps the profile busy and its working name, until the process really ends", async () => {
    const ended = held(); const f = fixture(); f.on(); owned(f); let first = true;
    f.runLogout.mockImplementation(async () => { if (first) { first = false; throw new ProcessNotConfirmedEnded(ended.promise); } return 0; });
    const report = vi.fn(); const g = fixture({ report }); g.on(); owned(g); let gFirst = true; g.runLogout.mockImplementation(async () => { if (gFirst) { gFirst = false; throw new ProcessNotConfirmedEnded(ended.promise); } g.setAnswer({ loggedIn: false }); return 0; });
    await expect(ask(g, "accounts.signout", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/could not be confirmed ended/);
    expect(g.accounts.profileReserved("work")).toBe(true); expect(g.accounts.idle()).toBe(false); expect(report).toHaveBeenCalledTimes(1);
    expect(readdirSync(join(g.root, "claude-code")).some(name => /^\.working-[a-f0-9]{16}$/.test(name))).toBe(true);
    g.tick(6000); await expect(ask(g, "accounts.signout", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/Another operation on "work"/);
    await expect(ask(g, "accounts.remove", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/Another operation/);
    ended.resolve(); await vi.waitFor(() => expect(g.accounts.profileReserved("work")).toBe(false));
    expect(readdirSync(join(g.root, "claude-code"))).toEqual(["work"]); expect(g.accounts.idle()).toBe(true);        // the name is back once the process has ended
    g.tick(6000); await expect(ask(g, "accounts.signout", { cli: "claude-code", profile: "work", actor })).resolves.toEqual({ loggedIn: false });
    void f;
  });
});

describe("P2: accounts.check is bounded before it starts any child", () => {
  it(`20 at once with a slow \`auth status\`: at most ${MAX_CONCURRENT_CHECKS} reach it, the others are refused at once, and the capacity comes back`, async () => {
    const answers: Array<(value: RemoteStatusAnswer) => void> = []; let inspections = 0;
    const f = fixture({ status: () => new Promise(done => { answers.push(done); }), ownership: { inspect: paths => { inspections++; return paths.map(() => false); } } }); f.on(); owned(f);
    const settled: string[] = [];
    const results = Array.from({ length: 20 }, () => ask(f, "accounts.check", { cli: "claude-code", profile: "work" }).then(() => { settled.push("ok"); }, (e: Error) => { settled.push(e.message); }));
    await vi.waitFor(() => expect(answers.length).toBe(MAX_CONCURRENT_CHECKS)); await new Promise(done => setTimeout(done, 30));
    expect(answers.length).toBe(MAX_CONCURRENT_CHECKS); expect(inspections).toBe(MAX_CONCURRENT_CHECKS);       // only that many PowerShell inspections and `auth status` calls were ever started
    expect(settled).toHaveLength(20 - MAX_CONCURRENT_CHECKS); expect(settled.every(message => /Other account checks are running/.test(message))).toBe(true);
    answers.forEach(done => done({ loggedIn: false })); await Promise.all(results);
    const again = ask(f, "accounts.check", { cli: "claude-code", profile: "work" }).then(() => "ok");        // the capacity came back
    await vi.waitFor(() => expect(answers.length).toBe(MAX_CONCURRENT_CHECKS + 1)); answers.at(-1)!({ loggedIn: false }); await expect(again).resolves.toBe("ok");
  });
  it("the refusals are immediate (they do not wait for the running ones)", async () => {
    const answers: Array<(value: RemoteStatusAnswer) => void> = []; const f = fixture({ status: () => new Promise(done => { answers.push(done); }) }); f.on(); owned(f);
    const running = Array.from({ length: MAX_CONCURRENT_CHECKS }, () => ask(f, "accounts.check", { cli: "claude-code", profile: "work" })); await vi.waitFor(() => expect(answers.length).toBe(MAX_CONCURRENT_CHECKS));
    const started = Date.now(); for (let i = 0; i < 18; i++) await expect(ask(f, "accounts.check", { cli: "claude-code", profile: "work" })).rejects.toThrow(/Other account checks are running/);
    expect(Date.now() - started).toBeLessThan(2000); expect(answers.length).toBe(MAX_CONCURRENT_CHECKS);
    answers.forEach(done => done({ loggedIn: false })); await Promise.all(running);
  });
  it("a profile that is being changed is `busy` for a check, and no child is started for it", async () => {
    const f = fixture(); f.on(); owned(f); let release!: () => void; f.runLogout.mockImplementation(() => new Promise(done => { release = () => done(0); }));
    const signout = ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor }); await vi.waitFor(() => expect(f.runLogout).toHaveBeenCalled()); const before = f.status.mock.calls.length;
    await expect(ask(f, "accounts.check", { cli: "claude-code", profile: "work" })).rejects.toThrow(/Another operation on "work"/); expect(f.status.mock.calls.length).toBe(before);
    release(); await signout;
  });
  it("the slot is returned when a check fails", async () => {
    const f = fixture({ status: async () => { throw new Error("boom"); } }); f.on(); owned(f);
    for (let i = 0; i < MAX_CONCURRENT_CHECKS * 3; i++) await expect(ask(f, "accounts.check", { cli: "claude-code", profile: "work" })).rejects.toThrow(/could not be completed/);
  });
});


describe("the default is read once more after the rename, before the delete (another process writes it)", () => {
  const afterRename = async (flip: (f: F) => void) => {
    const hold = holdInspect(3); const f = fixture({ ownership: { inspect: hold.inspect } }); f.on(); const directory = owned(f); writeFileSync(join(directory, ".credentials.json"), "secret");
    const request = ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor }).catch((e: Error) => e); await vi.waitFor(() => expect(hold.calls()).toBe(3));
    expect(existsSync(directory)).toBe(false);                                              // the folder has been taken away: the hold is after the rename
    flip(f); hold.gate.resolve(); const error = await request as Error;
    expect(readFileSync(join(directory, ".credentials.json"), "utf8")).toBe("secret"); expect(readdirSync(join(f.root, "claude-code"))).toEqual(["work"]); expect(isCreatedProfile(f.root, "claude-code", "work")).toBe(true);
    return { f, error };
  };
  it("a default set in that gap puts the folder back and refuses", async () => { expect((await afterRename(f => f.defaultProfile.mockReturnValue("work"))).error.message).toMatch(/default for agents/); });
  it("a default that cannot be read in that gap puts the folder back and answers `unconfirmed`", async () => {
    const { f, error } = await afterRename(f => f.defaultProfile.mockImplementation(() => { throw new Error("EBUSY"); }));
    expect(error.message).toMatch(/could not confirm which credential profile is the default/); expect(f.audit().some(row => row.reason === "unconfirmed")).toBe(true);
  });
  it("a task or terminal that appears in that gap does the same", async () => { expect((await afterRename(f => f.inUse.mockReturnValue("pane"))).error.message).toMatch(/running terminal/); });
  it("with nothing changed the removal completes", async () => {
    const hold = holdInspect(3); const f = fixture({ ownership: { inspect: hold.inspect } }); f.on(); const directory = owned(f);
    const request = ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor }); await vi.waitFor(() => expect(hold.calls()).toBe(3)); hold.gate.resolve();
    await expect(request).resolves.toEqual({ removed: true }); expect(existsSync(directory)).toBe(false); expect(readdirSync(join(f.root, "claude-code"))).toEqual([]);
  });
});

describe("P2-4 remainder: the renamed folder is looked at again when the inspector has answered", () => {
  const outside = (): string => { const dir = scratch(); mkdirSync(join(dir, "backups")); writeFileSync(join(dir, "backups", ".claude.json.backup.1"), "outside identity"); writeFileSync(join(dir, ".credentials.json"), "outside secret"); return dir; };
  const link = (target: string, path: string): boolean => { try { symlinkSync(target, path, "dir"); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return false; throw error; } };
  const untouched = (dir: string) => { expect(readFileSync(join(dir, "backups", ".claude.json.backup.1"), "utf8")).toBe("outside identity"); expect(readFileSync(join(dir, ".credentials.json"), "utf8")).toBe("outside secret"); };
  /** The inspector sees the real renamed folder and answers "no link"; the folder is replaced before that answer is used. `nth` picks which inspection of the renamed folder (1: before the logout, 2: before the backups go). */
  const swapping = (nth: number, how: "link" | "directory", target: string) => {
    let seen = 0, done = false;
    return { done: () => done, inspect: async (paths: readonly string[]) => {
      if (paths.length === 1 && /[\\/]\.working-[a-f0-9]{16}$/.test(paths[0]!) && ++seen === nth) {
        rmSync(paths[0]!, { recursive: true });
        if (how === "link") done = link(target, paths[0]!); else { renameSync(target, paths[0]!); done = true; }
      }
      return paths.map(() => false);
    } };
  };
  for (const how of ["link", "directory"] as const) {
    it(`${how === "link" ? "a link" : "another real folder"} put in place of the renamed folder after the FIRST inspection answered: refused, the logout is not run, the outside folder is untouched`, async () => {
      const target = outside(), swap = swapping(1, how, target); const f = fixture({ ownership: { inspect: swap.inspect } }); f.on(); owned(f);
      const error = (await ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor }).catch((e: Error) => e)) as Error;
      if (!swap.done()) return;
      expect(error).toBeInstanceOf(Error); expect(error.message).toMatch(/link|replaced while it was being checked|not inside this Runtime's profile folder/);
      expect(f.runLogout).not.toHaveBeenCalled(); untouched(how === "link" ? target : join(f.root, "claude-code", "work"));
    });
    it(`${how === "link" ? "a link" : "another real folder"} put in place after the inspection BEFORE the backups are deleted: refused, nothing outside is deleted`, async () => {
      const target = outside(), swap = swapping(2, how, target); const f = fixture({ ownership: { inspect: swap.inspect } }); f.on(); owned(f);
      const error = (await ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor }).catch((e: Error) => e)) as Error;
      if (!swap.done()) return;
      expect(error).toBeInstanceOf(Error); expect(error.message).toMatch(/link|replaced while it was being checked|not inside this Runtime's profile folder/);
      expect(f.runLogout).toHaveBeenCalledTimes(1);                                                // the first look was clean: the logout ran against the folder that was there
      untouched(how === "link" ? target : join(f.root, "claude-code", "work"));
    });
  }
  it("control: nothing replaced: the sign-out completes and deletes this profile's own backup", async () => {
    const swap = swapping(99, "link", scratch()); const f = fixture({ ownership: { inspect: swap.inspect } }); f.on(); const directory = owned(f); mkdirSync(join(directory, "backups")); writeFileSync(join(directory, "backups", ".claude.json.backup.1"), "mine");
    await expect(ask(f, "accounts.signout", { cli: "claude-code", profile: "work", actor })).resolves.toEqual({ loggedIn: false });
    expect(existsSync(join(directory, "backups", ".claude.json.backup.1"))).toBe(false); expect(readdirSync(join(f.root, "claude-code"))).toEqual(["work"]); expect(f.runLogout).toHaveBeenCalledTimes(1);
  });
});


describe("an audit log with an unreadable end stops the operations that need their record", () => {
  it("a last record that is not JSON: the removal is refused, nothing is removed, nothing is appended; once the log is readable again the removal works", async () => {
    const f = fixture(); f.on(); const directory = owned(f); const log = join(f.pairing, AUDIT_FILE); writeFileSync(log, `{"at":"2026-11-06T12:00:00.000Z","actor":"local","action":"switch","outcome":"ok","detail":"on","switch":"accounts"}\nnot json\n`);
    const kept = readFileSync(log, "utf8");
    await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/could not write its audit log/);
    expect(existsSync(directory)).toBe(true); expect(readFileSync(log, "utf8")).toBe(kept);
    writeFileSync(log, kept.split("\n")[0] + "\n"); f.tick(6000);
    await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).resolves.toEqual({ removed: true });
    for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
  });
  it("an incomplete tail left by an interrupted write is repaired, the operation goes ahead, and every line of the log parses", async () => {
    const f = fixture(); f.on(); const directory = owned(f); const log = join(f.pairing, AUDIT_FILE);
    writeFileSync(log, `{"at":"2026-11-06T12:00:00.000Z","actor":"local","action":"switch","outcome":"ok","detail":"on","switch":"accounts"}\n{"at":"2026-11-06T12:00:01.000Z","actor":"admin:u1","act`);
    await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).resolves.toEqual({ removed: true });
    expect(existsSync(directory)).toBe(false); const rows = readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(rows.map((row: any) => `${row.action}:${row.outcome}`)).toEqual(["switch:ok", "profile.remove:started", "profile.remove:ok"]);
  });
});

describe("P2: another audit writer's accepted record is never cut by an operation's own audit repair or rollback", () => {
  const seed = `{"at":"2026-11-06T12:00:00.000Z","actor":"local","action":"switch","outcome":"ok","detail":"on","switch":"accounts"}\n`;
  const other = { actor: "admin:u2", action: "profile.remove" as const, outcome: "started" as const, cli: "claude-code", profile: "home" };      // a record another writer was told is written
  const actions = (f: F): string[] => f.audit().map(row => `${row.actor}:${row.action}:${row.outcome}:${row.profile ?? ""}`);
  beforeEach(() => { const real = Atomics.wait.bind(Atomics); vi.spyOn(Atomics, "wait").mockImplementation(((...args: Parameters<typeof Atomics.wait>) => { if (tap.hook?.on === "wait" && !tap.inHook) tap.armed = true; return (real as any)(...args); }) as typeof Atomics.wait); });
  afterEach(() => { tap.hook = null; tap.armed = false; tap.inHook = false; tap.failAuditWrite = false; tap.calls = 0; auditLockTiming.waitMs = 3_000; auditLockTiming.unreadableMs = 10_000; vi.mocked(Atomics.wait).mockRestore(); });
  it("repair: B commits its record while the operation's `started` record is about to cut the incomplete tail: B's record stays, the operation goes ahead, every line parses", async () => {
    const f = fixture(); f.on(); const directory = owned(f); const log = join(f.pairing, AUDIT_FILE);
    writeFileSync(log, `${seed}{"at":"2026-11-06T12:00:01.000Z","actor":"admin:u1","act`);
    let accepted = false;
    tap.hook = { on: "wait", run: () => { rmSync(join(f.pairing, AUDIT_LOCK_FILE), { force: true }); appendAudit(f.pairing, other); accepted = true; } };      // as if the operation's lock had been cleared as stale
    await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).resolves.toEqual({ removed: true });
    expect(accepted).toBe(true); expect(tap.hook).toBeNull(); expect(existsSync(directory)).toBe(false);
    expect(actions(f)).toEqual(["local:switch:ok:", "admin:u2:profile.remove:started:home", `${actor}:profile.remove:started:work`, `${actor}:profile.remove:ok:work`]);
  });
  it("rollback: the operation's `started` write fails after B has repaired its partial tail and committed a record: the operation is refused and not executed, B's record stays, every line parses", async () => {
    const f = fixture(); f.on(); const directory = owned(f); const log = join(f.pairing, AUDIT_FILE); writeFileSync(log, seed);
    let accepted = false; tap.failAuditWrite = true;
    tap.hook = { on: "failedWrite", run: () => { tap.failAuditWrite = false; rmSync(join(f.pairing, AUDIT_LOCK_FILE), { force: true }); appendAudit(f.pairing, other); accepted = true; } };
    await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/could not write its audit log, so nothing was done/);
    tap.failAuditWrite = false; expect(accepted).toBe(true); expect(tap.hook).toBeNull();
    expect(existsSync(directory)).toBe(true); expect(f.changed).not.toHaveBeenCalled(); expect(f.runLogout).not.toHaveBeenCalled();
    expect(actions(f)).toEqual(["local:switch:ok:", "admin:u2:profile.remove:started:home"]);
  });
  it("a lock held by another live process: the operation is refused and nothing is touched (no repair, no cut, no record); when the lock is gone the operation works", async () => {
    auditLockTiming.waitMs = 60; const f = fixture(); f.on(); const directory = owned(f); const log = join(f.pairing, AUDIT_FILE);
    writeFileSync(log, `${seed}{"at":"2026-11-06T12:00:01.000Z","actor":"admin:u1","act`); const before = readFileSync(log, "utf8");
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" }); const lock = join(f.pairing, AUDIT_LOCK_FILE);
    try {
      writeFileSync(lock, JSON.stringify({ pid: holder.pid, token: "aaaaaaaaaaaaaaaa" }));
      await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).rejects.toThrow(/could not write its audit log/);
      expect(existsSync(directory)).toBe(true); expect(readFileSync(log, "utf8")).toBe(before); expect(existsSync(lock)).toBe(true);
      rmSync(lock); f.tick(6000);
      await expect(ask(f, "accounts.remove", { cli: "claude-code", profile: "work", actor })).resolves.toEqual({ removed: true });
    } finally { holder.kill(); }
    expect(actions(f)).toEqual(["local:switch:ok:", `${actor}:profile.remove:started:work`, `${actor}:profile.remove:ok:work`]); expect(existsSync(lock)).toBe(false);
  });
});
