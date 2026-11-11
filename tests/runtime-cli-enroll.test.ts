import * as fixturePrivacyFs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeClientStore as Store } from "../src/runtime-client-store.js";

const world = vi.hoisted(() => ({ pair: vi.fn(), enroll: vi.fn(), started: vi.fn(), boot: "b".repeat(64) }));
vi.mock("../src/runtime-pane-boot.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/runtime-pane-boot.js")>(), readPaneSystemBootId: async () => world.boot }));
vi.mock("../src/runtime-client.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/runtime-client.js")>(),
  pairRuntime: world.pair, enrollRuntime: world.enroll, rotateRuntimeCredentials: vi.fn(),
  RuntimeClient: class { constructor(options: { store: Store }) { world.started(options.store.directory); } async start() {} async stop() {} async waitUntilStopped() {} },
}));
vi.mock("node:readline/promises", () => ({ createInterface: () => ({ question: async () => "ABCD-EFGH", close() {} }) }));

import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { runtimeMain } from "../src/runtime-cli.js";
import { runtimeServerProfile, RUNTIME_SERVER_FILE } from "../src/runtime-connection.js";
import { generateEnrollToken } from "../src/runtime-enrollment.js";

/**
 * `connect --enroll-stdin --server-fingerprint …`. The token comes in on standard input only (never an argument, never the environment, never the
 * keyboard), is never kept, works without a console (an AI agent, CI), and a computer that is already connected just reconnects without using it.
 */
const A = "https://fleet.example.test:10443", B = "https://preview.example.test:10445", FP = "ab".repeat(32);
const roots: string[] = [], platform = Object.getOwnPropertyDescriptor(process, "platform")!;
function fixture() { const root = mkdtempSync(join(tmpdir(), "agend-runtime-cli-enroll-")); roots.push(root); const home = join(root, "home"), program = join(root, "zip"); mkdirSync(home); mkdirSync(program); return { home, program, base: join(home, ".agend-runtime") }; }
const pipe = (text: string): Readable & { isTTY?: boolean } => Readable.from([text]);
function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true }); Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}
let output = "";
beforeEach(() => {
  world.boot = "b".repeat(64); world.pair.mockReset(); world.enroll.mockReset(); world.started.mockReset(); output = "";
  world.enroll.mockImplementation(async (options: { server: string; store: Store; name: string }) => {
    options.store.saveCredentials({ server: options.server, machineId: "99999999-2222-4333-8444-555555555555", credential: "b".repeat(64), name: options.name });
  });
  Object.defineProperty(process, "platform", { value: "win32" }); setTty(false);          // no console at all: an AI agent or CI
  vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform); vi.restoreAllMocks();
  for (const root of roots.splice(0)) { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe test path"); rmSync(root, { recursive: true, force: true }); }
});

describe("connect --enroll-stdin", () => {
  it("joins with the token from standard input, with no console and no pairing code, then runs", async () => {
    const { home, program } = fixture(), token = generateEnrollToken();
    writeFileSync(join(program, RUNTIME_SERVER_FILE), JSON.stringify({ server: B }));
    await runtimeMain(["connect", "--foreground", "--enroll-stdin", "--server-fingerprint", FP], { home, programDirectory: program, env: {}, stdin: pipe(token + "\r\n") });
    expect(world.pair).not.toHaveBeenCalled(); expect(world.enroll).toHaveBeenCalledTimes(1);
    const call = world.enroll.mock.calls[0][0] as { server: string; token: string; fingerprint: string; store: Store };
    expect(call).toMatchObject({ server: B, token, fingerprint: FP }); expect(call.store.directory).toBe(join(home, ".agend-runtime"));
    expect(world.started).toHaveBeenCalledWith(call.store.directory);                         // and then it connects and runs
    expect(output).not.toContain(token);
  });
  it("takes the address from --server too, and trims a byte-order mark and the line ending PowerShell adds", async () => {
    const { home, program } = fixture(), token = generateEnrollToken();
    await runtimeMain(["connect", "--foreground", "--server", A, "--enroll-stdin", "--server-fingerprint", FP], { home, programDirectory: program, env: {}, stdin: pipe("﻿" + token + "\n") });
    expect(world.enroll.mock.calls[0][0]).toMatchObject({ server: A, token });
  });
  it("never asks for a pairing code and never needs a terminal", async () => {
    const { home, program } = fixture(); setTty(false);
    await runtimeMain(["connect", "--foreground", "--server", A, "--enroll-stdin", "--server-fingerprint", FP], { home, programDirectory: program, env: {}, stdin: pipe(generateEnrollToken()) });
    expect(world.pair).not.toHaveBeenCalled(); expect(world.started).toHaveBeenCalledTimes(1);
  });
  it("reconnects an already-connected profile without reading or using the token", async () => {
    const { home, program, base } = fixture(), reads = vi.fn();
    new RuntimeClientStore(base).saveCredentials({ server: A, machineId: "11111111-2222-4333-8444-555555555555", credential: "a".repeat(64), name: "Old PC" });
    const before = readFileSync(join(base, "connection.json"), "utf8");
    const stdin = { isTTY: false, [Symbol.asyncIterator]() { reads(); return { next: async () => ({ done: true as const, value: undefined }) }; } };
    await runtimeMain(["connect", "--foreground", "--server", A, "--enroll-stdin", "--server-fingerprint", FP], { home, programDirectory: program, env: {}, stdin });
    expect(world.enroll).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled(); expect(world.started).toHaveBeenCalledWith(base);
    expect(readFileSync(join(base, "connection.json"), "utf8")).toBe(before);
    expect(output).toMatch(/already connected to this AgEnD.*token was not used/s);
  });
  it("opens a separate profile for another AgEnD and leaves the existing pairing alone", async () => {
    const { home, program, base } = fixture();
    new RuntimeClientStore(base).saveCredentials({ server: A, machineId: "11111111-2222-4333-8444-555555555555", credential: "a".repeat(64), name: "Old PC" });
    const before = readFileSync(join(base, "connection.json"), "utf8");
    writeFileSync(join(program, RUNTIME_SERVER_FILE), JSON.stringify({ server: B }));
    await runtimeMain(["connect", "--foreground", "--enroll-stdin", "--server-fingerprint", FP], { home, programDirectory: program, env: {}, stdin: pipe(generateEnrollToken()) });
    const own = runtimeServerProfile(base, B);
    expect((world.enroll.mock.calls[0][0] as { store: Store }).store.directory).toBe(own); expect(world.started).toHaveBeenCalledWith(own);
    expect(readFileSync(join(base, "connection.json"), "utf8")).toBe(before);
  });
  it("refuses a token typed at the keyboard: standard input must be a pipe", async () => {
    const { home, program } = fixture(), keyboard = Object.assign(pipe(generateEnrollToken()), { isTTY: true });
    await expect(runtimeMain(["connect", "--foreground", "--server", A, "--enroll-stdin", "--server-fingerprint", FP], { home, programDirectory: program, env: {}, stdin: keyboard })).rejects.toThrow(/not from the keyboard/);
    expect(world.enroll).not.toHaveBeenCalled(); expect(world.started).not.toHaveBeenCalled();
  });
  it("refuses a malformed, empty or oversized token with the next step, without echoing what was read", async () => {
    for (const text of ["", "agend_enroll_short", "not a token at all", "agend_enroll_" + "!".repeat(43), "x".repeat(2000)]) {
      const { home, program } = fixture();
      const error = await runtimeMain(["connect", "--foreground", "--server", A, "--enroll-stdin", "--server-fingerprint", FP], { home, programDirectory: program, env: {}, stdin: pipe(text) }).then(() => null, (e: Error) => e);
      expect(error?.message).toMatch(/not valid for this AgEnD.*generate a new install command/s);
      if (text.length > 3) expect(error?.message).not.toContain(text.slice(0, 12));
    }
    expect(world.enroll).not.toHaveBeenCalled(); expect(world.started).not.toHaveBeenCalled();
  });
  it("passes a refusal from AgEnD on (expired, used, revoked) as a failure with that message, and starts nothing", async () => {
    const { home, program } = fixture(); world.enroll.mockRejectedValueOnce(new Error("This install command's one-time token has expired (it lasts 15 minutes). Open AgEnD Settings."));
    await expect(runtimeMain(["connect", "--foreground", "--server", A, "--enroll-stdin", "--server-fingerprint", FP], { home, programDirectory: program, env: {}, stdin: pipe(generateEnrollToken()) })).rejects.toThrow(/has expired/);
    expect(world.started).not.toHaveBeenCalled();
  });
  it("needs both flags together, a well-formed fingerprint, and only on connect", async () => {
    const { home, program } = fixture(), token = generateEnrollToken(), call = (args: string[]) => runtimeMain(args, { home, programDirectory: program, env: {}, stdin: pipe(token) });
    await expect(call(["connect", "--server", A, "--enroll-stdin"])).rejects.toThrow(/go together/);
    await expect(call(["connect", "--server", A, "--server-fingerprint", FP])).rejects.toThrow(/go together/);
    await expect(call(["connect", "--server", A, "--enroll-stdin", "--server-fingerprint", "nope"])).rejects.toThrow(/64 hexadecimal/);
    await expect(call(["run", "--server-fingerprint", FP])).rejects.toThrow(/used only by connect/);
    await expect(call(["run", "--enroll-stdin"])).rejects.toThrow(/Invalid runtime arguments/);
    await expect(call(["connect", "--server", A, "--enroll-stdin", "--enroll-stdin", "--server-fingerprint", FP])).rejects.toThrow(/Invalid runtime arguments/);
    expect(world.enroll).not.toHaveBeenCalled();
  });
  it("still refuses a pairing code or a token anywhere in the arguments", async () => {
    const { home, program } = fixture(), token = generateEnrollToken();
    for (const args of [["connect", "--server", A, "--code", "ABCD-EFGH"], ["connect", "--server", A, "--token", token], ["connect", "--server", A, "--enroll", token]])
      await expect(runtimeMain(args, { home, programDirectory: program, env: {}, stdin: pipe(token) })).rejects.toThrow(/never in command arguments/);
    expect(world.enroll).not.toHaveBeenCalled();
  });
  it("does not read the token from the environment", async () => {
    const { home, program } = fixture(), token = generateEnrollToken();
    await expect(runtimeMain(["connect", "--foreground", "--server", A, "--enroll-stdin", "--server-fingerprint", FP], { home, programDirectory: program, env: { AGEND_ENROLL_TOKEN: token, AGEND_ENROLL: token }, stdin: pipe("") })).rejects.toThrow(/not valid/);
    expect(world.enroll).not.toHaveBeenCalled();
  });
  it("without the flags behaves exactly as before: a non-interactive terminal is refused a pairing code", async () => {
    const { home, program } = fixture();
    await expect(runtimeMain(["connect", "--foreground", "--server", A], { home, programDirectory: program, env: {} })).rejects.toThrow(/Pairing requires an interactive terminal/);
    expect(world.enroll).not.toHaveBeenCalled(); expect(world.pair).not.toHaveBeenCalled();
  });
  it("leaves the token in no file of the profile or the install", async () => {
    const { home, program, base } = fixture(), token = generateEnrollToken();
    writeFileSync(join(program, RUNTIME_SERVER_FILE), JSON.stringify({ server: B }));
    await runtimeMain(["connect", "--foreground", "--enroll-stdin", "--server-fingerprint", FP], { home, programDirectory: program, env: {}, stdin: pipe(token) });
    for (const dir of [home, program]) for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) if (entry.isFile()) expect(readFileSync(join(entry.parentPath, entry.name), "utf8")).not.toContain(token);
    expect(JSON.parse(readFileSync(join(program, RUNTIME_SERVER_FILE), "utf8"))).toEqual({ server: B });
    expect(existsSync(join(base, "connection.json"))).toBe(true);
  });
});

// This suite models an admitted NTFS boundary; dedicated privacy tests retain the real gate and refusal ordering.
vi.mock("../src/runtime-pane-private.js", async original => ({ ...await original<typeof import("../src/runtime-pane-private.js")>(), protectRuntimeProfileDirectorySync(directory: string) {
  const fs = fixturePrivacyFs;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Unsafe profile fixture");
} }));
