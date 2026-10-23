/**
 * #2481 (design approved on the issue): a Mac whose 2.3.x crash-loops under launchd after an upgrade from 2.2.x restores
 * the 2.2.x package 2.2.x's updater kept — automatically, once, guarded, logged, with the notice saying so.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoRestoreDue, claimRestore, maybeAutoRestore, preimageRuns, pruneFailedTrees, readRestoreRecord, restoreCandidate,
  swapInPreimage, versionOlder, type RestoreCandidate, type SwapFs,
} from "../src/mac-auto-restore.js";
import { ATTEMPTS_FILE, claimChatNotice, notifyRestore, notifyRestoreFailed, readAttempts, readStartedHistory } from "../src/start-failure.js";
import { restoreFailedNoticeText, restoreNoticeText } from "../src/start-failure-chat.js";
import { recordFleetStartAttempt } from "../src/start-attempt.js";
import { setLocale } from "../src/locale.js";

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-2481r-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); setLocale("en"); });

const STAMP = "2026-10-23T05-00-00-000Z";
/** A prefix with an installed 2.3.1 and the 2.2.6 copy 2.2.6's updater kept. */
function host(opts: { keptVersion?: string; manifestVersion?: string; name?: string; noNode?: boolean; arch?: string } = {}) {
  const prefix = scratch();
  const root = join(prefix, "lib", "node_modules", "@songsid", "agend");
  const write = (pkg: string, version: string, name = "@songsid/agend", node = true) => {
    mkdirSync(join(pkg, "dist"), { recursive: true });
    mkdirSync(join(pkg, "launcher"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version }));
    writeFileSync(join(pkg, "dist", "cli.js"), `// ${version}`);
    writeFileSync(join(pkg, "launcher", "agend"), "#!/bin/sh");
    if (node) {
      mkdirSync(join(pkg, "node_modules", "@songsid", `agend-node-darwin-${opts.arch ?? "arm64"}`, "bin"), { recursive: true });
      writeFileSync(join(pkg, "node_modules", "@songsid", `agend-node-darwin-${opts.arch ?? "arm64"}`, "bin", "node"), "node");
    }
  };
  write(root, "2.3.1");
  mkdirSync(join(root, "launcher"), { recursive: true });
  writeFileSync(join(root, "launcher", "agend-install.cjs"), "install");
  const kept = opts.keptVersion ?? "2.2.6";
  const keptDir = join(prefix, ".agend-rollback", `${kept}-${STAMP}`);
  write(join(keptDir, "agend"), opts.manifestVersion ?? kept, opts.name, !opts.noNode);
  mkdirSync(join(prefix, "bin"), { recursive: true });
  symlinkSync("../lib/node_modules/@songsid/agend/launcher/agend", join(prefix, "bin", "agend"));
  symlinkSync("../lib/node_modules/@songsid/agend/launcher/agend-install.cjs", join(prefix, "bin", "agend-install"));
  return { prefix, root, keptDir };
}
const versionOk = (v: string) => () => ({ status: 0, stdout: `${v}\n` });

describe("#2481 auto-restore: when it is due", () => {
  const base = { platform: "darwin" as const, env: { XPC_SERVICE_NAME: "com.agend.fleet" }, ppid: 1, plistExists: true, installed: "2.3.1", startedHistory: [] as string[] | "unreadable", recentAttempts: 3 };
  it("the launchd job's 3rd attempt of a version that never ran here", () => {
    expect(autoRestoreDue(base)).toBe(true);
  });
  it.each([
    ["not macOS", { platform: "linux" as const }],
    ["a person's `fleet start` (no launchd job)", { env: {} }],
    ["another launchd job", { env: { XPC_SERVICE_NAME: "com.other" } }],
    ["a `fleet start` typed in a pane the job started (it inherits XPC_SERVICE_NAME, launchd is not its parent)", { ppid: 4242 }],
    ["fleet-started.json is there but unreadable", { startedHistory: "unreadable" as const }],
    ["no AgEnD plist", { plistExists: false }],
    ["the version ran here before", { startedHistory: ["2.3.1", "2.2.6"] }],
    ["only the 2nd attempt", { recentAttempts: 2 }],
  ])("never: %s", (_n, change) => {
    expect(autoRestoreDue({ ...base, ...change })).toBe(false);
  });
  it("version order", () => {
    expect(versionOlder("2.2.6", "2.3.1")).toBe(true);
    expect(versionOlder("2.2.6", "2.3.0-beta.27")).toBe(true);
    expect(versionOlder("2.3.0-beta.27", "2.3.0")).toBe(true);
    expect(versionOlder("2.3.1", "2.3.1")).toBe(false);
    expect(versionOlder("2.4.0", "2.3.1")).toBe(false);
    expect(versionOlder("x", "2.3.1")).toBe(false);
  });
});

describe("#2481 auto-restore: the kept copy, verified", () => {
  it("the newest kept 2.2.x, named and versioned as it says, with its files and bundled Node", () => {
    const h = host();
    expect(restoreCandidate(h.prefix, "2.3.1", "arm64")).toEqual({
      version: "2.2.6", dir: h.keptDir, pkg: join(h.keptDir, "agend"),
      node: join(h.keptDir, "agend", "node_modules", "@songsid", "agend-node-darwin-arm64", "bin", "node"),
    });
  });
  it.each([
    ["a version that does not match its directory", { manifestVersion: "2.2.5" }],
    ["another package", { name: "@evil/agend" }],
    ["a 2.3 copy (2.3 rolls back by itself)", { keptVersion: "2.3.0" }],
    ["a prerelease", { keptVersion: "2.2.6-beta.1" }],
    ["no bundled Node", { noNode: true }],
    ["a bundled Node for the other architecture", { arch: "x64" }],
  ])("refused: %s", (_n, opts) => {
    expect(restoreCandidate(host(opts).prefix, "2.3.1", "arm64")).toBeNull();
  });
  it("refused when the kept version is not older than the installed one, or there is no copy", () => {
    expect(restoreCandidate(host().prefix, "2.2.6", "arm64")).toBeNull();
    expect(restoreCandidate(scratch(), "2.3.1", "arm64")).toBeNull();
  });
  it("a `-failed` tree from an earlier restore is never a candidate", () => {
    const h = host();
    rmSync(h.keptDir, { recursive: true });
    mkdirSync(join(h.prefix, ".agend-rollback", `2.2.6-${STAMP}-failed`, "agend"), { recursive: true });
    expect(restoreCandidate(h.prefix, "2.3.1", "arm64")).toBeNull();
  });
  it("its own Node must run its cli.js --version and print exactly its version", () => {
    const cand = restoreCandidate(host().prefix, "2.3.1", "arm64")!;
    const run = vi.fn(versionOk("2.2.6"));
    expect(preimageRuns(cand, run)).toBe(true);
    expect(run).toHaveBeenCalledWith(cand.node, join(cand.pkg, "dist", "cli.js"), 10_000);
    expect(preimageRuns(cand, versionOk("2.2.5"))).toBe(false);
    expect(preimageRuns(cand, () => ({ status: 1, stdout: "2.2.6\n" }))).toBe(false);
    expect(preimageRuns(cand, () => ({ status: null, stdout: "" }))).toBe(false);   // timed out
    expect(preimageRuns(cand, () => { throw new Error("ENOENT"); })).toBe(false);
  });
});

describe("#2481 auto-restore: the swap", () => {
  it("installed tree aside, kept copy in; the dangling agend-install link goes, the agend link stays", () => {
    const h = host();
    const cand = restoreCandidate(h.prefix, "2.3.1", "arm64")!;
    const r = swapInPreimage(h.prefix, h.root, "2.3.1", cand, new Date("2026-10-23T06:00:00Z"));
    expect(r).toEqual({ ok: true, failedTree: join(h.prefix, ".agend-rollback", "2.3.1-2026-10-23T06-00-00-000Z-failed") });
    expect(JSON.parse(readFileSync(join(h.root, "package.json"), "utf8")).version).toBe("2.2.6");
    expect(JSON.parse(readFileSync(join(h.prefix, ".agend-rollback", "2.3.1-2026-10-23T06-00-00-000Z-failed", "package.json"), "utf8")).version).toBe("2.3.1");
    expect(existsSync(h.keptDir)).toBe(false);                                          // its emptied directory goes too
    expect(() => lstatSync(join(h.prefix, "bin", "agend-install"))).toThrow();     // the link itself is gone (existsSync follows it)
    expect(readlinkSync(join(h.prefix, "bin", "agend"))).toBe("../lib/node_modules/@songsid/agend/launcher/agend");
  });
  it("an agend-install link the restored package can still serve stays", () => {
    const h = host();
    writeFileSync(join(h.keptDir, "agend", "launcher", "agend-install.cjs"), "kept");
    const cand = restoreCandidate(h.prefix, "2.3.1", "arm64")!;
    expect(swapInPreimage(h.prefix, h.root, "2.3.1", cand, new Date("2026-10-23T06:00:00Z"))).toMatchObject({ ok: true });
    expect(readlinkSync(join(h.prefix, "bin", "agend-install"))).toBe("../lib/node_modules/@songsid/agend/launcher/agend-install.cjs");
  });
  it("a failure putting the copy in moves the installed tree back", () => {
    const h = host();
    const cand = restoreCandidate(h.prefix, "2.3.1", "arm64")!;
    const calls: string[] = [];
    const fs: SwapFs = {
      rename: (a, b) => { calls.push(`${a} -> ${b}`); if (a === cand.pkg) throw new Error("EXDEV"); },
      exists: () => true, unlink: () => {}, readlink: () => null, rmdir: () => {},
    };
    const r = swapInPreimage(h.prefix, h.root, "2.3.1", cand, new Date("2026-10-23T06:00:00Z"), fs);
    expect(r).toMatchObject({ ok: false, stranded: false, packageAt: h.root, reason: expect.stringContaining("the installed package was put back") });
    expect(calls).toHaveLength(3);
    expect(calls[2]).toBe(`${join(h.prefix, ".agend-rollback", "2.3.1-2026-10-23T06-00-00-000Z-failed")} -> ${h.root}`);
  });
  it("Fable r1 P2-3: when the rename back fails too, the reason says where the package is and how to put it back", () => {
    const h = host();
    const cand = restoreCandidate(h.prefix, "2.3.1", "arm64")!;
    let n = 0;
    const fs: SwapFs = { rename: () => { if (++n >= 2) throw new Error(n === 2 ? "EXDEV" : "EBUSY"); }, exists: () => true, unlink: () => {}, readlink: () => null, rmdir: () => {} };
    const failedTree = join(h.prefix, ".agend-rollback", "2.3.1-2026-10-23T06-00-00-000Z-failed");
    const r = swapInPreimage(h.prefix, h.root, "2.3.1", cand, new Date("2026-10-23T06:00:00Z"), fs);
    expect(r).toEqual({ ok: false, stranded: true, packageAt: failedTree,
      reason: `the kept copy could not be put in place (EXDEV), and the installed package could not be moved back (EBUSY): it is at ${failedTree}. To put it back: mv '${failedTree}' '${h.root}'` });
    expect((r as { reason: string }).reason).not.toContain("was put back");
  });
  it("one restore per version, ever", () => {
    const home = scratch();
    expect(claimRestore(home, "2.3.1")).toBe(true);
    expect(claimRestore(home, "2.3.1")).toBe(false);
    expect(claimRestore(home, "2.3.2")).toBe(true);
    expect(claimRestore(home, "../x")).toBe(false);
  });
});

describe("#2481 auto-restore: the whole act", () => {
  const due = (h: ReturnType<typeof host>, extra = {}) => {
    const plist = join(h.prefix, "fleet.plist"); writeFileSync(plist, "<plist/>");
    return { platform: "darwin" as const, env: { XPC_SERVICE_NAME: "com.agend.fleet" }, ppid: 1, plistPath: plist, arch: "arm64", runVersion: versionOk("2.2.6"), now: new Date("2026-10-23T06:00:00Z"), log: () => {}, ...extra };
  };
  it("restores once: the record, the notices before the swap (the installed package still in place), then the swap", () => {
    const h = host(); const home = scratch();
    const seen: string[] = [];
    const notify = vi.fn((from: string, to: string, preimage: string) => {
      seen.push(JSON.parse(readFileSync(join(h.root, "package.json"), "utf8")).version);
      expect([from, to, preimage]).toEqual(["2.3.1", "2.2.6", h.keptDir]);
    });
    const log = vi.fn();
    expect(maybeAutoRestore(home, h.root, h.prefix, "2.3.1", [], 3, due(h, { notify, log }))).toEqual({ kind: "restored", from: "2.3.1", to: "2.2.6", preimage: h.keptDir });
    expect(seen).toEqual(["2.3.1"]);
    expect(JSON.parse(readFileSync(join(h.root, "package.json"), "utf8")).version).toBe("2.2.6");
    expect(readRestoreRecord(home)).toMatchObject({ from: "2.3.1", to: "2.2.6", preimage: h.keptDir, attempts: 3, result: "restored",
      failedTree: join(h.prefix, ".agend-rollback", "2.3.1-2026-10-23T06-00-00-000Z-failed") });
    expect(log.mock.calls.map(c => c[0]).join("\n")).toMatch(/restoring v2\.2\.6 from .*\n.*restored v2\.2\.6; launchd starts it next/s);
    // never a second time for this version
    expect(maybeAutoRestore(home, h.root, h.prefix, "2.3.1", [], 4, due(h, { notify }))).toEqual({ kind: "not-due" });
  });
  it.each([
    ["a person's `fleet start`", { env: {} }],
    ["the kept copy does not run", { runVersion: versionOk("2.2.5") }],
    ["not macOS", { platform: "linux" as const }],
  ])("nothing moves: %s", (_n, change) => {
    const h = host(); const home = scratch();
    const notify = vi.fn();
    expect(maybeAutoRestore(home, h.root, h.prefix, "2.3.1", [], 3, due(h, { notify, ...change }))).toEqual({ kind: "not-due" });
    expect(notify).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(h.root, "package.json"), "utf8")).version).toBe("2.3.1");
    expect(readRestoreRecord(home)).toBeNull();
  });
  it("nothing moves for a version that ran here, on the 2nd attempt, or for a package outside the npm prefix", () => {
    const h = host(); const home = scratch();
    expect(maybeAutoRestore(home, h.root, h.prefix, "2.3.1", ["2.3.1"], 3, due(h))).toEqual({ kind: "not-due" });
    expect(maybeAutoRestore(home, h.root, h.prefix, "2.3.1", [], 2, due(h))).toEqual({ kind: "not-due" });
    expect(maybeAutoRestore(home, "/elsewhere/agend", h.prefix, "2.3.1", [], 3, due(h))).toEqual({ kind: "not-due" });
    expect(readRestoreRecord(home)).toBeNull();
  });
  it("Fable r1 P2-1: never past a 2.3.x that ran here — only the hop out of 2.2.x; older history is fine", () => {
    const h = host(); const home = scratch();
    const log = vi.fn();
    expect(maybeAutoRestore(home, h.root, h.prefix, "2.3.1", ["2.3.0"], 3, due(h, { log }))).toEqual({ kind: "not-due" });
    expect(log.mock.calls.flat().join("\n")).toMatch(/newer than the kept v2\.2\.6 has run here \(2\.3\.0\)/);
    expect(JSON.parse(readFileSync(join(h.root, "package.json"), "utf8")).version).toBe("2.3.1");
    expect(maybeAutoRestore(home, h.root, h.prefix, "2.3.1", ["2.2.6", "2.2.5"], 3, due(h))).toMatchObject({ kind: "restored" });
  });
  it("Fable r1: an unreadable fleet-started.json holds (logged), as unreadable evidence does elsewhere", () => {
    const h = host(); const home = scratch(); const log = vi.fn();
    expect(maybeAutoRestore(home, h.root, h.prefix, "2.3.1", "unreadable", 3, due(h, { log }))).toEqual({ kind: "not-due" });
    expect(log).toHaveBeenCalledWith("fleet-started.json cannot be read; not restoring");
    expect(readStartedHistory(home)).toEqual([]);
    writeFileSync(join(home, "fleet-started.json"), "{not json");
    expect(readStartedHistory(home)).toBe("unreadable");
    writeFileSync(join(home, "fleet-started.json"), JSON.stringify({ version: "2.3.0", at: "x", pid: 1, history: ["2.3.0", "2.2.6"] }));
    expect(readStartedHistory(home)).toEqual(["2.3.0", "2.2.6"]);
  });
  it("Fable r1 P2-3: a stranded package is recorded with where it is", () => {
    const h = host(); const home = scratch();
    let n = 0;
    const fs: SwapFs = { rename: () => { if (++n >= 2) throw new Error("EIO"); }, exists: () => true, unlink: () => {}, readlink: () => null, rmdir: () => {} };
    const out = maybeAutoRestore(home, h.root, h.prefix, "2.3.1", [], 3, due(h, { fs }));
    expect(out).toMatchObject({ kind: "failed", from: "2.3.1", to: "2.2.6", stranded: true });
    expect(readRestoreRecord(home)).toMatchObject({ result: "failed", failedTree: (out as { packageAt: string }).packageAt, reason: expect.stringContaining("To put it back: mv") });
  });
  it("a failed swap is recorded and reported, and never tried again", () => {
    const h = host(); const home = scratch();
    const fs: SwapFs = { rename: () => { throw new Error("EACCES"); }, exists: () => true, unlink: () => {}, readlink: () => null, rmdir: () => {} };
    expect(maybeAutoRestore(home, h.root, h.prefix, "2.3.1", [], 3, due(h, { fs }))).toMatchObject({ kind: "failed" });
    expect(readRestoreRecord(home)).toMatchObject({ result: "failed", reason: expect.stringContaining("EACCES") });
    expect(maybeAutoRestore(home, h.root, h.prefix, "2.3.1", [], 4, due(h))).toEqual({ kind: "not-due" });
  });
  it("Fable r1 P2-2: a failed restore sends the correction (once), from wherever the package is, and no plain notices", () => {
    const home = scratch(); const notify = vi.fn(); const notifyChat = vi.fn(); const restoreFailed = vi.fn(() => true);
    const failed = { kind: "failed" as const, from: "2.3.1", to: "2.2.6", reason: "EXDEV", packageAt: "/p/agend", stranded: false };
    expect(recordFleetStartAttempt(home, "2.3.1", 1_000, { lockHeld: () => false, notify, notifyChat, restore: () => failed, restoreFailed })).toEqual(failed);
    expect(restoreFailed).toHaveBeenCalledWith(home, "2.3.1", "2.2.6", "EXDEV", "/p/agend");
    expect(notify).not.toHaveBeenCalled(); expect(notifyChat).not.toHaveBeenCalled();
  });
  it("the correction itself: its own claim, the macOS notification, the chat script from where the package is now", () => {
    const home = scratch();
    const run = vi.fn((_cmd: string, _args: string[], _opts: { timeout: number }) => {});
    const launch = vi.fn((_cmd: string, _args: string[], _opts: unknown) => ({}));
    expect(notifyRestoreFailed(home, "2.3.1", "2.2.6", "EXDEV", "/p/x-failed", { run, launch, platform: "darwin" })).toBe(true);
    expect(run.mock.calls[0]![1]).toEqual(["/p/x-failed/dist/start-failure-chat.js", home, "--restore-failed", "2.3.1", "2.2.6", "EXDEV"]);
    expect(launch.mock.calls[0]![1]).toEqual(["-e", 'display notification "AgEnD v2.3.1 fails to start; restoring v2.2.6 automatically did not work. Run: agend doctor" with title "AgEnD"']);
    expect(notifyRestoreFailed(home, "2.3.1", "2.2.6", "EXDEV", "/p/x-failed", { run, launch, platform: "darwin" })).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    writeFileSync(join(home, ATTEMPTS_FILE), JSON.stringify({ version: "2.3.1", attempts: [new Date(1000).toISOString(), new Date(2000).toISOString(), new Date(3000).toISOString()] }));
    expect(restoreFailedNoticeText(home, readAttempts(home)!, 4000, "2.2.6", "EXDEV").split("\n")).toEqual([
      "⚠ AgEnD v2.3.1 fails to start (3 start attempts in the last 10 minutes, none completed). Restoring v2.2.6 automatically did not work: EXDEV",
      "To go back to v2.2.6: npm install -g @songsid/agend@2.2.6 && agend restart",
      `The error is at the end of ${join(home, "fleet.log")}. Please report it (agend doctor shows what to include): https://github.com/songsid/AgEnD/issues/new`,
    ]);
  });
  it("Fable r1 P3: a restored outcome exits before anything more of the moved package loads", () => {
    const src = readFileSync(join(process.cwd(), "src", "start-attempt.ts"), "utf8");
    const block = src.slice(src.indexOf('if (process.argv[2] === "fleet" && process.argv[3] === "start") {'));
    expect(block).toMatch(/restored = recordFleetStartAttempt\(getAgendHome\(\), version, Date\.now\(\)\)\?\.kind === "restored";[\s\S]*\n  if \(restored\) process\.exit\(1\);\n\}\s*$/);
    // start-attempt.ts imports nothing that loads the rest of the CLI
    expect([...src.matchAll(/^import .* from "\.\/([^"]+)";$/gm)].map(m => m[1]).sort()).toEqual(["fleet-lock.js", "mac-auto-restore.js", "paths.js", "start-failure.js"]);
  });
  it("a restore replaces the plain notices; otherwise they go as before", () => {
    const home = scratch();
    const notify = vi.fn(); const notifyChat = vi.fn();
    for (let i = 0; i < 3; i++) {
      recordFleetStartAttempt(home, "2.3.1", 1_000 + i, { lockHeld: () => false, notify, notifyChat, restore: () => ({ kind: "not-due" }) });
    }
    expect(notify).toHaveBeenCalledTimes(3); expect(notifyChat).toHaveBeenCalledTimes(3);
    const home2 = scratch(); notify.mockClear(); notifyChat.mockClear();
    const out = recordFleetStartAttempt(home2, "2.3.1", 1_000, { lockHeld: () => false, notify, notifyChat, restore: () => ({ kind: "restored", from: "2.3.1", to: "2.2.6", preimage: "/p" }) });
    expect(out).toMatchObject({ kind: "restored" });
    expect(notify).not.toHaveBeenCalled(); expect(notifyChat).not.toHaveBeenCalled();
  });
  it("after a completed start, the failed trees go (and nothing else)", async () => {
    const h = host();
    mkdirSync(join(h.prefix, ".agend-rollback", `2.3.1-${STAMP}-failed`, "agend"), { recursive: true });
    expect(await pruneFailedTrees(h.prefix)).toBe(1);
    expect(existsSync(join(h.prefix, ".agend-rollback", `2.3.1-${STAMP}-failed`))).toBe(false);
    expect(existsSync(h.keptDir)).toBe(true);
  });
});

describe("#2481 auto-restore: the notices say it was rolled back, and the data caveat", () => {
  it("chat: one message per version (it takes #2490's claim), the restore wording, the caveat, where the error is", () => {
    const home = scratch();
    writeFileSync(join(home, ATTEMPTS_FILE), JSON.stringify({ version: "2.3.1", attempts: [new Date(1000).toISOString(), new Date(2000).toISOString(), new Date(3000).toISOString()] }));
    const run = vi.fn((_cmd: string, _args: string[], _opts: { timeout: number }) => {});
    const launch = vi.fn((_cmd: string, _args: string[], _opts: unknown) => ({}));
    notifyRestore(home, "2.3.1", "2.2.6", "/p/.agend-rollback/2.2.6-x", { run, launch, platform: "darwin" });
    expect(run.mock.calls[0]![1].slice(1)).toEqual([home, "--restore", "2.3.1", "2.2.6", "/p/.agend-rollback/2.2.6-x"]);
    expect(launch.mock.calls[0]![1]).toEqual(["-e", 'display notification "AgEnD v2.3.1 failed to start; restoring v2.2.6 automatically. Run: agend doctor" with title "AgEnD"']);
    expect(readAttempts(home)).toMatchObject({ notified: true });
    expect(claimChatNotice(home, "2.3.1")).toBe(false);                 // the plain notice will not follow
    const text = restoreNoticeText(home, readAttempts(home)!, 4000, "2.2.6", "/p/.agend-rollback/2.2.6-x");
    expect(text.split("\n")).toEqual([
      "⚠ AgEnD v2.3.1 failed to start (3 start attempts in the last 10 minutes, none completed) and never ran here. AgEnD is restoring v2.2.6 automatically, from the copy the updater kept (/p/.agend-rollback/2.2.6-x).",
      "v2.3.1 may already have changed AgEnD's data before it failed. v2.2.6 reads data that 2.3 wrote (checked in CI), but if anything looks wrong, say so in the report.",
      `The error is at the end of ${join(home, "fleet.log")}. Please report it (agend doctor shows what to include): https://github.com/songsid/AgEnD/issues/new`,
    ]);
    setLocale("zh-TW");
    expect(restoreNoticeText(home, readAttempts(home)!, 4000, "2.2.6", "/p")).toContain("正在自動還原 v2.2.6");
  });
});

describe("#2481 agend doctor: the restore this host made", () => {
  it("restored: a warn row with the failed copy; failed: an error row with why; none: no row", async () => {
    const { collectDoctorReport } = await import("../src/doctor.js");
    const home = scratch();
    writeFileSync(join(home, "fleet.yaml"), "instances: {}\n");
    const deps = (record: unknown) => ({
      env: {}, platform: "linux" as const, run: (() => ({ status: 0, stdout: "", stderr: "" })) as never, processAlive: () => false,
      connectSocket: async () => false, networkFamily: () => ({ autoSelectFamily: true, attemptTimeoutMs: 250 }),
      collectResources: async () => ({ disk: [], memory: null }) as never, fetchFleetHealth: async () => ({}),
      systemUnitPath: () => null, codexPackage: () => null, startFailure: () => ({ failing: false as const }),
      autoRestore: () => record as never,
    });
    const service = { installed: true, path: "/x.plist", manager: "launchd", enabled: true, active: true } as never;
    const ok = await collectDoctorReport(home, service, deps({ from: "2.3.1", to: "2.2.6", preimage: "/p", attempts: 3, at: "T", result: "restored", failedTree: "/p/f" }));
    expect(ok.checks.find(c => c.label === "Auto-restore")).toMatchObject({ section: "Service", status: "warn",
      detail: "Restored v2.2.6 after v2.3.1 failed to start (T). The failed copy is kept for a report at /p/f until a later start completes." });
    const bad = await collectDoctorReport(home, service, deps({ from: "2.3.1", to: "2.2.6", preimage: "/p", attempts: 3, at: "T", result: "failed", reason: "EACCES" }));
    expect(bad.checks.find(c => c.label === "Auto-restore")).toMatchObject({ status: "error", detail: "Tried to restore v2.2.6 after v2.3.1 failed to start (T), but: EACCES" });
    expect((await collectDoctorReport(home, service, deps(null))).checks.some(c => c.label === "Auto-restore")).toBe(false);
  });
});
