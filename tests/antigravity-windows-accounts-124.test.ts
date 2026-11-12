/**
 * AGEND-124: named Antigravity accounts and sign-out on a paired Windows computer. The REAL Runtime side (`RemoteAccounts`, the profile folders, the ownership record) with a fake CLI process and fixture
 * data only: no token, no account, no real `agy` (the real-computer measurements are in the issue). What is locked here:
 *  - an account is a folder this Runtime made, and every launch of it (sign-in, status, an agent) names that folder (`--app_data_dir`, relative to the CLI's home) and carries the registry's `pin`;
 *  - a named sign-in never starts before an EMPTY scratch folder has answered "signed out" (else `not_isolated`, nothing started, no folder made);
 *  - a named account's sign-out removes its token file inside the verified folder and asks the CLI; the computer's own login is signed out through the Credential Manager entry the REGISTRY names;
 *  - the local `accounts` switch, one-at-a-time, the pace and the audit record apply, and only the Runtime's own accounts can be touched.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIT_FILE, setRemoteSwitch } from "../src/runtime-remote-setup.js";
import { ISOLATION_SCRATCH, PROFILE_OP_MIN_GAP_MS } from "../src/runtime-remote-accounts.js";
import { CREDENTIAL_PROFILE_CLIS, credentialProfileLaunch, credentialProfileReport, credentialProfileStore, parseCredentialProfileReport, withCredentialProfile } from "../src/runtime-credential-profiles.js";
import { buildAccountsView } from "../src/accounts-view.js";
import { probeCredentialIsolation, probeCredentialProfileStatus } from "../src/windows-cli-worker.js";
import { RuntimeClient } from "../src/runtime-client.js";
import { paneLedgerFiles } from "../src/runtime-pane-store.js";
import { AGY_CODE, AGY_SCREEN, ACTOR, ID, cleanScratch, runtimeRig, scratch, waitFor, type Rig } from "./helpers/machine-runtime.js";

afterEach(() => cleanScratch());
const TOKEN = "antigravity-oauth-token";
const PIN = { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" };
const audit = (f: Rig) => (existsSync(join(f.pairing, AUDIT_FILE)) ? readFileSync(join(f.pairing, AUDIT_FILE), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : []);
const agyDir = (f: Rig, name: string) => join(f.root, "antigravity", name);
/** A rig whose Runtime can prove isolation (its scratch folder answers "signed out"). */
const proven = (extra: Parameters<typeof runtimeRig>[0] = {}) => { const isolated = vi.fn(async () => true); return { f: runtimeRig({ agy: true, isolated, ...extra }), isolated }; };

describe("how a named Antigravity account is launched", () => {
  const home = win32.join("C:\\", "Users", "ada", ".gemini");
  it("is `--app_data_dir <folder relative to the CLI's home>` with the registry's pin, and replaces an ambient value of the pinned variable whatever its letter case", () => {
    const launch = credentialProfileLaunch({ PATH: "p", ssh_connection: "10.0.0.1 22 10.0.0.2 22", KEEP: "1" }, "antigravity", win32.join("C:\\", "Users", "ada", "agend-runtime", "credential-profiles", "antigravity", "work"), home, win32);
    expect(launch.args).toEqual(["--app_data_dir", "..\\agend-runtime\\credential-profiles\\antigravity\\work"]);
    expect(launch.env).toEqual({ PATH: "p", KEEP: "1", ...PIN });
    expect(Object.keys(launch.env).filter(key => key.toUpperCase() === "SSH_CONNECTION")).toEqual(["SSH_CONNECTION"]);
  });
  it("is refused when the folder is on another drive than the CLI's home (there is no relative path), before anything starts", () => {
    expect(() => credentialProfileLaunch({}, "antigravity", win32.join("D:\\", "agend", "credential-profiles", "antigravity", "work"), home, win32)).toThrow(/not on the same drive/);
  });
  it("keeps Claude Code's variable launch as it was (a variable and no arguments), and an environment alone is never a launch of an argument-based CLI", () => {
    expect(credentialProfileLaunch({ PATH: "p" }, "claude-code", "C:\\profiles\\work")).toEqual({ env: { PATH: "p", CLAUDE_CONFIG_DIR: "C:\\profiles\\work" }, args: [] });
    expect(() => withCredentialProfile({}, "antigravity", "C:\\profiles\\work")).toThrow(/by an argument/);
    expect(credentialProfileStore("antigravity")).toBe(TOKEN); expect(credentialProfileStore("claude-code")).toBeUndefined();
    expect(CREDENTIAL_PROFILE_CLIS.antigravity).toEqual({ arg: "--app_data_dir", store: TOKEN, pin: PIN });
  });
});

describe("what a computer reports about its accounts", () => {
  it("keeps Claude Code's where they always were and Antigravity's under `byCli`, only when it has any", () => {
    const f = runtimeRig({ created: ["a"], agyCreated: ["work"] });
    const report = credentialProfileReport(f.root, undefined, () => true);
    expect(report.profiles.map(p => p.name)).toEqual(["a"]); expect(report.byCli).toEqual({ antigravity: [{ name: "work", loggedIn: null, created: true }] });
    expect(credentialProfileReport(runtimeRig({ created: ["a"] }).root).byCli).toBeUndefined();
    expect(parseCredentialProfileReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });
  it("accepts nothing else under `byCli`: not Claude Code's own list, not a CLI without accounts, not a malformed row", () => {
    const row = { name: "work", loggedIn: true };
    for (const bad of [{ "claude-code": [row] }, { codex: [row] }, { antigravity: "work" }, { antigravity: [{ name: "a/b", loggedIn: true }] }, { antigravity: [row, { name: "WORK", loggedIn: false }] }, { antigravity: [{ ...row, extra: 1 }] }, [row]])
      expect(() => parseCredentialProfileReport({ profiles: [], byCli: bad }), JSON.stringify(bad)).toThrow(/Invalid credential profile report/);
    expect(parseCredentialProfileReport({ profiles: [], byCli: { antigravity: [row] } }).byCli).toEqual({ antigravity: [row] });
  });
});

describe("the status probe and the isolation probe of the Windows worker", () => {
  const exe = { path: "agy.exe", command: "agy.exe", args: [] as string[] };
  it("asks `agy --app_data_dir <folder> models` under the account's launch and reads the listing's own words: signed in, signed out, or unknown", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const answer = (ok: boolean, text: string) => async (_e: unknown, args: string[], env: NodeJS.ProcessEnv) => { calls.push({ args, env }); return { ok, text }; };
    const dir = join(scratch(), "work"); mkdirSync(dir); writeFileSync(join(dir, TOKEN), "FIXTURE-NOT-A-TOKEN");
    expect((await probeCredentialProfileStatus("antigravity", dir, async () => exe, answer(true, "gemini-3-pro  Gemini 3 Pro\n"))).loggedIn).toBe(true);
    expect((await probeCredentialProfileStatus("antigravity", dir, async () => exe, answer(false, "Please sign in to view available models"))).loggedIn).toBe(false);
    expect((await probeCredentialProfileStatus("antigravity", dir, async () => exe, answer(false, "network is unreachable"))).loggedIn).toBeNull();
    // P3-A: "signed in" with no token file in the folder is the Windows user's own login speaking, not this account's: could not confirm.
    expect((await probeCredentialProfileStatus("antigravity", join(scratch(), "empty"), async () => exe, answer(true, "gemini-3-pro  Gemini 3 Pro\n"))).loggedIn).toBeNull();
    expect(calls[0]!.args[0]).toBe("--app_data_dir"); expect(calls[0]!.args.at(-1)).toBe("models"); expect(calls[0]!.env.SSH_CONNECTION).toBe(PIN.SSH_CONNECTION);
  });
  it("proves isolation only from an explicit \"signed out\" for an empty scratch folder (asked once more when it said nothing), and removes the scratch folder", async () => {
    const root = scratch(), seen: string[] = [];
    const run = (text: string, ok = false) => async (_e: unknown, args: string[]) => { seen.push(args[1]!); return { ok, text }; };
    expect(await probeCredentialIsolation("antigravity", root, async () => exe, run("Please sign in to view available models"))).toBe(true);
    expect(seen).toHaveLength(1); expect(readdirSync(root)).toEqual([]);                     // removed
    seen.length = 0;
    expect(await probeCredentialIsolation("antigravity", root, async () => exe, run("gemini-3-pro  Gemini 3 Pro", true))).toBe(false);   // signed in under an empty folder: the keyring answered, not the folder
    expect(await probeCredentialIsolation("antigravity", root, async () => exe, run("boom"))).toBe(false);                                   // could not tell, twice
    expect(seen.length).toBe(4);
    expect(await probeCredentialIsolation("antigravity", root, async () => null, run("Please sign in"))).toBe(false);                         // no CLI to ask
  });
});

describe("a named Antigravity account's sign-in on the computer", () => {
  it("is never started before the isolation proof: no proof or a failed proof each leave nothing started and no folder made", async () => {
    const none = runtimeRig({ agy: true });                                            // a Runtime with no probe at all
    await expect(none.runtime.handle("signin.start", { cli: "antigravity", profile: "work", method: "subscription", actor: ACTOR })).rejects.toThrow(/^not_isolated:/);
    const no = proven(); no.isolated.mockResolvedValue(false);
    await expect(no.f.runtime.handle("signin.start", { cli: "antigravity", profile: "work", method: "subscription", actor: ACTOR })).rejects.toThrow(/^not_isolated:/);
    for (const f of [none, no.f]) { expect(f.spawned).toHaveLength(0); expect(existsSync(agyDir(f, "work"))).toBe(false); }
    expect(audit(no.f).filter(r => r.cli === "antigravity").map(r => [r.action, r.outcome, r.reason])).toEqual([["signin", "refused", "not_isolated"]]);
    await none.stop(); await no.f.stop();
  });
  it("asks an EMPTY scratch folder under the Runtime's own folder (never an account's, never a listed one), then starts `agy --app_data_dir <folder> acp --login` with the pin; the folder is made and recorded", async () => {
    const { f, isolated } = proven();
    const { sessionId } = await f.runtime.handle("signin.start", { cli: "antigravity", profile: "work", method: "subscription", actor: ACTOR }) as { sessionId: string };
    expect(isolated).toHaveBeenCalledTimes(1);
    const [cli, scratchRoot] = isolated.mock.calls[0] as unknown as [string, string];
    expect(cli).toBe("antigravity"); expect(scratchRoot).toBe(join(f.pairing, ISOLATION_SCRATCH)); expect(scratchRoot.startsWith(f.root)).toBe(false);
    expect(f.spawned).toHaveLength(1);
    const args = [...f.spawned[0]!.args];
    expect(args.slice(0, 1)).toEqual(["--app_data_dir"]); expect(args.slice(2)).toEqual(["acp", "--login"]);
    expect(args[1]!.replace(/\\/g, "/").endsWith("credential-profiles/antigravity/work")).toBe(true);   // relative to the CLI's own home, ending in the account's folder
    expect(f.spawned[0]!.env).toMatchObject(PIN);
    expect(lstatSync(agyDir(f, "work")).isDirectory()).toBe(true);
    expect(f.runtime.signInProfile()).toBe("work");
    expect(audit(f).filter(r => r.cli === "antigravity").map(r => [r.action, r.outcome])).toEqual([["signin", "started"], ["profile.add", "ok"]]);
    await f.runtime.handle("signin.close", { sessionId }); await f.stop();
  });
  it("is the same sign-in the dashboard drives: the link and the code box, a code, then the CLI's own status says it worked (a Claude account of the same name is another account)", async () => {
    const { f } = proven({ created: ["work"] });
    f.answer({ loggedIn: false });
    await f.signIns.begin(f.owner, f.agyNamed("work"));
    f.children[0]!.say(AGY_SCREEN);
    await waitFor(() => expect(f.signIns.snapshot(f.owner, f.agyNamed("work")).login?.phase).toBe("code"));
    f.answer({ loggedIn: true });
    const login = f.signIns.snapshot(f.owner, f.agyNamed("work")).login!;
    await f.signIns.input(f.owner, f.agyNamed("work"), login.id, login.revision, { kind: "code", value: AGY_CODE });
    expect(f.children[0]!.written).toBe(`${AGY_CODE}\n`);
    writeFileSync(join(agyDir(f, "work"), TOKEN), "FIXTURE-NOT-A-TOKEN");      // agy kept the login in the account's own file
    f.children[0]!.end(0);
    await waitFor(() => expect(f.signIns.snapshot(f.owner, f.agyNamed("work")).login?.phase).toBe("done"));
    expect(f.sent.map(s => s.operation)).toContain("accounts.check");
    expect(f.sent.find(s => s.operation === "signin.start")!.payload).toEqual({ cli: "antigravity", profile: "work", method: "subscription", actor: ACTOR });
    expect(f.events.at(-1)).toMatchObject({ backend: "antigravity", profile: "work", phase: "done" });
    await f.stop();
  });
  it("a refusal to prove isolation reaches the dialog as `not_isolated`, not as a transport failure, and nothing was started", async () => {
    const f = runtimeRig({ agy: true });
    await f.signIns.begin(f.owner, f.agyNamed("work"));
    await waitFor(() => expect(f.signIns.snapshot(f.owner, f.agyNamed("work")).login).toMatchObject({ phase: "failed", reason: "not_isolated" }));
    expect(f.spawned).toHaveLength(0); expect(existsSync(agyDir(f, "work"))).toBe(false);
    await f.stop();
  });
  it("is refused by an older Runtime (no `accounts-antigravity`) before it is asked, and by the owner's switch; the computer's own login keeps working on the older one", async () => {
    const old = runtimeRig({ agy: { accounts: false } });
    await expect(old.signIns.begin(old.owner, old.agyNamed("work"))).rejects.toThrow("machine_unsupported");
    await old.signIns.begin(old.owner, old.agyTarget);                                  // AGEND-113: still possible
    expect(old.sent.map(s => s.operation)).toContain("signin.start");
    const off = proven({ switchOn: false });
    await expect(off.f.signIns.begin(off.f.owner, off.f.agyNamed("work"))).rejects.toThrow("machine_accounts_off");
    await expect(off.f.runtime.handle("signin.start", { cli: "antigravity", profile: "work", method: "subscription", actor: ACTOR })).rejects.toThrow(/turned off/);
    expect(off.isolated).not.toHaveBeenCalled(); expect(off.f.spawned).toHaveLength(0);
    await old.stop(); await off.f.stop();
  });
  it("only a subscription sign-in, one at a time on the whole computer (a default sign-in blocks a named one), and never a folder this Runtime did not make", async () => {
    const { f } = proven({ agyCreated: ["made"] });
    await expect(f.runtime.handle("signin.start", { cli: "antigravity", profile: "work", method: "console", actor: ACTOR })).rejects.toThrow(/Only a subscription sign-in/);
    const first = await f.runtime.handle("signin.start", { cli: "antigravity", method: "subscription", actor: ACTOR }) as { sessionId: string };
    await expect(f.runtime.handle("signin.start", { cli: "antigravity", profile: "made", method: "subscription", actor: ACTOR })).rejects.toThrow(/Another sign-in/);
    await f.runtime.handle("signin.close", { sessionId: first.sessionId });
    f.tick(10_000);
    mkdirSync(agyDir(f, "byhand"), { recursive: true });
    await expect(f.runtime.handle("signin.start", { cli: "antigravity", profile: "byhand", method: "subscription", actor: ACTOR })).rejects.toThrow(/not created by this Runtime/);
    await f.stop();
  });
});

describe("a named Antigravity account's check, sign-out and removal", () => {
  const plant = (f: Rig, name: string) => { mkdirSync(agyDir(f, name), { recursive: true }); writeFileSync(join(agyDir(f, name), TOKEN), "FIXTURE-NOT-A-TOKEN"); writeFileSync(join(agyDir(f, name), "conversations.db"), "kept"); };
  it("a check asks the CLI under that account's folder and records the answer under Antigravity (and not under a Claude account of the same name)", async () => {
    const seen: string[] = [];
    const f = runtimeRig({ agy: true, agyCreated: ["work"], created: ["work"], status: async (cli, directory) => { seen.push(`${cli}:${directory}`); return { loggedIn: cli === "antigravity" }; } });
    expect(await f.runtime.handle("accounts.check", { cli: "antigravity", profile: "work" })).toEqual({ loggedIn: true });
    expect(seen).toEqual([`antigravity:${agyDir(f, "work")}`]);
    expect(JSON.parse(readFileSync(join(f.root, "status.json"), "utf8")).checkedAt).toEqual({ antigravity: { work: expect.objectContaining({ loggedIn: true }) } });
    await f.stop();
  });
  it("sign-out removes the token file (only that file, only in the verified folder), asks the CLI, and keeps the conversations", async () => {
    const f = runtimeRig({ agy: true, agyCreated: ["work"] });
    plant(f, "work");
    f.answer({ loggedIn: false });
    expect(await f.runtime.handle("accounts.signout", { cli: "antigravity", profile: "work", actor: ACTOR })).toEqual({ loggedIn: false });
    expect(existsSync(join(agyDir(f, "work"), TOKEN))).toBe(false); expect(readFileSync(join(agyDir(f, "work"), "conversations.db"), "utf8")).toBe("kept");
    expect(readdirSync(join(f.root, "antigravity"))).toEqual(["work"]);                  // put back under its own name, no temporary folder left
    expect(audit(f).filter(r => r.action === "profile.signout").map(r => [r.cli, r.profile, r.outcome])).toEqual([["antigravity", "work", "started"], ["antigravity", "work", "ok"]]);
    await f.stop();
  });
  it("says so when the CLI still reports a sign-in afterwards (a login kept somewhere else is not signed out), and a token file that is a link is never followed", async () => {
    const f = runtimeRig({ agy: true, agyCreated: ["work", "linked"] });
    plant(f, "work"); f.answer({ loggedIn: true });
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", profile: "work", actor: ACTOR })).rejects.toThrow(/still signed in after sign-out/);
    f.tick(PROFILE_OP_MIN_GAP_MS + 1);
    const outside = join(scratch(), "outside.txt"); writeFileSync(outside, "mine");
    try { symlinkSync(outside, join(agyDir(f, "linked"), TOKEN)); } catch { await f.stop(); return; }   // a system that cannot make a link here has nothing to prove
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", profile: "linked", actor: ACTOR })).rejects.toThrow();
    expect(readFileSync(outside, "utf8")).toBe("mine"); expect(lstatSync(join(agyDir(f, "linked"), TOKEN)).isSymbolicLink()).toBe(true);
    await f.stop();
  });
  it("is refused for an account this Runtime did not make, while an agent or a terminal uses it, and in a hurry; the owner's switch decides first", async () => {
    let using: "task" | undefined;
    const f = runtimeRig({ agy: true, agyCreated: ["work"] });
    const deps = (f.runtime as unknown as { deps: { inUse: () => unknown; inUseNow: () => unknown } }).deps;
    deps.inUse = () => using; deps.inUseNow = () => using;
    mkdirSync(agyDir(f, "byhand"), { recursive: true });
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", profile: "byhand", actor: ACTOR })).rejects.toThrow(/not created by this Runtime/);
    using = "task";
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", profile: "work", actor: ACTOR })).rejects.toThrow(/in use by a running task/);
    using = undefined; plant(f, "work"); f.answer({ loggedIn: false });
    await f.runtime.handle("accounts.signout", { cli: "antigravity", profile: "work", actor: ACTOR });
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", profile: "work", actor: ACTOR })).rejects.toThrow(/just changed/);
    setRemoteSwitch(f.pairing, "accounts", false, undefined, Date.now());
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", profile: "work", actor: ACTOR })).rejects.toThrow(/turned off/);
    await f.stop();
  });
  it("removal deletes the whole folder and its record; a Claude Code default profile of the same name does not hold it back, and an Antigravity account has no default", async () => {
    const f = runtimeRig({ agy: true, agyCreated: ["work"], created: ["work"], defaultProfile: () => "work" });
    plant(f, "work");
    expect(await f.runtime.handle("accounts.remove", { cli: "antigravity", profile: "work", actor: ACTOR })).toEqual({ removed: true });
    expect(existsSync(agyDir(f, "work"))).toBe(false); expect(existsSync(join(f.root, "claude-code", "work"))).toBe(true);
    f.tick(PROFILE_OP_MIN_GAP_MS + 1);
    await expect(f.runtime.handle("accounts.remove", { cli: "claude-code", profile: "work", actor: ACTOR })).rejects.toThrow(/default for agents/);
    await f.stop();
  });
});

describe("signing the computer's OWN Antigravity login out", () => {
  const credentialRig = (extra: Parameters<typeof runtimeRig>[0] = {}) => { const deleted: string[] = []; const f = runtimeRig({ agy: true, deleteCredential: async name => { deleted.push(name); return 0; }, ...extra }); return { f, deleted }; };
  it("deletes the Credential Manager entry THE REGISTRY names (never one from the request), then asks `agy models`, and records it as its own action", async () => {
    const { f, deleted } = credentialRig(); f.agyAnswer(false);
    expect(await f.runtime.handle("accounts.signout", { cli: "antigravity", actor: ACTOR })).toEqual({ loggedIn: false });
    expect(deleted).toEqual(["gemini:antigravity"]);
    expect(audit(f).filter(r => r.cli === "antigravity").map(r => [r.action, r.outcome, "profile" in r])).toEqual([["login.signout", "started", false], ["login.signout", "ok", false]]);
    await f.stop();
  });
  it("reports a login that is still there afterwards (the CLI keeps it elsewhere), and the entry is not asked for again at once", async () => {
    const { f, deleted } = credentialRig(); f.agyAnswer(true);
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", actor: ACTOR })).rejects.toThrow(/still signed in on this computer/);
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", actor: ACTOR })).rejects.toThrow(/just signed out/);
    expect(deleted).toHaveLength(1);
    await f.stop();
  });
  it("is refused while a task runs on the computer, while a sign-in is open, when the switch is off, and for a CLI that has no login of its own", async () => {
    let running = true;
    const { f, deleted } = credentialRig({ taskRunning: () => running }); f.agyAnswer(false);
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", actor: ACTOR })).rejects.toThrow(/A task is running on this computer/);
    running = false;
    const open = await f.runtime.handle("signin.start", { cli: "antigravity", method: "subscription", actor: ACTOR }) as { sessionId: string };
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", actor: ACTOR })).rejects.toThrow(/A sign-in is running|Another sign-in/);
    await f.runtime.handle("signin.close", { sessionId: open.sessionId });
    await expect(f.runtime.handle("accounts.signout", { cli: "claude-code", actor: ACTOR })).rejects.toThrow(/names the credential profile/);
    await expect(f.runtime.handle("accounts.signout", { cli: "codex", actor: ACTOR })).rejects.toThrow(/Only Claude Code and Antigravity accounts/);
    setRemoteSwitch(f.pairing, "accounts", false, undefined, Date.now());
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", actor: ACTOR })).rejects.toThrow(/turned off/);
    expect(deleted).toEqual([]);
    await f.stop();
  });
  it("is not possible on a Runtime that was not given the means (no Credential Manager call)", async () => {
    const f = runtimeRig({ agy: true });
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", actor: ACTOR })).rejects.toThrow(/cannot sign this computer's own login out/);
    await f.stop();
  });
});

describe("the Accounts page for a computer's Antigravity", () => {
  const view = async (f: Rig) => buildAccountsView({ targets: [], diskProfiles: new Map(), agents: [], classic: [], fleetDefaults: new Map(), machines: await f.accounts.list() });
  const rows = async (f: Rig) => (await view(f)).clis.find(c => c.backend === "antigravity")!.rows;
  const reason = (r: Awaited<ReturnType<typeof rows>>[number]) => (r.scope.kind === "machine" && r.scope.readOnlyReason ? r.scope.readOnlyReason : "");
  it("has the computer's own login first (signed in and out from here), then each account the Runtime made, each with its own Sign in, Sign out and Remove", async () => {
    const f = runtimeRig({ agy: { authenticated: true }, agyCreated: ["work"] });
    f.reportAgy([{ name: "work", loggedIn: true, created: true }, { name: "byhand", loggedIn: false, created: false }]);
    const all = await rows(f);
    expect(all.map(r => [r.profile, r.state, r.signIn, r.signOutOwn === true, reason(r)])).toEqual([
      [null, "usable", true, true, ""], ["byhand", "not_signed_in", false, false, "not_created"], ["work", "usable", true, false, ""]]);
    expect(all.find(r => r.profile === "byhand")).not.toHaveProperty("hostCommand");   // an Antigravity account has no command to run at that computer
    expect((await view(f)).clis.find(c => c.backend === "antigravity")!.machineProfiles).toBe(true);
    await f.stop();
  });
  it("shows the accounts but offers nothing on them when the Runtime is older, the CLI is old, or the owner's switch is off — each with its code, and no Add", async () => {
    const old = runtimeRig({ agy: { accounts: false } }); old.reportAgy([{ name: "work", loggedIn: true, created: true }]);
    const oldRows = await rows(old);
    expect(oldRows[0]).toMatchObject({ profile: null, signIn: true }); expect(oldRows[0]).not.toHaveProperty("signOutOwn");
    expect(oldRows[0]!.scope).toMatchObject({ namedAccounts: false });
    expect(oldRows[1]).toMatchObject({ profile: "work", signIn: false, scope: { readOnlyReason: "runtime_old", namedAccounts: false } });
    const cliOld = runtimeRig({ agy: { version: "1.4.9" } }); cliOld.reportAgy([{ name: "work", loggedIn: true, created: true }]);
    expect((await rows(cliOld)).map(r => [r.profile, r.signIn, reason(r)])).toEqual([[null, false, "cli_old"], ["work", false, "cli_old"]]);
    const off = runtimeRig({ agy: true, switchOn: false }); off.reportAgy([{ name: "work", loggedIn: true, created: true }]);
    expect((await rows(off)).every(r => !r.signIn && reason(r) === "accounts_off")).toBe(true);
    await old.stop(); await cliOld.stop(); await off.stop();
  });
  it("puts an agent on the account it names, and the agents that name none on the computer's own login", async () => {
    const f = runtimeRig({ agy: true, agyCreated: ["work"] });
    const deps = (f.accounts as unknown as { deps: { agents: (id: string, backend?: string) => unknown } }).deps;
    deps.agents = (_id, backend) => (backend === "antigravity" ? [{ name: "ada", profile: "work" }, { name: "bob", profile: null }] : []);
    f.reportAgy([{ name: "work", loggedIn: true, created: true }]);
    const all = await rows(f);
    expect(all.map(r => [r.profile, r.usedBy.agents])).toEqual([[null, ["bob"]], ["work", ["ada"]]]);
    await f.stop();
  });
});

describe("the server's side of Sign out and Remove for a computer's Antigravity", () => {
  it("signs a named account out and removes it through the Runtime, as that CLI's own operation, and remembers the change until the next inventory", async () => {
    const f = runtimeRig({ agy: true, agyCreated: ["work"] });
    mkdirSync(agyDir(f, "work"), { recursive: true }); writeFileSync(join(agyDir(f, "work"), TOKEN), "x");
    f.reportAgy([{ name: "work", loggedIn: true, created: true }]);
    f.answer({ loggedIn: false });
    expect(await f.accounts.signOut("antigravity", "work", true, ID, f.who, "tester")).toEqual({ ok: true });
    expect(f.sent.at(-1)).toEqual({ operation: "accounts.signout", payload: { cli: "antigravity", profile: "work", actor: ACTOR } });
    expect(f.accounts.profileState(ID, "work", "antigravity")).toMatchObject({ state: "invalid" });
    expect(f.accounts.profileState(ID, "work")).toMatchObject({ exists: false });        // not a Claude account of that name
    f.tick(PROFILE_OP_MIN_GAP_MS + 1);
    expect(await f.accounts.remove("antigravity", "work", "work", ID, f.who, "tester")).toEqual({ ok: true });
    expect(f.sent.at(-1)!.payload).toEqual({ cli: "antigravity", profile: "work", actor: ACTOR });
    expect(f.accounts.profileState(ID, "work", "antigravity").exists).toBe(false);
    await f.stop();
  });
  it("signs the computer's own login out when the name is null — Antigravity's only, never Claude Code's — and the page reads it as signed out", async () => {
    const deleted: string[] = [];
    const f = runtimeRig({ agy: { authenticated: true }, deleteCredential: async name => { deleted.push(name); return 0; } }); f.agyAnswer(false);
    expect(await f.accounts.signOut("claude-code", null, true, ID, f.who, "t")).toEqual({ ok: false, error: "machine_default_login" });
    expect(await f.accounts.signOut("antigravity", null, false, ID, f.who, "t")).toEqual({ ok: false, error: "confirm" });
    expect(await f.accounts.signOut("antigravity", null, true, ID, f.who, "t")).toEqual({ ok: true });
    expect(deleted).toEqual(["gemini:antigravity"]); expect(f.sent.at(-1)!.payload).toEqual({ cli: "antigravity", actor: ACTOR });
    expect(f.accounts.reportedDefault(ID, "antigravity")).toBe("invalid");
    await f.stop();
  });
  it("refuses on the server before the computer is asked to change anything: a Runtime without the capability, an unreported or not-ours account", async () => {
    const old = runtimeRig({ agy: { accounts: false } });
    expect(await old.accounts.signOut("antigravity", null, true, ID, old.who, "t")).toMatchObject({ ok: false, error: "machine_unsupported" });
    expect(await old.accounts.add("antigravity", "work", ID, "t")).toMatchObject({ ok: false, error: "machine_unsupported" });
    expect(old.sent).toEqual([]);
    const f = runtimeRig({ agy: true }); f.reportAgy([{ name: "byhand", loggedIn: false, created: false }]);
    expect(await f.accounts.signOut("antigravity", "missing", true, ID, f.who, "t")).toMatchObject({ ok: false, error: "missing" });
    expect(await f.accounts.signOut("antigravity", "byhand", true, ID, f.who, "t")).toMatchObject({ ok: false, error: "machine_profile_not_owned" });
    expect(await f.accounts.remove("antigravity", "byhand", "byhand", ID, f.who, "t")).toMatchObject({ ok: false, error: "machine_profile_not_owned" });
    expect(await f.accounts.add("antigravity", "byhand", ID, "t")).toMatchObject({ ok: false, error: "exists" });
    expect(await f.accounts.add("antigravity", "BYHAND", ID, "t")).toMatchObject({ ok: false, error: "case_clash", clash: "byhand" });
    expect(await f.accounts.add("antigravity", "fresh", ID, "t")).toEqual({ ok: true });
    expect(f.sent.every(s => s.operation === "accounts.switches")).toBe(true);          // only the owner's switch was read
    await old.stop(); await f.stop();
  });
});

describe("a named account's e-mail, read from its own token file on the computer (AGEND-124 stage 2A)", () => {
  const exe = { path: "agy.exe", command: "agy.exe", args: [] as string[] };
  const listing = async () => ({ ok: true, text: "gemini-3-pro  Gemini 3 Pro\n" });
  const signedOut = async () => ({ ok: false, text: "Please sign in to view available models" });
  const SECRETS = ["ACCESS-FIXTURE-aaa", "REFRESH-FIXTURE-bbb", "ID-TOKEN-FIXTURE-ccc"];
  const tokenFile = (extra: Record<string, unknown> = {}) => JSON.stringify({ token: { access_token: SECRETS[0], refresh_token: SECRETS[1], expiry: "2030-01-01T00:00:00Z" }, id_token: SECRETS[2], id_token_email: "juan@example.com", ...extra });
  const folder = (content?: string | ((dir: string) => void)) => { const dir = join(scratch(), "work"); mkdirSync(dir, { recursive: true }); if (typeof content === "string") writeFileSync(join(dir, TOKEN), content); else content?.(dir); return dir; };
  it("is the whole address of `id_token_email` and nothing else of the file: no token, no other field", async () => {
    const answer = await probeCredentialProfileStatus("antigravity", folder(tokenFile({ name: "Juan Fixture", picture: "https://example.com/p.png", id_token_name: "Juan" })), async () => exe, listing);
    expect(answer).toEqual({ loggedIn: true, identity: { maskedEmail: "juan@example.com" } });
    const text = JSON.stringify(answer);
    for (const secret of [...SECRETS, "Juan Fixture", "picture"]) expect(text).not.toContain(secret);
  });
  it("is nothing for a file with no such field, a field that is not an address, a file that is not JSON, one too big, and a link", async () => {
    const none = async (dir: string) => (await probeCredentialProfileStatus("antigravity", dir, async () => exe, listing));
    expect(await none(folder(JSON.stringify({ token: { access_token: SECRETS[0] } })))).toEqual({ loggedIn: true });
    expect(await none(folder(JSON.stringify({ id_token_email: "not-an-address" })))).toEqual({ loggedIn: true });
    expect(await none(folder(JSON.stringify({ id_token_email: 5 })))).toEqual({ loggedIn: true });
    expect(await none(folder("{not json"))).toEqual({ loggedIn: true });
    expect(await none(folder(tokenFile({ pad: "x".repeat(70 * 1024) })))).toEqual({ loggedIn: true });
    const linked = folder(dir => { const outside = join(scratch(), "outside.json"); writeFileSync(outside, tokenFile()); try { symlinkSync(outside, join(dir, TOKEN)); } catch { writeFileSync(join(dir, TOKEN), "x"); } });
    expect(await none(linked)).toEqual({ loggedIn: null });                // a link is no evidence of a sign-in in this folder
  });
  it("is read only for a folder the CLI says is signed in, and never for the isolation probe's scratch folder", async () => {
    const dir = folder(tokenFile());
    expect(await probeCredentialProfileStatus("antigravity", dir, async () => exe, signedOut)).toEqual({ loggedIn: false });
    expect(await probeCredentialProfileStatus("antigravity", dir, async () => exe, listing, undefined, false)).toEqual({ loggedIn: true });   // withIdentity off
    // The isolation probe passes that off: a scratch folder holding a token (a CLI that ignores the folder) is "signed in", not proof, and names nobody.
    expect(await probeCredentialIsolation("antigravity", dirname(dir), async () => exe, listing)).toBe(false);
  });
  it("reaches the page: a check reports it, the cache keeps it, and the Accounts row shows it; the computer's own login names nobody", async () => {
    const f = runtimeRig({ agy: { authenticated: true }, agyCreated: ["work"], status: (cli, dir) => probeCredentialProfileStatus(cli, dir, async () => exe, listing) });
    writeFileSync(join(agyDir(f, "work"), TOKEN), tokenFile());
    expect(await f.runtime.handle("accounts.check", { cli: "antigravity", profile: "work" })).toEqual({ loggedIn: true, identity: { maskedEmail: "juan@example.com" } });
    const cache = readFileSync(join(f.root, "status.json"), "utf8");
    expect(cache).toContain("juan@example.com"); for (const secret of SECRETS) expect(cache).not.toContain(secret);
    const report = credentialProfileReport(f.root, undefined, () => true);
    expect(report.byCli!.antigravity![0]).toMatchObject({ name: "work", identity: { maskedEmail: "juan@example.com" } });
    f.reportAgy(report.byCli!.antigravity!);
    const rows = (await buildAccountsView({ targets: [], diskProfiles: new Map(), agents: [], classic: [], fleetDefaults: new Map(), machines: await f.accounts.list() })).clis.find(c => c.backend === "antigravity")!.rows;
    expect(rows.map(r => [r.profile, (r.identity as { maskedEmail?: string } | undefined)?.maskedEmail ?? null])).toEqual([[null, null], ["work", "juan@example.com"]]);
    await f.stop();
  });
  it("a report row takes a whole address (and an older masked one); one that does not fit is refused as a protocol error, never shortened", () => {
    for (const ok of ["juan@example.com", "ju***@example.com"]) expect(() => parseCredentialProfileReport({ profiles: [], byCli: { antigravity: [{ name: "work", loggedIn: true, identity: { maskedEmail: ok } }] } }), ok).not.toThrow();
    for (const bad of [`${"j".repeat(255 - "@example.com".length)}@example.com`, "juan@exämple.com", "juan @example.com", "juan@x@example.com"]) expect(() => parseCredentialProfileReport({ profiles: [], byCli: { antigravity: [{ name: "work", loggedIn: true, identity: { maskedEmail: bad } }] } }), bad.slice(0, 10)).toThrow(/Invalid credential profile report/);
  });
});

describe("a named sign-in that ended well must have left its sign-in in the account's own folder (P2-1)", () => {
  const finish = async (f: Rig, before?: (dir: string) => void) => {
    await f.signIns.begin(f.owner, f.agyNamed("work"));
    f.children[0]!.say(AGY_SCREEN);
    await waitFor(() => expect(f.signIns.snapshot(f.owner, f.agyNamed("work")).login?.phase).toBe("code"));
    const login = f.signIns.snapshot(f.owner, f.agyNamed("work")).login!;
    await f.signIns.input(f.owner, f.agyNamed("work"), login.id, login.revision, { kind: "code", value: AGY_CODE });
    before?.(agyDir(f, "work"));
    f.children[0]!.end(0);
  };
  it("no file in the folder: the sign-in is `not_isolated` (even though the CLI's status says signed in, from a store every folder shares), and the record says so", async () => {
    const { f } = proven(); f.answer({ loggedIn: true });
    await finish(f);
    await waitFor(() => expect(f.signIns.snapshot(f.owner, f.agyNamed("work")).login).toMatchObject({ phase: "failed", reason: "not_isolated" }));
    expect(f.sent.filter(s => s.operation === "accounts.check")).toHaveLength(1);        // only the check that came before the command; none after it ended
    await f.signIns.cancel(f.owner, f.agyNamed("work"));
    expect(audit(f).filter(r => r.action === "signin" && r.outcome === "failed").at(-1)).toMatchObject({ cli: "antigravity", profile: "work", reason: "not_isolated" });
    await f.stop();
  });
  it("a link or a folder where the file should be is no sign-in either", async () => {
    for (const make of [(dir: string) => mkdirSync(join(dir, TOKEN)), (dir: string) => { const outside = join(scratch(), "o.json"); writeFileSync(outside, "x"); symlinkSync(outside, join(dir, TOKEN)); }]) {
      const { f } = proven(); f.answer({ loggedIn: true });
      try { await finish(f, make); } catch { await f.stop(); continue; }
      await waitFor(() => expect(f.signIns.snapshot(f.owner, f.agyNamed("work")).login).toMatchObject({ phase: "failed", reason: "not_isolated" }));
      await f.stop();
    }
  });
  it("a plain file makes it succeed; a command that failed is not asked about the file at all; the computer's own login has no folder to ask", async () => {
    const { f } = proven(); f.answer({ loggedIn: true });
    await finish(f, dir => writeFileSync(join(dir, TOKEN), "FIXTURE-NOT-A-TOKEN"));
    await waitFor(() => expect(f.signIns.snapshot(f.owner, f.agyNamed("work")).login?.phase).toBe("done"));
    await f.stop();
    const own = runtimeRig({ agy: true }); own.agyAnswer(false);
    await own.signIns.begin(own.owner, own.agyTarget);
    own.children[0]!.say(AGY_SCREEN);
    await waitFor(() => expect(own.signIns.snapshot(own.owner, own.agyTarget).login?.phase).toBe("code"));
    const login = own.signIns.snapshot(own.owner, own.agyTarget).login!;
    await own.signIns.input(own.owner, own.agyTarget, login.id, login.revision, { kind: "code", value: AGY_CODE });
    own.agyAnswer(true); own.children[0]!.end(0);
    await waitFor(() => expect(own.signIns.snapshot(own.owner, own.agyTarget).login?.phase).toBe("done"));
    await own.stop();
  });
  it("the Runtime answers `isolated: false` only for that case, and the transport refuses any other value", async () => {
    const { f } = proven();
    const { sessionId } = await f.runtime.handle("signin.start", { cli: "antigravity", profile: "work", method: "subscription", actor: ACTOR }) as { sessionId: string };
    expect(await f.runtime.handle("signin.status", { sessionId })).toEqual({ alive: true });
    f.children[0]!.end(0);
    expect(await f.runtime.handle("signin.status", { sessionId })).toEqual({ alive: false, exitCode: 0, isolated: false });
    await f.runtime.handle("signin.close", { sessionId }); await f.stop();
  });
});

describe("signing the computer's own login out while an Antigravity terminal is open (P3-1)", () => {
  const ledger = (rows: unknown, clientDirectory = scratch()) => { const file = paneLedgerFiles(clientDirectory)[1]!; mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ panes: rows })); return clientDirectory; };
  const running = (directory: string) => (RuntimeClient.prototype as unknown as { cliTerminalRunning(this: unknown, cli: string): boolean }).cliTerminalRunning.call({ options: { store: { directory } }, computerBootValue: "boot-1" }, "antigravity");
  it("refuses for an open Antigravity terminal of any account, and for a ledger it cannot read; not for exited ones, other CLIs' terminals, or another boot's", () => {
    expect(running(scratch())).toBe(false);                                                                      // no ledger: none
    expect(running(ledger({ a: { launch: { cli: "antigravity" }, snapshot: { state: "running" }, systemBootId: "boot-1" } }))).toBe(true);
    expect(running(ledger({ a: { launch: { cli: "antigravity", credentialProfile: "work" }, snapshot: { state: "running" } } }))).toBe(true);
    expect(running(ledger({ a: { launch: { cli: "antigravity" }, snapshot: { state: "exited" } }, b: { launch: { cli: "claude-code" }, snapshot: { state: "running" } },
      c: { launch: { cli: "antigravity" }, snapshot: { state: "running" }, systemBootId: "boot-0" } }))).toBe(false);
    const broken = scratch(); const file = paneLedgerFiles(broken)[1]!; mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "{not json");
    expect(running(broken)).toBe(true);
  });
});

describe("P3-A and P3-B (AGEND-124 2B)", () => {
  it("a later check that reads \"signed in\" cannot turn a not_isolated sign-in into a success, in the record or the cache", async () => {
    const { f } = proven(); f.answer({ loggedIn: true });
    const { sessionId } = await f.runtime.handle("signin.start", { cli: "antigravity", profile: "work", method: "subscription", actor: ACTOR }) as { sessionId: string };
    f.children[0]!.end(0);
    expect(await f.runtime.handle("signin.status", { sessionId })).toMatchObject({ isolated: false });
    f.tick(PROFILE_OP_MIN_GAP_MS + 1);
    expect(await f.runtime.handle("accounts.check", { cli: "antigravity", profile: "work" })).toMatchObject({ loggedIn: true });   // the rig's status says so
    await f.runtime.handle("signin.close", { sessionId });
    expect(audit(f).filter(r => r.action === "signin").at(-1)).toMatchObject({ outcome: "failed", reason: "not_isolated" });
    await f.stop();
  });
  it("the sign-out of the computer's own login waits for the boot identity before it looks at the terminals", async () => {
    const order: string[] = [];
    const { f, deleted } = (() => { const deleted: string[] = []; const f = runtimeRig({ agy: true, deleteCredential: async name => { deleted.push(name); return 0; }, taskRunning: async () => { order.push("asked"); await Promise.resolve(); order.push("answered"); return false; } }); return { f, deleted }; })();
    f.agyAnswer(false);
    await f.runtime.handle("accounts.signout", { cli: "antigravity", actor: ACTOR });
    expect(order.slice(0, 2)).toEqual(["asked", "answered"]); expect(deleted).toEqual(["gemini:antigravity"]);
    await f.stop();
  });
});
