import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1490 (2.2 audit): `/ui/backends` ran `execFileSync("which", …)` once per backend, seven in a row with a 2 s timeout
 * each, on the fleet's event loop, on every request. These pin the replacement: an async PATH walk with no fork, an
 * answer reused for a TTL on a monotonic clock, concurrent probes sharing one walk, and a fresh probe for `/login`.
 */

const spawned = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const record = <F extends (...a: any[]) => any>(name: string, fn: F) =>
    ((...a: Parameters<F>) => { spawned.calls.push(`${name} ${String(a[0])}`); return fn(...a); }) as F;
  return {
    ...real,
    execFileSync: record("execFileSync", real.execFileSync),
    execSync: record("execSync", real.execSync),
    spawnSync: record("spawnSync", real.spawnSync),
    execFile: record("execFile", real.execFile),
    spawn: record("spawn", real.spawn),
  };
});

const { findOnPath, BinaryProbe, binaryProbe, BINARY_PROBE_TTL_MS } = await import("../src/binary-probe.js");
const { handleWebRequest } = await import("../src/web-api.js");

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "agend-probe-"));
  dirs.push(d);
  return d;
}
function file(dir: string, name: string, mode: number): string {
  const p = join(dir, name);
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, mode);
  return p;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("findOnPath", () => {
  it("returns the first PATH directory holding an executable regular file", async () => {
    const a = tempDir(), b = tempDir(), c = tempDir();
    file(a, "tool", 0o644);                     // present but not executable
    mkdirSync(join(b, "tool"));                 // a directory with the name
    const want = file(c, "tool", 0o755);
    file(tempDir(), "tool", 0o755);             // a later match must not win
    const rel = tempDir();
    file(rel, "tool", 0o755);                   // reachable only through a relative entry, which is skipped
    const PATH = [relative(process.cwd(), rel), a, "", b, c].join(delimiter);
    expect(await findOnPath("tool", { PATH })).toBe(want);
  });

  it("answers null when nothing matches, and refuses a name with a path in it", async () => {
    const a = tempDir();
    file(a, "tool", 0o755);
    expect(await findOnPath("absent", { PATH: a })).toBeNull();
    expect(await findOnPath("", { PATH: a })).toBeNull();
    expect(await findOnPath(`../${a.split("/").pop()}/tool`, { PATH: a })).toBeNull();
    expect(await findOnPath("tool", {})).toBeNull();
  });

  it("agrees with which on a binary every host has (positive control against the real tool)", async () => {
    const { execFileSync } = await import("node:child_process");
    const viaWhich = execFileSync("which", ["sh"], { encoding: "utf-8" }).trim();
    expect(await findOnPath("sh")).toBe(viaWhich);
  });
});

describe("BinaryProbe", () => {
  let clock = 0;
  let walks: Array<{ binary: string; resolve: (p: string | null) => void }> = [];
  const make = () => new BinaryProbe(
    (binary) => new Promise((resolve) => { walks.push({ binary, resolve }); }),
    () => clock,
  );
  const flush = () => new Promise((r) => setTimeout(r, 0));
  beforeEach(() => { clock = 1_000; walks = []; });

  it("reuses an answer until the TTL passes, then walks again", async () => {
    const probe = make();
    const first = probe.probe("codex");
    walks.shift()!.resolve("/bin/codex");
    expect(await first).toBe("/bin/codex");

    clock += BINARY_PROBE_TTL_MS - 1;
    expect(await probe.probe("codex")).toBe("/bin/codex");
    expect(walks.length, "inside the TTL: no walk").toBe(0);

    clock += 1;
    const again = probe.probe("codex");
    expect(walks.length, "TTL over: one walk").toBe(1);
    walks.shift()!.resolve(null);
    expect(await again).toBeNull();
  });

  it("shares one walk between concurrent probes of one binary, not across binaries", async () => {
    const probe = make();
    const a = probe.probe("codex"), b = probe.probe("codex"), c = probe.probe("grok");
    expect(walks.map((w) => w.binary)).toEqual(["codex", "grok"]);
    walks[0].resolve("/bin/codex");
    walks[1].resolve(null);
    expect(await Promise.all([a, b, c])).toEqual(["/bin/codex", "/bin/codex", null]);
  });

  it("a fresh probe ignores a cached answer and a walk already running, and its answer is the one kept", async () => {
    const probe = make();
    const cached = probe.probe("codex");
    walks.shift()!.resolve(null);
    expect(await cached).toBeNull();

    const stale = probe.probe("codex", { fresh: true });
    expect(walks.length, "fresh skips the cached null").toBe(1);
    const fresh = probe.probe("codex", { fresh: true });
    expect(walks.length, "fresh skips the walk in flight").toBe(2);

    walks[1].resolve("/bin/codex");             // the install finished; the newer walk sees it
    expect(await fresh).toBe("/bin/codex");
    walks[0].resolve(null);                     // the older walk ends last with the old answer
    expect(await stale).toBeNull();
    await flush();
    expect(await probe.probe("codex"), "the superseded walk did not overwrite the newer answer").toBe("/bin/codex");
    expect(walks.length).toBe(2);
  });

  it("a walk running when invalidate() is called does not store its answer", async () => {
    const probe = make();
    const before = probe.probe("codex");
    probe.invalidate();
    walks.shift()!.resolve(null);
    expect(await before).toBeNull();
    await flush();

    const after = probe.probe("codex");
    expect(walks.length, "nothing cached from the invalidated walk").toBe(1);
    walks.shift()!.resolve("/bin/codex");
    expect(await after).toBe("/bin/codex");
  });

  it("a walk that throws answers null instead of rejecting the route", async () => {
    const probe = new BinaryProbe(async () => { throw new Error("EIO"); }, () => clock);
    await expect(probe.probe("codex")).resolves.toBeNull();
  });
});

describe("GET /ui/backends (#1490)", () => {
  const token = "b".repeat(48);
  let savedPath: string | undefined;
  beforeEach(() => { savedPath = process.env.PATH; spawned.calls = []; binaryProbe.invalidate(); });
  afterEach(() => { process.env.PATH = savedPath; binaryProbe.invalidate(); });

  function get() {
    const req = Object.assign(new EventEmitter(), {
      method: "GET", url: "/ui/backends", headers: { host: "127.0.0.1:19280", "x-agend-token": token },
      destroy: vi.fn(), socket: { destroy: vi.fn() },
    });
    let status = 0, text = "", ended = false;
    const done = new Promise<void>((resolve) => {
      const res = Object.assign(new EventEmitter(), {
        headersSent: false, setHeader() {}, writeHead: (c: number) => { status = c; },
        end: (t = "") => { text = t; ended = true; resolve(); }, write() { return true; },
      });
      const ctx = { webToken: token, logger: { info() {}, debug() {}, warn() {}, error() {} } } as any;
      expect(handleWebRequest(req as any, res as any, new URL("http://127.0.0.1:19280/ui/backends"), ctx)).toBe(true);
    });
    const endedSynchronously = ended;
    return { endedSynchronously, done: done.then(() => ({ status, body: JSON.parse(text) })) };
  }

  it("answers from a PATH walk without starting a process, and without blocking the request handler", async () => {
    const bin = tempDir();
    const codex = file(bin, "codex", 0o755);
    file(bin, "grok", 0o644);
    process.env.PATH = bin;

    const call = get();
    expect(call.endedSynchronously, "the handler returned before the answer: nothing ran synchronously").toBe(false);
    const { status, body } = await call.done;
    expect(status).toBe(200);
    const byName = Object.fromEntries(body.backends.map((b: { name: string }) => [b.name, b]));
    expect(byName.codex).toMatchObject({ binary: "codex", installed: true, path: codex });
    expect(byName.grok).toMatchObject({ installed: false, path: "" });
    expect(byName["claude-code"]).toMatchObject({ binary: "claude", installed: false });
    expect(Object.keys(byName).sort()).toEqual(["antigravity", "claude-code", "codex", "grok", "kiro-cli", "muse", "opencode"]);
    expect(spawned.calls, "no which, no fork").toEqual([]);
  });

  it("reuses the answer on the next poll, so an install shows up after the TTL or a fresh probe", async () => {
    const bin = tempDir();
    process.env.PATH = bin;
    expect((await get().done).body.backends.find((b: { name: string }) => b.name === "codex").installed).toBe(false);

    file(bin, "codex", 0o755);
    expect((await get().done).body.backends.find((b: { name: string }) => b.name === "codex").installed, "cached").toBe(false);
    await binaryProbe.probe("codex", { fresh: true });   // what /login's probe does after an install
    expect((await get().done).body.backends.find((b: { name: string }) => b.name === "codex").installed).toBe(true);
  });
});

describe("/login's installed-backend probe (#1490)", () => {
  let savedPath: string | undefined;
  beforeEach(() => { savedPath = process.env.PATH; spawned.calls = []; binaryProbe.invalidate(); });
  afterEach(() => { process.env.PATH = savedPath; binaryProbe.invalidate(); });

  it("sees a binary installed a moment ago although the shared cache still says absent, and forks nothing", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(tempDir()) as unknown as { probeInstalledBackends(): Promise<Set<string>> };
    const bin = tempDir();
    process.env.PATH = bin;
    expect(await binaryProbe.probe("codex"), "cached: absent").toBeNull();

    file(bin, "codex", 0o755);                  // what /login's install just did
    expect([...await fm.probeInstalledBackends()]).toEqual(["codex"]);
    expect(await binaryProbe.probe("codex"), "and the route's cache now agrees").toBe(join(bin, "codex"));
    expect(spawned.calls).toEqual([]);
  });
});
