/**
 * #3190 Part 3c test rig: the REAL Runtime side of the account operations (`RemoteAccounts`, 3a) with a fake CLI process, and the server's side (`MachineAccounts`,
 * `MachineSignIns`) calling it as a function in place of a socket — the closed payload check of the coordinator's `callAccount` included. Fixtures only (example.com).
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { vi } from "vitest";
import { RemoteAccounts, type RemoteAccountsDeps, type RemoteStatusAnswer } from "../../src/runtime-remote-accounts.js";
import { credentialProfilesRoot, type CredentialProfileStatus } from "../../src/runtime-credential-profiles.js";
import { createRuntimeProfile } from "../../src/runtime-profile-ownership.js";
import { setRemoteSwitch } from "../../src/runtime-remote-setup.js";
import { parseRuntimeRemotePayload, type RuntimeMachine } from "../../src/runtime-protocol.js";
import { MachineSignIns, type MachineSignInDeps } from "../../src/machine-signins.js";
import { MachineAccounts } from "../../src/machine-accounts.js";
import type { AccountCaller } from "../../src/runtime-signin-transport.js";

export const ID = "11111111-2222-3333-4444-555555555555";
export const URL_OK = "https://claude.com/cai/oauth/authorize?code=true&client_id=fixture&response_type=code&state=STATE-NEVER-LOGGED";
export const CODE = "SECRETCODE123-abc";
export const EMAIL = "ada.lovelace@example.com";
export const ACTOR = "admin:0123456789abcdef";
const directories: string[] = [];
export const scratch = (): string => { const path = mkdtempSync(join(tmpdir(), "agend-machine-signin-")); directories.push(path); return path; };
/** Call from the test file's `afterEach`. */
export function cleanScratch(): void { for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); } }

export class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); pid = 77; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; killed = false; written = "";
  constructor() { super(); this.stdin.on("data", chunk => { this.written += chunk.toString(); }); }
  say(text: string): void { this.stdout.write(text); }
  end(code: number): void { this.exitCode = code; this.emit("close", code); }
  kill(): boolean { this.killed = true; queueMicrotask(() => { if (this.exitCode === null) this.end(1); }); return true; }
}

export interface RigOptions {
  switchOn?: boolean; created?: string[]; unreachable?: () => boolean;
  /** Held at the start of each call to the computer (a test that needs two requests to overlap). */
  gate?: (operation: string) => Promise<void> | void;
  /** The CLI's logout, and the Runtime's own ownership hooks (a test that makes a callback throw). */
  runLogout?: RemoteAccountsDeps["runLogout"]; ownership?: RemoteAccountsDeps["ownership"];
  /** The pairing's default profile as only the Runtime knows it (the inventory a test reports may not say). */
  defaultProfile?: () => string | undefined;
  /** What the Runtime does when an operation changed its inventory (default: nothing is sent, as a Runtime that answers first). */
  changed?: RemoteAccountsDeps["changed"];
}
export function runtimeRig(options: RigOptions = {}) {
  const pairing = scratch(), root = credentialProfilesRoot(pairing), children: FakeChild[] = [], spawned: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = [];
  for (const name of options.created ?? []) createRuntimeProfile(root, "claude-code", name);
  let answer: RemoteStatusAnswer = { loggedIn: false };
  let clock = Date.now();                                      // the Runtime's clock: it paces sign-in starts (5 s apart), so a test moves it
  const deps: RemoteAccountsDeps = { pairingDirectory: pairing, credentialRoot: root, now: () => clock, status: async () => answer, find: async () => ({ path: "claude.exe", command: "claude.exe", args: [] }), environment: () => ({ PATH: "p" }),
    runLogout: options.runLogout ?? (async () => 0), inUse: () => undefined, inUseNow: () => undefined, defaultProfile: options.defaultProfile ?? (() => undefined), changed: options.changed ?? vi.fn(),
    ...(options.ownership ? { ownership: options.ownership } : {}),
    signIn: { scratchRoot: scratch(), spawn: (_c, args, spawnOptions) => { spawned.push({ args, env: spawnOptions.env }); const child = new FakeChild(); children.push(child); queueMicrotask(() => { child.say(`If the browser didn't open, visit: ${URL_OK}\nPaste code here if prompted > `); }); return child as unknown as ChildProcess; } } };
  const runtime = new RemoteAccounts(deps);
  if (options.switchOn !== false) setRemoteSwitch(pairing, "accounts", true, undefined, clock);
  const sent: Array<{ operation: string; payload: any }> = [];
  const replies: unknown[] = [];
  const call: AccountCaller = async (_id, operation, payload) => {
    if (options.unreachable?.()) throw new Error("Runtime machine is offline");
    await options.gate?.(operation);
    sent.push({ operation, payload: structuredClone(payload) });
    const input = parseRuntimeRemotePayload(operation, payload);      // the coordinator's own closed check
    const result = await runtime.handle(operation, input);
    replies.push(structuredClone(result)); return result;
  };
  // What the computer last reported (the inventory the coordinator holds): a test moves it with `report`, as a new `inventory` frame does.
  const inventory = { profiles: (options.created ?? []).map(name => ({ name, loggedIn: false, created: true })) as CredentialProfileStatus[], at: 1000 };
  const report = (profiles: CredentialProfileStatus[]): void => { inventory.profiles = structuredClone(profiles); inventory.at += 1; };
  const machine = (): RuntimeMachine => ({ id: ID, name: "Desk PC", platform: "win32", status: "online", createdAt: 1, generation: 1, runtimeInfo: { protocolVersions: [1], capabilities: ["exec", "remote-signin"] },
    inventoryUpdatedAt: inventory.at, inventory: { clis: [], home: "", probedAt: null, credentialProfiles: { profiles: structuredClone(inventory.profiles) } } } as RuntimeMachine);
  const logs: Array<Record<string, unknown>> = [];
  const accounts = new MachineAccounts({ call, machine: id => (id === ID ? machine() : undefined), machines: () => [machine()], agents: () => [], signingIn: () => false, log: entry => { logs.push({ ...entry }); } });
  const events: Array<Record<string, unknown>> = [];
  let live = true;
  const owner = {};
  const signIns = new MachineSignIns({ call, current: who => live && who === owner, reported: (id, profile) => accounts.profileState(id, profile), readiness: id => accounts.readiness(id), actor: () => ACTOR,
    changed: (event, who, launched) => { events.push({ ...event, launched, mine: who === owner }); } } satisfies MachineSignInDeps);
  const target = (profile: string) => ({ machine: ID, profile });
  const view = (profile: string) => signIns.snapshot(owner, target(profile)).login;
  const phase = (profile: string) => signIns.snapshot(owner, target(profile)).login?.phase;
  const who = { id: ID, actor: ACTOR };
  return { runtime, signIns, accounts, owner, who, pairing, root, children, spawned, sent, replies, events, logs, call, target, view, phase, report, inventory,
    answer: (value: RemoteStatusAnswer) => { answer = value; }, tick: (ms: number) => { clock += ms; }, end: () => { live = false; },
    stop: async () => { await signIns.close(); await runtime.stop().catch(() => {}); } };
}
export type Rig = ReturnType<typeof runtimeRig>;
export const waitFor = (fn: () => void) => vi.waitFor(fn, { timeout: 6000, interval: 25 });
