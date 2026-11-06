/** Real private files; no CLI, account, provider root or host process is used. */
import { afterEach, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NativePaneTranscriptReader } from "../src/runtime-pane-transcript.js";
import { prepareNativePaneQuotaHistory } from "../src/runtime-pane-quota-history.js";
import type { RuntimePaneLaunch } from "../src/runtime-pane-protocol.js";
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
const MESSAGE = "You’ve hit your usage limit. Try again at 8:59 AM.";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agend-native-quota-proof-")); dirs.push(root);
  const sessionId = randomUUID(), cwd = "C:\\private-fixture", codex = join(root, "codex"), folder = join(codex, "sessions"); mkdirSync(folder, { recursive: true });
  const path = join(folder, `rollout-test-${sessionId}.jsonl`), meta = { type: "session_meta", payload: { id: sessionId, cwd, source: "cli" } };
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  const error = { timestamp: "2026-01-01T00:00:00Z", type: "event_msg", payload: { type: "task_complete", turn_id: "old", error: { message: MESSAGE, codex_error_info: "usage_limit_exceeded" } } };
  writeFileSync(path, line(meta) + line(error));
  const reader = () => new NativePaneTranscriptReader("codex", cwd, sessionId, { codex, claude: join(root, "unused") });
  const launch: RuntimePaneLaunch = { cli: "codex", cwd, sessionId, paneId: randomUUID(), agentId: randomUUID(), launchId: randomUUID(), instance: "fixture", sandbox: "read-only", columns: 80, rows: 24 };
  return { root, path, meta, error, line, reader, launch };
}
it("freezes the exact owned pre-resume quota message, and closing discovery does not invalidate an unchanged proof", async () => {
  const f = fixture(), proof = await prepareNativePaneQuotaHistory(f.launch, f.reader);
  expect(proof?.messages).toEqual([MESSAGE]); expect(proof?.current()).toBe(true);
});
it.each(["id", "cwd", "source", "partial", "invalid", "future", "quoted", "symlink", "duplicate"])("%s evidence supplies no native history exemption", async kind => {
  const f = fixture();
  if (kind === "id") f.meta.payload.id = randomUUID();
  if (kind === "cwd") f.meta.payload.cwd = "C:\\other";
  if (kind === "source") f.meta.payload.source = "vscode";
  if (kind === "future") f.error.timestamp = "2999-01-01T00:00:00Z";
  if (kind === "quoted") f.error.type = "assistant";
  writeFileSync(f.path, f.line(f.meta) + f.line(f.error) + (kind === "partial" ? "{" : kind === "invalid" ? "{\n" : ""));
  if (kind === "symlink") { renameSync(f.path, f.path + ".real"); symlinkSync(f.path + ".real", f.path); }
  if (kind === "duplicate") writeFileSync(join(f.root, "codex", "sessions", `rollout-other-${f.launch.sessionId}.jsonl`), f.line(f.meta) + f.line(f.error));
  expect(await prepareNativePaneQuotaHistory(f.launch, f.reader)).toBeNull();
});
it.each(["append", "replace", "truncate", "symlink"])("%s after freezing revokes the native proof", async kind => {
  const f = fixture(), proof = await prepareNativePaneQuotaHistory(f.launch, f.reader); expect(proof?.current()).toBe(true);
  if (kind === "append") appendFileSync(f.path, f.line(f.error));
  if (kind === "replace") { renameSync(f.path, f.path + ".old"); writeFileSync(f.path, f.line(f.meta) + f.line(f.error)); }
  if (kind === "truncate") writeFileSync(f.path, f.line(f.meta));
  if (kind === "symlink") { renameSync(f.path, f.path + ".real"); symlinkSync(f.path + ".real", f.path); }
  expect(proof?.current()).toBe(false);
});
it("a fresh or non-Codex launch never opens a provider store", async () => {
  const f = fixture(), create = vi.fn(f.reader);
  expect(await prepareNativePaneQuotaHistory({ ...f.launch, sessionId: undefined }, create)).toBeNull();
  expect(await prepareNativePaneQuotaHistory({ ...f.launch, cli: "claude-code" }, create)).toBeNull(); expect(create).not.toHaveBeenCalled();
});
it("a deadline retires the read before its late proof can escape", async () => {
  vi.useFakeTimers(); const f = fixture(); let active!: () => boolean, release!: (value: null) => void;
  const close = vi.fn(async () => {}), quotaReplayHistory = vi.fn((current: () => boolean) => { active = current; return new Promise<null>(resolve => { release = resolve; }); });
  const pending = prepareNativePaneQuotaHistory(f.launch, () => ({ close, quotaReplayHistory }));
  await vi.advanceTimersByTimeAsync(1000); expect(await pending).toBeNull(); expect(active()).toBe(false);
  release(null); await Promise.resolve(); await Promise.resolve(); expect(close).toHaveBeenCalledOnce();
});

it("completes incremental exact-id discovery within the pre-launch window", async () => {
  const f = fixture(); for (let index = 0; index < 300; index++) writeFileSync(join(f.root, "codex", "sessions", `other-${randomUUID()}.jsonl`), "unrelated, never read");
  expect((await prepareNativePaneQuotaHistory(f.launch, f.reader))?.messages).toEqual([MESSAGE]);
});
it.each(["count", "bytes"])("a %s overflow provides no native metadata", async kind => {
  const f = fixture();
  const error = kind === "bytes" ? { ...f.error, payload: { ...f.error.payload, error: { ...f.error.payload.error, message: MESSAGE + "x".repeat(17 * 1024) } } } : f.error;
  writeFileSync(f.path, f.line(f.meta) + f.line(error).repeat(kind === "count" ? 33 : 1));
  expect(await prepareNativePaneQuotaHistory(f.launch, f.reader)).toBeNull();
});

it("retains shared read capacity past the logical deadline through physical read and cleanup", async () => {
  vi.useFakeTimers(); const f = fixture();
  let settleRead!: (value: null) => void, settleClose!: () => void;
  const close = vi.fn(() => new Promise<void>(resolve => { settleClose = resolve; }));
  const first = vi.fn(() => ({ quotaReplayHistory: () => new Promise<null>(resolve => { settleRead = resolve; }), close }));
  const next = vi.fn(() => ({ quotaReplayHistory: async () => null, close: async () => {} }));
  const pending = prepareNativePaneQuotaHistory(f.launch, first);
  try {
    await vi.advanceTimersByTimeAsync(1000); expect(await pending).toBeNull();
    expect(await prepareNativePaneQuotaHistory(f.launch, next)).toBeNull(); expect(next).not.toHaveBeenCalled();
    settleRead(null); await vi.advanceTimersByTimeAsync(0); expect(close).toHaveBeenCalledOnce();
    expect(await prepareNativePaneQuotaHistory(f.launch, next)).toBeNull(); expect(next).not.toHaveBeenCalled();
    settleClose(); await vi.advanceTimersByTimeAsync(0);
    expect(await prepareNativePaneQuotaHistory(f.launch, next)).toBeNull(); expect(next).toHaveBeenCalledOnce();
  } finally { settleRead(null); settleClose?.(); await vi.advanceTimersByTimeAsync(0); }
});

it("a constructor or read failure retires optional proof without stranding shared capacity", async () => {
  const f = fixture();
  expect(await prepareNativePaneQuotaHistory(f.launch, () => { throw Error("constructor unavailable"); })).toBeNull();
  const close = vi.fn(async () => {});
  expect(await prepareNativePaneQuotaHistory(f.launch, () => ({ quotaReplayHistory: async () => { throw Error("read unavailable"); }, close }))).toBeNull();
  expect(close).toHaveBeenCalledOnce();
  expect((await prepareNativePaneQuotaHistory(f.launch, f.reader))?.messages).toEqual([MESSAGE]);
});
