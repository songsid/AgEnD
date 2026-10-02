import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstanceDir, tightenDir, tightenInstanceDirs } from "../src/private-dir.js";
import { IpcServer } from "../src/channel/ipc-bridge.js";
import { FleetManager } from "../src/fleet-manager.js";
import { writePausedMarker } from "../src/pause-marker.js";
import { writeLastInboundAt } from "../src/daemon.js";
import { writeMuseUsageSnapshot } from "../src/muse-usage-relay.js";

/**
 * <dataDir>/instances/<name> holds agent.token and channel.sock. Created with the process umask it was 0775 —
 * group-writable, traversable by everyone — and every start logged a warning nobody acted on. These tests use
 * real directories and real modes (0775 is made explicitly, so they do not depend on this machine's umask).
 */
const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "agend-pd-")); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const mode = (p: string): number => statSync(p).mode & 0o777;
const loose = (p: string, m = 0o775): string => { mkdirSync(p, { recursive: true }); chmodSync(p, m); return p; };

describe("tightenDir", () => {
  it("makes a group-writable, other-traversable directory 0700 and says what it was", () => {
    const d = loose(join(tmp(), "inst"));
    expect(tightenDir(d)).toEqual({ kind: "tightened", from: 0o775 });
    expect(mode(d)).toBe(0o700);
  });

  it.each([0o755, 0o770, 0o750, 0o705, 0o777])("tightens %s", m => {
    const d = loose(join(tmp(), "inst"), m);
    expect(tightenDir(d).kind).toBe("tightened");
    expect(mode(d)).toBe(0o700);
  });

  it("leaves an already-private directory alone", () => {
    const d = loose(join(tmp(), "inst"), 0o700);
    expect(tightenDir(d)).toEqual({ kind: "ok" });
    expect(mode(d)).toBe(0o700);
  });

  it("repairs an owner-unusable directory too, so the fleet can still write to it", () => {
    const d = loose(join(tmp(), "inst"), 0o500);
    expect(tightenDir(d).kind).toBe("tightened");
    expect(mode(d)).toBe(0o700);
  });

  it("does not follow a symlink: the directory it points at keeps its mode", () => {
    const root = tmp();
    const target = loose(join(root, "elsewhere"), 0o777);
    const link = join(root, "link");
    symlinkSync(target, link);
    expect(tightenDir(link)).toEqual({ kind: "skipped", why: "symlink" });
    expect(mode(target)).toBe(0o777);
  });

  it("ignores a file", () => {
    const f = join(tmp(), "file"); writeFileSync(f, "x", { mode: 0o644 });
    expect(tightenDir(f)).toEqual({ kind: "skipped", why: "not-a-directory" });
    expect(mode(f)).toBe(0o644);
  });

  it("does not touch a directory someone else owns", () => {
    const d = loose(join(tmp(), "inst"));
    vi.spyOn(process, "getuid").mockReturnValue(statSync(d).uid + 1);
    expect(tightenDir(d)).toEqual({ kind: "skipped", why: "not-owner" });
    expect(mode(d)).toBe(0o775);
  });

  it("reports a path that does not exist as unreadable, without throwing", () => {
    expect(tightenDir(join(tmp(), "nope"))).toEqual({ kind: "skipped", why: "unreadable" });
  });
});

describe("ensureInstanceDir", () => {
  it("creates the directory 0700 whatever the umask is", () => {
    const prev = process.umask(0o002);
    try {
      const d = join(tmp(), "instances", "worker");
      ensureInstanceDir(d);
      expect(mode(d)).toBe(0o700);
    } finally { process.umask(prev); }
  });

  it("creates the directories above it private too, when it has to make them", () => {
    const prev = process.umask(0o002);
    try {
      const root = join(tmp(), "instances");
      ensureInstanceDir(join(root, "worker"));
      expect(mode(root)).toBe(0o700);
      expect(mode(join(root, "worker"))).toBe(0o700);
    } finally { process.umask(prev); }
  });

  it("corrects one that already exists loose", () => {
    const d = loose(join(tmp(), "worker"));
    ensureInstanceDir(d);
    expect(mode(d)).toBe(0o700);
  });

  it("changes only the directory: files and subdirectories the user put there keep their modes", () => {
    const d = loose(join(tmp(), "worker"));
    writeFileSync(join(d, "notes.txt"), "mine", { mode: 0o644 });
    loose(join(d, "scratch"), 0o755);
    ensureInstanceDir(d);
    expect(mode(d)).toBe(0o700);
    expect(mode(join(d, "notes.txt"))).toBe(0o644);
    expect(readFileSync(join(d, "notes.txt"), "utf8")).toBe("mine");
    expect(mode(join(d, "scratch"))).toBe(0o755);
  });

  it("is idempotent", () => {
    const d = join(tmp(), "worker");
    ensureInstanceDir(d); ensureInstanceDir(d);
    expect(mode(d)).toBe(0o700);
  });
});

describe("tightenInstanceDirs — the one-time startup repair", () => {
  function fixture() {
    const dataDir = tmp();
    const root = loose(join(dataDir, "instances"), 0o755);
    const a = loose(join(root, "a"), 0o775);
    const b = loose(join(root, "b"), 0o755);
    const c = loose(join(root, "c"), 0o700);
    const outside = loose(join(dataDir, "outside"), 0o777);
    symlinkSync(outside, join(root, "link"));
    writeFileSync(join(root, "stray.txt"), "x", { mode: 0o644 });
    writeFileSync(join(a, "agent.token"), "secret", { mode: 0o600 });
    writeFileSync(join(a, "mine.txt"), "mine", { mode: 0o664 });
    return { dataDir, root, a, b, c, outside };
  }

  it("makes the instances directory and every instance directory 0700, once", () => {
    const f = fixture();
    const report = tightenInstanceDirs(f.dataDir);
    expect([f.root, f.a, f.b, f.c].map(mode)).toEqual([0o700, 0o700, 0o700, 0o700]);
    expect(report.tightened.map(t => t.dir).sort()).toEqual([f.root, f.a, f.b].sort());
    expect(report.tightened.find(t => t.dir === f.a)!.from).toBe("0o775");
    expect(report.skipped).toEqual([{ dir: join(f.root, "link"), why: "symlink" }].slice(0, 0));   // a symlink child is not an instance directory: ignored, not reported
  });

  it("leaves everything it should not touch: symlink targets, stray files, files inside instances, and the data directory itself", () => {
    const f = fixture();
    const dataMode = mode(f.dataDir);
    tightenInstanceDirs(f.dataDir);
    expect(mode(f.outside)).toBe(0o777);
    expect(mode(join(f.root, "stray.txt"))).toBe(0o644);
    expect(mode(join(f.a, "agent.token"))).toBe(0o600);
    expect(mode(join(f.a, "mine.txt"))).toBe(0o664);
    expect(mode(f.dataDir)).toBe(dataMode);
  });

  it("finds nothing to do the second time", () => {
    const f = fixture();
    tightenInstanceDirs(f.dataDir);
    expect(tightenInstanceDirs(f.dataDir)).toEqual({ tightened: [], skipped: [] });
  });

  it("is a no-op, and does not throw, when there are no instances yet", () => {
    expect(tightenInstanceDirs(join(tmp(), "never-created"))).toEqual({ tightened: [], skipped: [] });
  });

  it("reports directories it is not allowed to change instead of failing", () => {
    const f = fixture();
    vi.spyOn(process, "getuid").mockReturnValue(statSync(f.a).uid + 1);
    const report = tightenInstanceDirs(f.dataDir);
    expect(report.tightened).toEqual([]);
    expect(report.skipped.map(s => s.why)).toEqual(expect.arrayContaining(["not-owner"]));
    expect(mode(f.a)).toBe(0o775);
  });

  it("leaves the directory listing intact", () => {
    const f = fixture();
    const before = readdirSync(f.root).sort();
    tightenInstanceDirs(f.dataDir);
    expect(readdirSync(f.root).sort()).toEqual(before);
  });
});

describe("FleetManager runs the repair at startup and says so once", () => {
  function fm(dataDir: string) {
    const info = vi.fn(); const warn = vi.fn();
    const manager = new FleetManager(dataDir);
    (manager as unknown as { logger: unknown }).logger = { info, warn, error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child() { return this; } };
    return { manager, info, warn };
  }

  it("tightens existing instance directories and logs a single line", () => {
    const dataDir = tmp();
    const root = loose(join(dataDir, "instances"), 0o755);
    const a = loose(join(root, "a")); const b = loose(join(root, "b"));
    const { manager, info, warn } = fm(dataDir);
    (manager as unknown as { tightenInstanceDirectories(): void }).tightenInstanceDirectories();
    expect([a, b, root].map(mode)).toEqual([0o700, 0o700, 0o700]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![0]).toMatchObject({ count: 3, modes: expect.arrayContaining(["0o775", "0o755"]) });
    expect(warn).not.toHaveBeenCalled();
  });

  it("runs as part of the fleet's own startup, not only when called directly", async () => {
    const dataDir = tmp();
    const root = loose(join(dataDir, "instances"), 0o755);
    const a = loose(join(root, "a"));
    const { manager } = fm(dataDir);
    const internals = manager as unknown as Record<string, unknown>;
    // Everything else finishStartup does is somebody else's business here.
    for (const name of ["announceToolPermissionsChange", "scheduleReconcile", "sweepOrphanedCancelButtons", "checkStartupSignatureConsistency"]) {
      if (typeof internals[name] === "function") vi.spyOn(manager as never, name as never).mockImplementation((() => undefined) as never);
    }
    (internals.finishStartup as () => void).call(manager);
    expect([a, root].map(mode)).toEqual([0o700, 0o700]);
  });

  it("a second start finds nothing and logs nothing", () => {
    const dataDir = tmp();
    loose(join(loose(join(dataDir, "instances"), 0o755), "a"));
    const first = fm(dataDir);
    (first.manager as unknown as { tightenInstanceDirectories(): void }).tightenInstanceDirectories();
    const second = fm(dataDir);
    (second.manager as unknown as { tightenInstanceDirectories(): void }).tightenInstanceDirectories();
    expect(second.info).not.toHaveBeenCalled();
    expect(second.warn).not.toHaveBeenCalled();
  });

  it("warns, once, about what it could not fix — and does not throw", () => {
    const dataDir = tmp();
    const a = loose(join(loose(join(dataDir, "instances"), 0o755), "a"));
    vi.spyOn(process, "getuid").mockReturnValue(statSync(a).uid + 1);
    const { manager, warn } = fm(dataDir);
    expect(() => (manager as unknown as { tightenInstanceDirectories(): void }).tightenInstanceDirectories()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain("chmod 700");
  });
});

describe("the IPC socket's parent-directory warning", () => {
  async function listenIn(dir: string) {
    const warn = vi.fn();
    const server = new IpcServer(join(dir, "channel.sock"), { warn, debug: vi.fn() });
    await server.listen();
    return { server, warn };
  }
  const open: IpcServer[] = [];
  afterEach(async () => { for (const s of open.splice(0)) await s.close().catch(() => {}); });

  it("fires for a directory that is open to group/other — once per directory, not once per start", async () => {
    const dir = loose(join(tmp(), "inst"));
    const first = await listenIn(dir); open.push(first.server);
    expect(first.warn).toHaveBeenCalledTimes(1);
    expect(String(first.warn.mock.calls[0]![1])).toContain("chmod 700");
    await first.server.close();
    const second = await listenIn(dir); open.push(second.server);
    expect(second.warn).not.toHaveBeenCalled();                  // 423 of these was the problem
  });

  it("fires for a group-writable directory even when other users cannot enter it, and not for a group-readable one", async () => {
    const writable = await listenIn(loose(join(tmp(), "gw"), 0o770)); open.push(writable.server);
    expect(writable.warn).toHaveBeenCalledTimes(1);
    const readable = await listenIn(loose(join(tmp(), "gr"), 0o750)); open.push(readable.server);
    expect(readable.warn).not.toHaveBeenCalled();
  });

  it("is silent once the instance directory is private — the repair removes the warning rather than the check", async () => {
    const dir = loose(join(tmp(), "inst"));
    ensureInstanceDir(dir);
    const { server, warn } = await listenIn(dir); open.push(server);
    expect(warn).not.toHaveBeenCalled();
  });

  it("only reports: it never changes a directory it did not create", async () => {
    const dir = loose(join(tmp(), "shared"), 0o777);
    const { server } = await listenIn(dir); open.push(server);
    expect(mode(dir)).toBe(0o777);
  });
});

describe("every place that creates an instance directory makes it private", () => {
  it("pause marker, last-inbound and muse usage snapshot", () => {
    const root = tmp();
    const prev = process.umask(0o002);
    try {
      writePausedMarker(join(root, "p"));
      writeLastInboundAt(join(root, "l"), 1);
      writeMuseUsageSnapshot(join(root, "m"), { updatedAt: 1 } as never);
    } finally { process.umask(prev); }
    expect(["p", "l", "m"].map(n => mode(join(root, n)))).toEqual([0o700, 0o700, 0o700]);
  });

  it("and one that was already loose is corrected by the same call", () => {
    const d = loose(join(tmp(), "p"));
    writePausedMarker(d);
    expect(mode(d)).toBe(0o700);
  });

  it("no source file creates an instance directory with a bare mkdirSync", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "ui" && e.name !== "node_modules") walk(p); continue; }
        if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts") || p.endsWith(join("src", "private-dir.ts"))) continue;
        const lines = readFileSync(p, "utf8").split("\n");
        lines.forEach((l, i) => { if (/mkdirSync\(\s*(this\.)?instanceDir\b/.test(l)) offenders.push(`${p}:${i + 1}`); });
      }
    };
    walk(join(process.cwd(), "src"));
    expect(offenders).toEqual([]);
  });
});
