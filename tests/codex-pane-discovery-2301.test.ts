import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
const hook = vi.hoisted(() => ({
  root: "", syncStats: 0,
  directory: null as null | ((open: (...args: any[]) => Promise<any>, args: any[]) => Promise<any>),
}));
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  return { ...real, statSync: (...args: any[]) => {
    if (hook.root && String(args[0]).startsWith(hook.root)) {
      hook.syncStats++;
      // Deterministic slow-filesystem probe: the old walker blocks ~400ms on this tiny tree.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    }
    return (real.statSync as any)(...args);
  } };
});
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return { ...real, opendir: (...args: any[]) => hook.directory
    ? hook.directory(real.opendir as any, args) : (real.opendir as any)(...args) };
});
import { checkpointCodexPane } from "../src/codex-pane-ownership.js";
const immediate = setImmediate;
const roots: string[] = [];
afterEach(() => {
  hook.root = ""; hook.syncStats = 0; hook.directory = null;
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const ID = "01a1c81a-35be-7fc0-9a6d-f53f7d6c4c07";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-discovery2301-")); roots.push(root);
  const sessions = join(root, "sessions"); mkdirSync(sessions);
  const path = join(sessions, `rollout-${ID}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: ID, cwd: root, source: "cli" } }) + "\n");
  return { root, sessions, path, bind: () => checkpointCodexPane(sessions, ID, root) };
}
it("does not synchronously walk/stat/sort even a small sessions tree", async () => {
  const f = fixture(); hook.root = f.sessions;
  for (let i = 0; i < 8; i++) writeFileSync(join(f.sessions, `rollout-unrelated-${i}.jsonl`), "inert\n");
  expect(await f.bind()).not.toBeNull();
  expect(hook.syncStats).toBe(0);
});
it("times out held discovery, refuses overlapping work, and closes without reading after release", async () => {
  const f = fixture(); vi.useFakeTimers();
  let release!: () => void, closed!: () => void;
  const wait = new Promise<void>(r => { release = r; });
  const drained = new Promise<void>(r => { closed = r; });
  let opens = 0, reads = 0;
  hook.directory = async (open, args) => {
    opens++;
    await wait;
    const dir = await open(...args);
    const read = dir.read.bind(dir), close = dir.close.bind(dir);
    dir.read = async () => { reads++; return read(); };
    dir.close = async () => { await close(); closed(); };
    return dir;
  };
  const pending = f.bind();
  await new Promise<void>(r => immediate(r));
  // The old synchronous index never reaches this async boundary.
  expect(opens).toBe(1);
  const overlapping = f.bind();
  await new Promise<void>(r => immediate(r));
  expect(opens).toBe(1);
  await vi.advanceTimersByTimeAsync(251);
  expect(await overlapping).toBeNull();
  expect(await pending).toBeNull();
  expect(opens).toBe(1);
  release(); await drained;
  await new Promise<void>(r => immediate(r));
  expect(reads).toBe(0);
  hook.directory = null;
  expect(await f.bind()).not.toBeNull();
});
it("a capped enumeration cannot authorize its first matching file", async () => {
  const f = fixture(); let reads = 0, closes = 0;
  hook.directory = async () => ({
    read: async () => {
      const n = reads++;
      if (n > 20_000) return null;
      return { name: n === 0 ? basename(f.path) : `other-${n}`, isFile: () => true,
        isDirectory: () => false, isSymbolicLink: () => false };
    },
    close: async () => { closes++; },
  });
  expect(await f.bind()).toBeNull();
  expect(reads).toBe(20_001);
  expect(closes).toBe(1);
});
it("a directory at the depth limit refuses incomplete uniqueness proof", async () => {
  const f = fixture(); let path = f.sessions;
  for (let i = 0; i < 9; i++) { path = join(path, "nested"); mkdirSync(path); }
  expect(await f.bind()).toBeNull();
});

it("a directory-count cap refuses even when the matching file was already seen", async () => {
  const f = fixture(); let opens = 0;
  hook.directory = async (_open, args) => {
    opens++; let n = 0;
    return {
      read: async () => {
        if (String(args[0]) !== f.sessions || n > 512) return null;
        const at = n++;
        return { name: at === 0 ? basename(f.path) : `dir-${at}`,
          isFile: () => at === 0, isDirectory: () => at !== 0, isSymbolicLink: () => false };
      },
      close: async () => {},
    };
  };
  expect(await f.bind()).toBeNull();
  expect(opens).toBe(1);
});

it("yields during a large buffered listing so the deadline can cancel it", async () => {
  const f = fixture(); vi.useFakeTimers();
  let reads = 0, closes = 0;
  hook.directory = async () => ({
    read: async () => ({ name: `unrelated-${reads++}`, isFile: () => true,
      isDirectory: () => false, isSymbolicLink: () => false }),
    close: async () => { closes++; },
  });
  const pending = f.bind();
  await new Promise<void>(r => immediate(r));
  // Buffered entries must return control before the size cap, rather than
  // starving the deadline behind an uninterrupted microtask chain.
  expect(reads).toBeGreaterThan(0);
  expect(reads).toBeLessThan(20_000);
  await vi.advanceTimersByTimeAsync(251);
  expect(await pending).toBeNull();
  await new Promise<void>(r => immediate(r));
  expect(closes).toBe(1);
});
