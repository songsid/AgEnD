/**
 * #3190 Part 3c: a paired computer's accounts in Settings → Accounts — the rows under the `machine` scope (accounts-view.ts), the server's questions and
 * operations for a computer (machine-accounts.ts), and what the dashboard may say and send. Fixtures only (example.com, fixture ids).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAccountsView, MACHINE_READ_ONLY_REASONS, type MachineAccountsInput } from "../src/accounts-view.js";
import { MachineAccounts, machineAgents, type MachineAccountsDeps } from "../src/machine-accounts.js";
import type { RuntimeMachine } from "../src/runtime-protocol.js";
import { parseCredentialProfileReport, credentialProfileReport, ensureCredentialProfile } from "../src/runtime-credential-profiles.js";
import { createRuntimeProfile, isCreatedProfile } from "../src/runtime-profile-ownership.js";
import { ID as RIG_ID, cleanScratch, runtimeRig } from "./helpers/machine-runtime.js";

const ID = "11111111-2222-3333-4444-555555555555";
const ME = { id: ID, actor: "admin:0123456789abcdef" };
const baseView = { targets: [{ backend: "claude-code", state: "usable", signIn: true } as any], diskProfiles: new Map(), agents: [], classic: [], fleetDefaults: new Map() };
const machine = (extra: Partial<MachineAccountsInput> = {}): MachineAccountsInput => ({ id: ID, name: "Desk PC", online: true, profiles: [], agents: [], ...extra });
const claudeRows = (machines: MachineAccountsInput[]) => buildAccountsView({ ...baseView, machines }).clis.find(c => c.backend === "claude-code")!.rows;

describe("the rows under the machine scope", () => {
  it("a computer is its default row (read-only: the Windows user's own sign-in) and one row per reported profile, in the same row shape as the host's", () => {
    const rows = claudeRows([machine({ profiles: [{ name: "work", loggedIn: true, created: true, identity: { maskedEmail: "ab***@example.com", plan: "max" } }, { name: "home", loggedIn: false, created: true }],
      defaultLogin: { loggedIn: true, identity: { maskedEmail: "cd***@example.com", plan: "pro" } }, agents: [{ name: "w1", profile: "work" }, { name: "w2", profile: null }], defaultProfile: "work" })]);
    const host = rows.filter(r => r.scope.kind === "host"), mine = rows.filter(r => r.scope.kind === "machine");
    expect(host.length).toBe(1);                                                 // the host's own rows are untouched
    expect(mine.map(r => r.profile)).toEqual([null, "home", "work"]);
    const [def, home, work] = mine;
    expect(def).toMatchObject({ scope: { kind: "machine", id: ID, name: "Desk PC", online: true, readOnlyReason: "default_login" }, state: "usable", signIn: false, identity: { maskedEmail: "cd***@example.com" }, usedBy: { agents: ["w2"], fleetDefault: false } });
    expect(work).toMatchObject({ scope: { kind: "machine", id: ID }, state: "usable", signIn: true, identity: { maskedEmail: "ab***@example.com", plan: "max" }, usedBy: { agents: ["w1"], classic: [], fleetDefault: true } });
    expect(work!.scope).not.toHaveProperty("readOnlyReason");
    expect(home).toMatchObject({ state: "not_signed_in", signIn: true, usedBy: { agents: [], fleetDefault: false } });
    // No usage (that computer reports none), no host-only fields.
    for (const row of mine) { expect(row.usage).toBeUndefined(); expect(row).not.toHaveProperty("install"); }
    expect(Object.keys(work!).sort()).toEqual(["backend", "identity", "profile", "scope", "signIn", "state", "usedBy"]);
  });
  it("a profile this Runtime did not create (or that an older Runtime does not say) is read-only with its own reason and the command to run on that computer", () => {
    const rows = claudeRows([machine({ profiles: [{ name: "by-hand", loggedIn: true, created: false }, { name: "old", loggedIn: false }, { name: "ours", loggedIn: false, created: true }] })]);
    const by = (n: string) => rows.find(r => r.profile === n)!;
    expect(by("by-hand")).toMatchObject({ signIn: false, scope: { readOnlyReason: "not_created" }, hostCommand: "agend-runtime login claude-code by-hand" });
    expect(by("old")).toMatchObject({ signIn: false, scope: { readOnlyReason: "not_created" } });
    expect(by("ours")).toMatchObject({ signIn: true }); expect(by("ours").hostCommand).toBeUndefined(); expect(by("ours").scope).not.toHaveProperty("readOnlyReason");
  });
  it("a reason that is about the whole computer is on every row (offline, an older Runtime, the owner's switch, no Claude Code), and nothing can be changed", () => {
    for (const reason of ["offline", "runtime_old", "accounts_off", "switch_unreadable", "not_installed"] as const) {
      const rows = claudeRows([machine({ online: reason !== "offline", readOnlyReason: reason, profiles: [{ name: "work", loggedIn: true, created: true }] })]).filter(r => r.scope.kind === "machine");
      expect(rows.map(r => r.signIn), reason).toEqual([false, false]);
      expect(rows.find(r => r.profile === "work")!.scope, reason).toMatchObject({ readOnlyReason: reason });
      expect(rows.find(r => r.profile === "work")!.hostCommand).toBe("agend-runtime login claude-code work");
    }
    expect(MACHINE_READ_ONLY_REASONS).toEqual(["offline", "runtime_old", "accounts_off", "switch_unreadable", "not_installed", "not_created", "default_login"]);
  });
  it("two computers are two groups; a computer with a profile of a case-variant name is matched in 'used by'; the default row is the fallback when no profile is the default", () => {
    const other = "99999999-2222-3333-4444-555555555555";
    const rows = claudeRows([machine({ profiles: [{ name: "Work", loggedIn: true, created: true }], agents: [{ name: "a", profile: "work" }] }), machine({ id: other, name: "Laptop", profiles: [] })]);
    expect(rows.filter(r => r.scope.kind === "machine").map(r => (r.scope as any).id + ":" + (r.profile ?? "-"))).toEqual([`${ID}:-`, `${ID}:Work`, `${other}:-`]);
    expect(rows.find(r => r.profile === "Work")!.usedBy.agents).toEqual(["a"]);
    expect(rows.find(r => r.scope.kind === "machine" && r.profile === null && (r.scope as any).id === other)!.usedBy.fleetDefault).toBe(true);
  });
  it("a card that is only here for a computer shows no host rows; the host's own cards are unchanged without computers", () => {
    const only = buildAccountsView({ targets: [{ backend: "claude-code", state: "not_installed", signIn: false } as any], diskProfiles: new Map(), agents: [], classic: [], fleetDefaults: new Map(), machines: [machine({ profiles: [{ name: "work", loggedIn: true, created: true }] })] });
    expect(only.clis.map(c => c.backend)).toEqual(["claude-code"]);
    expect(only.clis[0]!.rows.every(r => r.scope.kind === "machine")).toBe(true);
    expect(buildAccountsView({ targets: [{ backend: "claude-code", state: "not_installed", signIn: false } as any], diskProfiles: new Map(), agents: [], classic: [], fleetDefaults: new Map(), machines: [] }).clis).toEqual([]);
    expect(buildAccountsView(baseView)).toEqual(buildAccountsView({ ...baseView, machines: [] }));
  });
  it("only Claude Code has rows on a computer (Codex waits for #3212 PR 4)", () => {
    const view = buildAccountsView({ ...baseView, targets: [{ backend: "claude-code", state: "usable", signIn: true } as any, { backend: "codex", state: "usable", signIn: true } as any], machines: [machine()] });
    expect(view.clis.find(c => c.backend === "codex")!.rows.every(r => r.scope.kind === "host")).toBe(true);
  });
});

describe("what a Runtime reports about its profiles", () => {
  it("`created` is a boolean when present; a path, an e-mail or a wrong type is a protocol error naming the field only", () => {
    expect(parseCredentialProfileReport({ profiles: [{ name: "work", loggedIn: true, created: true }, { name: "home", loggedIn: null }] }).profiles).toEqual([{ name: "work", loggedIn: true, created: true }, { name: "home", loggedIn: null }]);
    expect(() => parseCredentialProfileReport({ profiles: [{ name: "work", loggedIn: true, created: "yes" }] })).toThrow("Invalid credential profile report: created");
    expect(() => parseCredentialProfileReport({ profiles: [{ name: "work", loggedIn: true, path: "C:\\x" }] })).toThrow("Invalid credential profile report: profile field");
  });
  it("the Runtime's own report says which profiles it created (its record, not where the folder sits), and nothing about it when it is not told how to know", () => {
    const root = join(mkdtempSync(join(tmpdir(), "agend-3c-")), "credential-profiles"); roots.push(root);
    createRuntimeProfile(root, "claude-code", "ours"); ensureCredentialProfile(root, "claude-code", "by-hand");
    const known = credentialProfileReport(root, undefined, name => isCreatedProfile(root, "claude-code", name));
    expect(known.profiles.map(p => [p.name, p.created])).toEqual([["by-hand", false], ["ours", true]]);
    expect(credentialProfileReport(root).profiles.every(p => !("created" in p))).toBe(true);
    expect(JSON.stringify(known)).not.toContain(root);
  });
});
const roots: string[] = [];
afterEach(() => { cleanScratch(); for (const root of roots.splice(0)) rmSync(join(root, ".."), { recursive: true, force: true }); });

function runtimeMachine(extra: Partial<RuntimeMachine> = {}): RuntimeMachine {
  return { id: ID, name: "Desk PC", platform: "win32", status: "online", createdAt: 1, generation: 1,
    runtimeInfo: { protocolVersions: [1], capabilities: ["exec", "remote-signin"] },
    inventory: { clis: [{ id: "claude-code", path: "C:\\claude.exe", version: "2.1.318", authenticated: true, runnable: true, supports: {}, readOnlySupport: true, permissionNote: "", models: [] } as any], home: "C:\\Users\\x", probedAt: 1,
      credentialProfiles: { profiles: [{ name: "work", loggedIn: true, created: true }, { name: "by-hand", loggedIn: false, created: false }], default: "work" } },
    ...extra } as RuntimeMachine;
}
function fixture(opts: { machine?: Partial<RuntimeMachine>; switchOn?: boolean | "error" | "garbage"; agents?: Array<{ name: string; profile: string | null }>; signingIn?: boolean } = {}) {
  let row = runtimeMachine(opts.machine);
  const calls: Array<{ operation: string; payload: unknown; timeoutMs?: number }> = [];
  const log: unknown[] = [];
  const state = { switchOn: opts.switchOn ?? true, refuse: undefined as string | undefined, now: 1_000 };
  const call = vi.fn(async (_id: string, operation: string, payload: unknown, timeoutMs?: number) => {
    calls.push({ operation, payload, timeoutMs });
    if (operation === "accounts.switches") { if (state.switchOn === "error") throw new Error("That computer did not answer in time"); if (state.switchOn === "garbage") return { accounts: "on" }; return { accounts: { on: state.switchOn }, install: { on: false } }; }
    if (state.refuse) throw new Error(state.refuse);
    return operation === "accounts.remove" ? { removed: true } : { loggedIn: false };
  });
  const deps: MachineAccountsDeps = { call: call as any, machine: id => (id === ID ? row : undefined), machines: () => [row], agents: () => opts.agents ?? [], signingIn: () => opts.signingIn === true,
    log: entry => { log.push(entry); }, now: () => state.now };
  return { accounts: new MachineAccounts(deps), calls, log, state, set: (m: Partial<RuntimeMachine>) => { row = { ...row, ...m }; }, call };
}

describe("MachineAccounts.list", () => {
  it("reads the owner's switch from the computer; on means the rows can be changed", async () => {
    const f = fixture(); const [m] = await f.accounts.list();
    expect(m).toMatchObject({ id: ID, name: "Desk PC", online: true, defaultProfile: "work", defaultLogin: { loggedIn: true } });
    expect(m!.readOnlyReason).toBeUndefined();
    expect(m!.profiles).toEqual([{ name: "work", loggedIn: true, created: true }, { name: "by-hand", loggedIn: false, created: false }]);
    expect(f.calls).toEqual([{ operation: "accounts.switches", payload: {}, timeoutMs: 15_000 }]);
  });
  it.each([
    ["the switch is off", { switchOn: false as const }, "accounts_off"],
    ["the switch cannot be read", { switchOn: "error" as const }, "switch_unreadable"],
    ["the answer is not a switch", { switchOn: "garbage" as const }, "switch_unreadable"],
    ["the computer is offline", { machine: { status: "offline" as const } }, "offline"],
    ["the Runtime is too old for remote sign-in", { machine: { runtimeInfo: { protocolVersions: [1], capabilities: ["exec"] } } }, "runtime_old"],
    ["Claude Code is not on that computer", { machine: { inventory: { clis: [], home: "C:\\", probedAt: 5 } as any } }, "not_installed"],
  ])("%s: every row is read-only with its reason", async (_name, opts, reason) => {
    const f = fixture(opts as any); const [m] = await f.accounts.list();
    expect(m!.readOnlyReason).toBe(reason);
    if (reason === "offline" || reason === "runtime_old") expect(f.calls).toEqual([]);   // an offline or older computer is never asked
  });
  it("a computer that was never probed is not 'without Claude Code'; pending and revoked computers are not listed; the switch is cached briefly and read again after that", async () => {
    const f = fixture({ machine: { inventory: { clis: [], home: "", probedAt: null } as any } }); expect((await f.accounts.list())[0]!.readOnlyReason).toBeUndefined();
    await f.accounts.list(); expect(f.calls.length).toBe(1);
    f.state.now += 6_000; await f.accounts.list(); expect(f.calls.length).toBe(2);
    f.set({ status: "pending" }); expect(await f.accounts.list()).toEqual([]); f.set({ status: "revoked" }); expect(await f.accounts.list()).toEqual([]);
  });
  it("a computer that never answers does not hold the view: the switch read is bounded", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); f.call.mockImplementation(() => new Promise(() => {}));
      const pending = f.accounts.list(); await vi.advanceTimersByTimeAsync(3_100);
      expect((await pending)[0]!.readOnlyReason).toBe("switch_unreadable");
    } finally { vi.useRealTimers(); }
  });
});

describe("add, remove and sign out on a computer", () => {
  it("add checks only what the server can check — the CLI, the name, the computer and its switch (asked again, not cached), a name or case-variant already there — and creates nothing", async () => {
    const f = fixture();
    expect(await f.accounts.add("codex", "x", ID, "me")).toEqual({ ok: false, error: "unsupported" });
    expect(await f.accounts.add("claude-code", "con", ID, "me")).toEqual({ ok: false, error: "name" });
    expect(await f.accounts.add("claude-code", "work", ID, "me")).toMatchObject({ ok: false, error: "exists" });
    expect(await f.accounts.add("claude-code", "WORK", ID, "me")).toMatchObject({ ok: false, error: "case_clash", clash: "work" });
    expect(await f.accounts.add("claude-code", "x", "00000000-0000-0000-0000-000000000000", "me")).toMatchObject({ ok: false, error: "machine_unknown" });
    f.calls.length = 0;
    expect(await f.accounts.add("claude-code", "fresh", ID, "me")).toEqual({ ok: true });
    expect(f.calls.map(c => c.operation)).toEqual(["accounts.switches"]);
    // Only checked: the folder is made when the first sign-in starts, so the fleet log must not say a dialog that was closed after this "added" anything.
    expect(f.log.at(-1)).toEqual({ machine: ID, machineName: "Desk PC", profile: "fresh", by: "me", action: "add_checked", outcome: "ok" });
    expect(f.log.some(entry => (entry as any).action === "added" && (entry as any).outcome === "ok")).toBe(false);
    f.state.switchOn = false; expect(await f.accounts.add("claude-code", "fresh2", ID, "me")).toEqual({ ok: false, error: "machine_accounts_off" });
  });
  it("a refusal before anything is sent: offline, an older Runtime, switch off, unreadable", async () => {
    const off = fixture({ machine: { status: "offline" } }); expect(await off.accounts.add("claude-code", "a", ID, "me")).toEqual({ ok: false, error: "machine_offline" });
    const old = fixture({ machine: { runtimeInfo: { protocolVersions: [1], capabilities: ["exec"] } } }); expect(await old.accounts.add("claude-code", "a", ID, "me")).toEqual({ ok: false, error: "machine_unsupported" });
    const un = fixture({ switchOn: "error" }); expect(await un.accounts.add("claude-code", "a", ID, "me")).toEqual({ ok: false, error: "machine_unreachable" });
    expect(old.calls).toEqual([]); expect(off.calls).toEqual([]);
  });
  it("remove: the typed name, a profile the computer reported, one its Runtime created, nobody using it, no sign-in for it — then only {cli, profile, actor} is sent", async () => {
    const f = fixture({ agents: [{ name: "w1", profile: "Work" }], machine: { inventory: { ...runtimeMachine().inventory!, credentialProfiles: { profiles: [{ name: "work", loggedIn: true, created: true }, { name: "spare", loggedIn: false, created: true }, { name: "by-hand", loggedIn: false, created: false }], default: "work" } } } });
    expect(await f.accounts.remove("claude-code", "spare", "other", ID, ME, "me")).toEqual({ ok: false, error: "confirm" });
    expect(await f.accounts.remove("claude-code", "ghost", "ghost", ID, ME, "me")).toMatchObject({ ok: false, error: "missing" });
    expect(await f.accounts.remove("claude-code", "by-hand", "by-hand", ID, ME, "me")).toMatchObject({ ok: false, error: "machine_profile_not_owned" });
    // In use: an agent there (the case does not matter on Windows), and the computer's own default.
    expect(await f.accounts.remove("claude-code", "work", "work", ID, ME, "me")).toEqual({ ok: false, error: "in_use", users: { agents: ["w1"], classic: [], fleetDefault: true } });
    expect(f.calls.some(c => c.operation === "accounts.remove")).toBe(false);
    expect(await f.accounts.remove("claude-code", "spare", "spare", ID, ME, "me")).toEqual({ ok: true });
    expect(f.calls.find(c => c.operation === "accounts.remove")).toMatchObject({ payload: { cli: "claude-code", profile: "spare", actor: ME.actor } });
    expect(Object.keys((f.calls.find(c => c.operation === "accounts.remove")!.payload as object)).sort()).toEqual(["actor", "cli", "profile"]);
  });
  it("remove and sign out are refused while a sign-in for that profile runs on that computer", async () => {
    const g = fixture({ signingIn: true, machine: { inventory: { ...runtimeMachine().inventory!, credentialProfiles: { profiles: [{ name: "spare", loggedIn: true, created: true }] } } } });
    expect(await g.accounts.remove("claude-code", "spare", "spare", ID, ME, "me")).toEqual({ ok: false, error: "signing_in" });
    expect(await g.accounts.signOut("claude-code", "spare", true, ID, ME, "me")).toEqual({ ok: false, error: "signing_in" });
    expect(g.calls.some(c => /^accounts\.(remove|signout)$/.test(c.operation))).toBe(false);
  });
  it("sign out: never the Windows user's own sign-in (profile null), a typed confirmation, a created profile; the computer runs the CLI's own logout", async () => {
    const f = fixture();
    expect(await f.accounts.signOut("claude-code", null, true, ID, ME, "me")).toEqual({ ok: false, error: "machine_default_login" });
    expect(await f.accounts.signOut("claude-code", "work", "yes", ID, ME, "me")).toEqual({ ok: false, error: "confirm" });
    expect(await f.accounts.signOut("claude-code", "by-hand", true, ID, ME, "me")).toMatchObject({ ok: false, error: "machine_profile_not_owned" });
    expect(await f.accounts.signOut("codex", "work", true, ID, ME, "me")).toEqual({ ok: false, error: "unsupported" });
    expect(await f.accounts.signOut("claude-code", "work", true, ID, ME, "me")).toEqual({ ok: true });
    expect(f.calls.find(c => c.operation === "accounts.signout")).toMatchObject({ payload: { cli: "claude-code", profile: "work", actor: ME.actor }, timeoutMs: 120_000 });
  });
  it("the computer's own refusal is relayed as its sentence — bounded, with no control characters — and logged by name and reason only", async () => {
    const f = fixture(); f.state.refuse = `Credential profile "work" is in use by a running task on this computer; stop it first\u0007\u001b[31m${"x".repeat(900)}`;
    const r: any = await f.accounts.signOut("claude-code", "work", true, ID, ME, "me");
    expect(r).toMatchObject({ ok: false, error: "machine_refused" }); expect(r.message).toMatch(/^Credential profile "work" is in use by a running task/); expect(r.message.length).toBeLessThanOrEqual(400); expect(r.message).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(f.log.at(-1)).toEqual({ machine: ID, machineName: "Desk PC", profile: "work", by: "me", action: "signed_out", outcome: "refused", reason: "machine_refused" });
    f.state.refuse = undefined; await f.accounts.signOut("claude-code", "work", true, ID, ME, "me");
    expect(f.log.at(-1)).toEqual({ machine: ID, machineName: "Desk PC", profile: "work", by: "me", action: "signed_out", outcome: "ok" });
    // Nothing a log line carries can be a URL, a code, an e-mail or a path.
    expect(JSON.stringify(f.log)).not.toMatch(/https?:|@|[A-Z]:\\/);
  });
});

describe("machineAgents", () => {
  it("lists the agents that run on one computer with Claude Code and the profile each names", () => {
    const instances = { a: { runtime: "windows", machine_id: ID, backend: "claude-code" }, b: { runtime: "windows", machine_id: "other", backend: "claude-code" }, c: { backend: "claude-code" }, d: { runtime: "windows", machine_id: ID, backend: "codex" }, e: { runtime: "windows", machine_id: ID } };
    expect(machineAgents(instances, ID, name => (name === "a" ? "work" : null))).toEqual([{ name: "a", profile: "work" }, { name: "e", profile: null }]);
    expect(machineAgents(undefined, ID, () => null)).toEqual([]);
  });
});

describe("the view right after a sign-out or remove (the inventory may not have arrived yet)", () => {
  const signedIn = (name: string) => ({ name, loggedIn: true as const, created: true, identity: { maskedEmail: "ab***@example.com", plan: "max" as const } });
  it("a removed profile is gone and a signed-out one is signed out at once, from the answer; the next inventory is the truth again", async () => {
    const f = runtimeRig({ created: ["spare", "work"] });
    f.report([{ name: "spare", loggedIn: false, created: true }, signedIn("work")]);
    const profiles = async () => (await f.accounts.list())[0]!.profiles.map(p => [p.name, p.loggedIn, p.identity ? "identity" : "-", p.created]);
    expect(await profiles()).toEqual([["spare", false, "-", true], ["work", true, "identity", true]]);
    // The Runtime of this rig answers without sending its inventory (as one that answers first would): nothing in the machine's inventory has moved.
    expect(await f.accounts.signOut("claude-code", "work", true, RIG_ID, f.who, "me")).toEqual({ ok: true });
    expect(f.accounts.profileState(RIG_ID, "work")).toEqual({ exists: true, state: "invalid", created: true });
    expect(await profiles()).toEqual([["spare", false, "-", true], ["work", false, "-", true]]);             // signed out, and no account left on the row
    expect(await f.accounts.remove("claude-code", "spare", "spare", RIG_ID, f.who, "me")).toEqual({ ok: true });
    expect(f.accounts.profileState(RIG_ID, "spare")).toEqual({ exists: false, state: "unknown", created: false });
    expect(await profiles()).toEqual([["work", false, "-", true]]);
    // A second Remove of what was just removed is `missing`, not a request to the computer.
    f.sent.length = 0; f.tick(10_000);
    expect(await f.accounts.remove("claude-code", "spare", "spare", RIG_ID, f.who, "me")).toMatchObject({ ok: false, error: "missing" });
    expect(f.sent.some(s => s.operation === "accounts.remove")).toBe(false);
    // The computer's next inventory arrives: it is the truth, whatever it says (here: the profile is back, and signed in again).
    f.report([{ name: "spare", loggedIn: false, created: true }, signedIn("work")]);
    expect(await profiles()).toEqual([["spare", false, "-", true], ["work", true, "identity", true]]);
    expect(f.accounts.profileState(RIG_ID, "spare").exists).toBe(true);
    expect(f.accounts.profileState(RIG_ID, "work").state).toBe("valid");
    await f.stop();
  });
  it("what one operation changed does not outlive that computer's next inventory, and a case variant of the name is the same profile", async () => {
    const f = runtimeRig({ created: ["Work"] }); f.report([signedIn("Work")]);
    expect(await f.accounts.signOut("claude-code", "Work", true, RIG_ID, f.who, "me")).toEqual({ ok: true });
    expect(f.accounts.profileState(RIG_ID, "WORK").state).toBe("invalid");
    f.report([signedIn("Work")]);                                                                             // signed in again by someone at that computer
    expect(f.accounts.profileState(RIG_ID, "work").state).toBe("valid");
    await f.stop();
  });
  it("a Runtime that does send its inventory before the answer needs none of this: the view is the inventory", async () => {
    const f = runtimeRig({ created: ["spare"], changed: async () => { f.report([]); } });                   // the Runtime sent the new (empty) inventory, then answered
    expect(await f.accounts.remove("claude-code", "spare", "spare", RIG_ID, f.who, "me")).toEqual({ ok: true });
    expect((await f.accounts.list())[0]!.profiles).toEqual([]);
    expect(f.accounts.profileState(RIG_ID, "spare").exists).toBe(false);
    await f.stop();
  });
});

describe("a computer's failure is one fixed sentence: no path, account or output travels in the message (the real Runtime side)", () => {
  const SECRET = "EACCES: C:\\Users\\alice\\.agend-runtime\\secret alice@example.com";
  const GENERIC = "The operation could not be completed on this computer. Check that computer's Runtime window.";
  const leaks = (r: any) => { expect(JSON.stringify(r)).not.toMatch(/alice|EACCES|C:|\\|secret|example\.com/); };
  it("sign out: a logout that throws an ordinary error with a path and an e-mail is answered with the generic sentence", async () => {
    const f = runtimeRig({ created: ["work"], runLogout: async () => { throw new Error(SECRET); } });
    const r: any = await f.accounts.signOut("claude-code", "work", true, RIG_ID, f.who, "me");
    expect(r).toEqual({ ok: false, error: "machine_refused", message: GENERIC }); leaks(r);
    expect(JSON.stringify(f.logs)).not.toMatch(/alice|EACCES|C:|secret/);
    await f.stop();
  });
  it("remove: a failure inside the Runtime's own deletion is the same generic sentence", async () => {
    const f = runtimeRig({ created: ["spare"], ownership: { afterChecks: () => { throw new Error(SECRET); } } });
    const r: any = await f.accounts.remove("claude-code", "spare", "spare", RIG_ID, f.who, "me");
    expect(r).toEqual({ ok: false, error: "machine_refused", message: GENERIC }); leaks(r);
    await f.stop();
  });
  it("the Runtime's own refusal sentences (ours: a name and a command, no path) still come through, so the person is told what to do", async () => {
    const f = runtimeRig({ created: ["spare"], defaultProfile: () => "spare" });                              // only the Runtime knows its default; the server's view does not say
    const r: any = await f.accounts.remove("claude-code", "spare", "spare", RIG_ID, f.who, "me");
    expect(r).toMatchObject({ ok: false, error: "machine_refused" });
    expect(r.message).toBe('Credential profile "spare" is this computer\'s default for agents; change it there first: agend-runtime profile default NAME');
    expect(f.accounts.profileState(RIG_ID, "spare").exists).toBe(true);                                       // a refused remove changes nothing the view shows
    await f.stop();
  });
});
