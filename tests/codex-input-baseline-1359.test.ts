import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";
import { pastedTextSignature } from "../src/pane-input-residue.js";
import type { Logger } from "../src/logger.js";
import type { CliBackend } from "../src/backend/types.js";
import type { TmuxManager } from "../src/tmux-manager.js";

const forbidden = vi.hoisted(() => vi.fn(() => { throw new Error("#1359 forbids native process execution in tests"); }));
vi.mock("node:child_process", () => ({ exec: forbidden, execFile: forbidden, execSync: forbidden, execFileSync: forbidden,
  spawn: forbidden, spawnSync: forbidden, fork: forbidden }));
vi.mock("../src/backend/types.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/backend/types.js")>(), resolveBinary: () => "/never-execute/codex",
}));
const fixture = (name: string) => readFileSync(new URL(`./fixtures/codex-input-baseline-1359/${name}.txt`, import.meta.url), "utf8");
const WARNING = fixture("warning-baseline");
const MULTILINE = fixture("old-multiline-unreadable");
const OLDER = fixture("older-input-readable");
const SUBMITTED = fixture("submitted");
const HIDDEN_ECHO = fixture("wrong-recovery-submitted");
const IDLE = readFileSync(new URL("./fixtures/codex-audit-0162/v0160/idle.pane.txt", import.meta.url), "utf8");
const TEXT = "OLD DRAFT 1359 shared opening NEW DELIVERY 1359 NOT THE OLD DRAFT";
const signature = { value: pastedTextSignature(TEXT), unique: false };
type AnyDaemon = Daemon & Record<string, any>;
const standingIn = <T,>(stub: object): T => stub as unknown as T;
const dirs: string[] = [];
const daemons: AnyDaemon[] = [];
afterEach(() => {
  for (const daemon of daemons.splice(0)) daemon["freezeRuntimeMonitors"]();
  vi.clearAllTimers(); vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  expect(forbidden).not.toHaveBeenCalled();
});

describe("fresh structured-input proof after the system retry delay", () => {
  // Queue layout derived from the already-tracked native-queue-strand fixture; no new native capture claim.
  const queued = ["• Working (15s • esc to interrupt)",
    "• Messages to be submitted after next tool call (press esc to interrupt and send immediately)",
    `  ↳ ${TEXT}`, "› Ask Codex to do anything", "  Context 63% left"].join("\n");
  it.each([
    ["readable owned strand persists", IDLE, OLDER, OLDER, true, 2],
    ["initially unproven but a readable baseline owns the fresh strand", IDLE, WARNING, OLDER, true, 2],
    ["owned strand becomes unreadable during the delay", IDLE, OLDER, WARNING, false, 1],
    ["owned strand submits itself during the delay", IDLE, OLDER, SUBMITTED, true, 1],
    ["unknown baseline gains a new positive echo", WARNING, WARNING, SUBMITTED, true, 1],
    ["unknown baseline gains a new positive queue", WARNING, WARNING, queued, true, 1],
    ["unknown screen remains unknown", WARNING, WARNING, WARNING, false, 1],
  ] as const)("%s", async (_name, before, first, later, ok, keys) => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { daemon } = makeDaemon();
    let pane: string = before;
    let enters = 0;
    const paste = vi.fn(async () => { pane = first; return true; });
    const enter = vi.fn(async () => { if (++enters === 2) pane = SUBMITTED; return true; });
    const capture = vi.fn(async () => pane);
    daemon["tmux"] = standingIn<TmuxManager>({ capturePane: capture, pasteBuffer: paste,
      sendSpecialKey: enter, getLastSendSpecialKeyError: () => null });
    const done = daemon["submitSystemPaste"](TEXT, "retry-proof-control");
    setTimeout(() => { pane = later; }, 750);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await done).toBe(ok);
    expect(enter).toHaveBeenCalledTimes(keys);
    expect(paste).toHaveBeenCalledExactlyOnceWith(TEXT);
    expect(capture).toHaveBeenCalledTimes(keys === 2 ? 4 : 3);
  });
  it.each([OLDER, SUBMITTED])("revocation during the fresh capture refuses even a late owned/positive result", async later => {
    vi.useFakeTimers();
    const { daemon } = makeDaemon();
    let live = true;
    let captures = 0;
    let release!: (pane: string) => void;
    const held = new Promise<string>(resolve => { release = resolve; });
    const capture = vi.fn(async () => ++captures === 1 ? IDLE : captures === 2 ? WARNING : held);
    const enter = vi.fn(async () => true);
    daemon["tmux"] = standingIn<TmuxManager>({ capturePane: capture, pasteBuffer: vi.fn(async () => true),
      sendSpecialKey: enter, getLastSendSpecialKeyError: () => null });
    const done = daemon["submitSystemPaste"](TEXT, "revoked-fresh-proof", { current: () => live, accept: () => true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(captures).toBe(3);
    live = false;
    release(later);
    expect(await done).toBe(false);
    expect(enter).toHaveBeenCalledExactlyOnceWith("Enter");
  });
  it("a failed fresh capture cannot authorize a recovery key", async () => {
    vi.useFakeTimers();
    const { daemon } = makeDaemon();
    let captures = 0;
    const capture = vi.fn(async () => {
      if (++captures === 3) throw new Error("inert capture unavailable");
      return captures === 1 ? IDLE : OLDER;
    });
    const enter = vi.fn(async () => true);
    daemon["tmux"] = standingIn<TmuxManager>({ capturePane: capture, pasteBuffer: vi.fn(async () => true),
      sendSpecialKey: enter, getLastSendSpecialKeyError: () => null });
    const done = daemon["submitSystemPaste"](TEXT, "failed-fresh-proof");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await done).toBe(false);
    expect(capture).toHaveBeenCalledTimes(3);
    expect(enter).toHaveBeenCalledExactlyOnceWith("Enter");
  });
  it("row-only backends keep their ordinary retry and capture counts", async () => {
    vi.useFakeTimers();
    const { daemon } = makeDaemon();
    daemon["backend"] = standingIn<CliBackend>({ getBottomReadyPattern: () => /^❯\s*/ });
    let enters = 0;
    const capture = vi.fn(async () => enters < 2 ? "redraw" : `${TEXT}\n❯ `);
    const enter = vi.fn(async () => { enters++; return true; });
    daemon["tmux"] = standingIn<TmuxManager>({ capturePane: capture, pasteBuffer: vi.fn(async () => true),
      sendSpecialKey: enter, getLastSendSpecialKeyError: () => null });
    const done = daemon["submitSystemPaste"](TEXT, "row-only-legacy");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await done).toBe(true);
    expect(enter).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenCalledTimes(3);
  });
});
function makeDaemon() {
  const dir = mkdtempSync(join(tmpdir(), "agend-codex-baseline-1359-")); dirs.push(dir);
  const warns: unknown[][] = [];
  const log = { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: (...args: unknown[]) => warns.push(args) };
  const logger = { child: () => log } as unknown as Logger;
  const daemon = new Daemon("baseline-test", { backend: "codex", working_directory: dir,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 }, log_level: "silent",
  } as any, dir, true, undefined, undefined, logger) as AnyDaemon;
  const backend = new CodexBackend(dir);
  daemons.push(daemon); daemon["backend"] = backend;
  return { daemon, backend, warns };
}
describe("Codex baseline ownership (#1359), native 0.160.0 frames", () => {
  it.each([WARNING, MULTILINE])("unreadable means unknown, although the real composer already holds an older draft", before => {
    const { daemon, backend } = makeDaemon();
    expect(backend.isDeliveryInputReadyPane(before)).toBe(false);
    expect(backend.isDeliveryInputReadyPane(OLDER)).toBe(true);
    const baseline = daemon["paneEvidence"](before, signature);
    expect(baseline.inputReadable).toBe(false);
    expect(baseline.strandedInput).toBe(false);
    expect(daemon["paneEvidence"](OLDER, signature).strandedInput).toBe(true);
    expect(daemon["judgeSubmission"](OLDER, signature, baseline)).toBe("unverifiable");
  });
  it("the real system-paste path never retries Enter on the older draft after viewer recovery", async () => {
    vi.useFakeTimers();
    const { daemon, warns } = makeDaemon();
    let entered = false;
    const paste = vi.fn(async () => true); // native warning viewer accepted the tmux paste ACK, ignored its bytes
    const enter = vi.fn(async () => { entered = true; return true; });
    daemon["tmux"] = standingIn<TmuxManager>({ capturePane: vi.fn(async () => entered ? OLDER : WARNING), pasteBuffer: paste,
      sendSpecialKey: enter, getLastSendSpecialKeyError: () => null });
    const promise = daemon["submitSystemPaste"](TEXT, "instruction-reload-notice");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await promise).toBe(false);
    expect(paste).toHaveBeenCalledExactlyOnceWith(TEXT);
    expect(enter).toHaveBeenCalledExactlyOnceWith("Enter");
    expect(warns.some(args => args.includes("Codex system paste could not be verified"))).toBe(true);
  });
  it("viewer recovery after the first confirmation but before retry cannot submit the old draft", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { daemon } = makeDaemon();
    let pane = WARNING;
    let oldDraftSubmissions = 0;
    const captures: { at: number; pane: string }[] = [];
    const paste = vi.fn(async () => true);
    const enter = vi.fn(async () => {
      if (pane === OLDER) { oldDraftSubmissions++; pane = HIDDEN_ECHO; }
      return true;
    });
    daemon["tmux"] = standingIn<TmuxManager>({
      capturePane: vi.fn(async () => { captures.push({ at: Date.now(), pane }); return pane; }),
      pasteBuffer: paste, sendSpecialKey: enter, getLastSendSpecialKeyError: () => null,
    });
    const done = daemon["submitSystemPaste"](TEXT, "late-viewer-recovery");
    setTimeout(() => { pane = OLDER; }, 750); // normal user Escape/resize, AFTER the unproven capture at 500 ms
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await done).toBe(false);
    expect(captures).toContainEqual({ at: 500, pane: WARNING });
    expect(oldDraftSubmissions).toBe(0);
    expect(paste).toHaveBeenCalledExactlyOnceWith(TEXT);
    expect(enter).toHaveBeenCalledExactlyOnceWith("Enter");
  });
  it("a readable empty baseline still attributes a newly stranded body", () => {
    const { daemon } = makeDaemon();
    const baseline = daemon["paneEvidence"](IDLE, signature);
    expect(baseline.inputReadable).toBe(true); expect(baseline.strandedInput).toBe(false);
    expect(daemon["judgeSubmission"](OLDER, signature, baseline)).toBe("stranded");
  });
  it("a readable baseline already holding the same body cannot identify it as ours", () => {
    const { daemon } = makeDaemon();
    const baseline = daemon["paneEvidence"](OLDER, signature);
    expect(baseline.inputReadable).toBe(true); expect(baseline.strandedInput).toBe(true);
    expect(daemon["judgeSubmission"](OLDER, signature, baseline)).toBe("unproven");
  });
  it("a unique delivery identity still identifies its residue without a readable baseline", () => {
    const { daemon } = makeDaemon();
    const unique = { value: "delivery1359unique", unique: true };
    const after = OLDER.replaceAll("OLD DRAFT 1359 shared opening", unique.value);
    expect(daemon["judgeSubmission"](after, unique, daemon["paneEvidence"](WARNING, unique))).toBe("stranded");
  });
  it("new positive evidence outside the input still proves submission after an unreadable baseline", () => {
    const { daemon } = makeDaemon();
    expect(daemon["judgeSubmission"](SUBMITTED, signature, daemon["paneEvidence"](WARNING, signature))).toBe("submitted");
  });
  it("a hidden viewport echo is inconclusive even though the native mock received the old draft", () => {
    const { daemon } = makeDaemon();
    expect(daemon["judgeSubmission"](HIDDEN_ECHO, signature, daemon["paneEvidence"](WARNING, signature))).toBe("unproven");
  });
  it("no baseline cannot attribute a non-unique body", () => {
    const { daemon } = makeDaemon();
    expect(daemon["judgeSubmission"](OLDER, signature, null)).toBe("unverifiable");
  });
  it("ordinary row-only backends retain their existing attribution", () => {
    const { daemon } = makeDaemon();
    daemon["backend"] = standingIn<CliBackend>({ getBottomReadyPattern: () => /^❯\s*/ });
    const after = `❯ ${TEXT}`;
    expect(daemon["judgeSubmission"](after, signature, daemon["paneEvidence"]("redraw", signature))).toBe("stranded");
  });
});
