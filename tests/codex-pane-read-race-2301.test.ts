import { afterEach, expect, it, vi } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const hook = vi.hoisted(() => ({
  open: null as
    | null
    | ((open: (...args: any[]) => Promise<any>, args: any[]) => Promise<any>),
}));
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (...args: any[]) => {
      const next = hook.open;
      hook.open = null;
      return next ? next(real.open as any, args) : (real.open as any)(...args);
    },
  };
});
import { checkpointCodexPane } from "../src/codex-pane-ownership.js";
import { TranscriptDeltaReader } from "../src/transcript-delta-reader.js";
const roots: string[] = [];
afterEach(() => {
  hook.open = null;
  vi.useRealTimers();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const ID = "01a1c81a-35be-7fc0-9a6d-f53f7d6c4c07";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-read2301-"));
  roots.push(root);
  const sessions = join(root, "sessions");
  mkdirSync(sessions);
  const path = join(sessions, `rollout-${ID}.jsonl`),
    header =
      JSON.stringify({
        type: "session_meta",
        payload: { id: ID, cwd: root, source: "vscode", thread_source: "user" },
      }) + "\n";
  writeFileSync(path, header);
  return {
    root,
    path,
    header,
    bind: () => checkpointCodexPane(sessions, ID, root),
  };
}
const user = (text: string) =>
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  }) + "\n";
it("checks the opened descriptor, not only the path before and after a replacement race", async () => {
  const f = fixture(),
    cp = (await f.bind())!;
  appendFileSync(f.path, user("other"));
  const replacement = f.path + ".foreign",
    original = f.path + ".original";
  writeFileSync(replacement, f.header + user("ours"));
  hook.open = async (open, args) => {
    renameSync(f.path, original);
    renameSync(replacement, f.path);
    const fh = await open(...args);
    renameSync(f.path, replacement);
    renameSync(original, f.path);
    return fh;
  };
  const reader = new TranscriptDeltaReader(
    f.path,
    cp.offset,
    "codex",
    { rawText: "ours" },
    cp.identity,
  );
  expect(await reader.look()).toBe("unavailable");
  expect(await cp.validateFile()).toBe(true);
});
it("a timed-out validation permanently retires admission while its one physical open drains", async () => {
  const f = fixture(),
    cp = (await f.bind())!;
  vi.useFakeTimers();
  let release!: () => void, entered!: () => void, closed!: () => void;
  const wait = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r)),
    done = new Promise<void>((r) => (closed = r));
  let opens = 0;
  hook.open = async (open, args) => {
    opens++;
    entered();
    await wait;
    const fh = await open(...args);
    const close = fh.close.bind(fh);
    fh.close = async () => {
      await close();
      closed();
    };
    return fh;
  };
  const first = cp.validateFile();
  await started;
  const concurrent = cp.validateFile();
  await vi.advanceTimersByTimeAsync(251);
  expect(await first).toBe(false);
  expect(await concurrent).toBe(false);
  expect(await cp.validateFile()).toBe(false);
  expect(opens).toBe(1);
  release();
  await done;
  expect(await cp.validateFile()).toBe(false);
});
