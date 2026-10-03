import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, openSync, ftruncateSync, closeSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { collectResourceReport, formatResourceReport, probeDiskUsage, readHostMemory } from "../src/resource-report.js";
import { collectDoctorReport, formatDoctorReport } from "../src/doctor.js";
import { setLocale, t } from "../src/locale.js";

const roots: string[] = [];
const MiB = 1024 ** 2;
function root() {
  const dir = mkdtempSync(join(tmpdir(), "agend-resources-")); roots.push(dir); return dir;
}
function config(dir: string, value: unknown = { instances: {} }) {
  writeFileSync(join(dir, "fleet.yaml"), yaml.dump(value));
}
function instance(dir: string, name: string) {
  mkdirSync(join(dir, "instances", name), { recursive: true });
}
const memory = () => ({ totalBytes: 8 * MiB, availableBytes: 6 * MiB, availableKind: "available" as const, swapTotalBytes: 4 * MiB, swapFreeBytes: MiB });
const probe = { memory, diskUsage: async () => 1024 };
afterEach(() => {
  setLocale("en"); vi.restoreAllMocks();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("host memory snapshot", () => {
  it("uses MemAvailable rather than MemFree, and distinguishes swap free from total", () => {
    expect(readHostMemory({ platform: "linux", meminfo: () => "MemTotal: 8192 kB\nMemFree: 512 kB\nMemAvailable: 6144 kB\nSwapTotal: 4096 kB\nSwapFree: 1024 kB\n" })).toEqual(memory());
  });
  it("reports zero swap as zero, while missing swap is unknown", () => {
    const base = "MemTotal: 8192 kB\nMemAvailable: 6144 kB\n";
    expect(readHostMemory({ platform: "linux", meminfo: () => base + "SwapTotal: 0 kB\nSwapFree: 0 kB\n" }).swapTotalBytes).toBe(0);
    expect(readHostMemory({ platform: "linux", meminfo: () => base }).swapTotalBytes).toBeNull();
    expect(readHostMemory({ platform: "linux", meminfo: () => base + "SwapTotal: 1 kB\nSwapFree: 2 kB\n" }).swapFreeBytes).toBeNull();
  });
  it("uses a labeled free-memory fallback on non-Linux without reading procfs", () => {
    const meminfo = vi.fn(() => { throw new Error("must not read"); });
    expect(readHostMemory({ platform: "darwin", meminfo, totalmem: () => 8 * MiB, freemem: () => MiB })).toEqual({
      totalBytes: 8 * MiB, availableBytes: MiB, availableKind: "free", swapTotalBytes: null, swapFreeBytes: null,
    });
    expect(meminfo).not.toHaveBeenCalled();
  });
  it("falls back when procfs is missing or the memory fields are invalid", () => {
    for (const meminfo of [() => { throw new Error("missing"); }, () => "MemTotal: 1 kB\nMemAvailable: 2 kB\n"]) {
      expect(readHostMemory({ platform: "linux", meminfo, totalmem: () => 100, freemem: () => 20 }).availableBytes).toBe(20);
    }
  });
});

describe("read-only resource inventory", () => {
  it("resolves inherited/custom/default workspaces, includes retained workspaces, and measures aliases once", async () => {
    const dir = root();
    const shared = join(dir, "shared repo"); mkdirSync(shared);
    const alias = join(dir, "alias"); symlinkSync(shared, alias);
    const custom = join(dir, "custom"); mkdirSync(custom);
    mkdirSync(join(dir, "workspaces", "retained"), { recursive: true });
    config(dir, { defaults: { working_directory: shared }, instances: { a: {}, b: { working_directory: alias }, c: { working_directory: custom }, d: { working_directory: "" } } });
    for (const name of ["a", "b", "c", "d"]) instance(dir, name);
    writeFileSync(join(dir, "instances", "a", "paused"), "paused");
    const diskUsage = vi.fn(async (_path: string) => 2048);
    const report = await collectResourceReport(dir, { ...probe, diskUsage });
    expect(report.workspaces).toHaveLength(4);
    expect(report.workspaces.find(row => row.path === shared)?.names).toEqual(["a", "b"]);
    expect(report.workspaces.find(row => row.path === custom)?.names).toEqual(["c"]);
    expect(report.workspaces.find(row => row.names.includes("d"))?.path).toBe(join(dir, "workspaces", "d"));
    expect(diskUsage.mock.calls.filter(([path]) => path === shared)).toHaveLength(1);
    expect(report.orphans).toEqual([]);
  });

  it("excludes explicit Classic names and legacy primary/non-primary names from orphan classification", async () => {
    const dir = root();
    config(dir, { instances: { fleet: {} }, channels: [{ id: "primary", type: "telegram" }, { id: "second bot", type: "telegram" }] });
    writeFileSync(join(dir, "classicBot.yaml"), yaml.dump({ channels: {
      arbitrary: { instanceName: "persisted-classic", channelId: "123" },
      "-100111": { name: "研一 Project", adapterId: "primary" },
      legacy2: { channelId: "-100222", name: "研一 Project", adapterId: "second bot" },
      "987654321098765432": { name: "Legacy" },
    } }));
    const names = ["fleet", "persisted-classic", "classic-研一-project-0111", "classic-研一-project-0222-second-bot", "classic-legacy-5432"];
    for (const name of [...names, "retired"]) instance(dir, name);
    const report = await collectResourceReport(dir, probe);
    expect(report.orphans?.map(row => row.names[0])).toEqual(["retired"]);
    expect(report.workspaces.flatMap(row => row.names).sort()).toEqual(names.sort());
  });

  it("lists only unregistered real instance directories, without following links or touching sources", async () => {
    const dir = root(); config(dir, { instances: { current: {} } });
    for (const name of ["current", "retired"]) instance(dir, name);
    const outside = join(dir, "outside"); mkdirSync(outside);
    symlinkSync(outside, join(dir, "instances", "linked"));
    writeFileSync(join(dir, "instances", "regular-file"), "not a directory");
    writeFileSync(join(dir, "instances", "retired", "output.log"), "preserved");
    const before = readFileSync(join(dir, "fleet.yaml"), "utf8");
    const report = await collectResourceReport(dir, probe);
    expect(report.orphans?.map(row => row.names[0])).toEqual(["retired"]);
    expect(report.orphans?.[0].bytes).toBe(1024);
    expect(readFileSync(join(dir, "instances", "retired", "output.log"), "utf8")).toBe("preserved");
    expect(readFileSync(join(dir, "fleet.yaml"), "utf8")).toBe(before);
    expect(existsSync(join(dir, "workspaces", "current"))).toBe(false);
    const text = formatResourceReport(report);
    expect(text).toContain("1 not listed in fleet.yaml or classicBot.yaml");
    expect(text).toContain(join(dir, "instances", "retired"));
  });

  it.each(["missing fleet", "invalid fleet", "invalid Classic", "invalid Classic entries"])("fails closed on %s instead of declaring live dirs orphaned", async scenario => {
    const dir = root(); instance(dir, "may-be-live");
    if (scenario !== "missing fleet") config(dir);
    if (scenario === "invalid fleet") writeFileSync(join(dir, "fleet.yaml"), "instances: [\n");
    if (scenario === "invalid Classic") writeFileSync(join(dir, "classicBot.yaml"), "channels: [\n");
    if (scenario === "invalid Classic entries") writeFileSync(join(dir, "classicBot.yaml"), "channels:\n  chat: nope\n");
    const report = await collectResourceReport(dir, probe);
    expect(report.orphans).toBeNull();
    expect(report.notes.length).toBeGreaterThan(0);
    expect(formatResourceReport(report)).not.toContain("1 not listed");
  });

  it("handles absent managed directories without creating them", async () => {
    const dir = root(); config(dir);
    const report = await collectResourceReport(dir, probe);
    expect(report.workspaces).toEqual([]); expect(report.orphans).toEqual([]);
    expect(existsSync(join(dir, "workspaces"))).toBe(false);
    expect(existsSync(join(dir, "instances"))).toBe(false);
  });

  it("keeps failed probes unknown and continues other measurements", async () => {
    const dir = root(); config(dir, { instances: { a: {}, b: {} } });
    const report = await collectResourceReport(dir, { ...probe, diskUsage: async path => {
      if (path.endsWith("/a")) throw new Error("permission denied"); return 4096;
    } });
    expect(report.workspaces.find(row => row.names.includes("a"))?.bytes).toBeNull();
    expect(report.workspaces.find(row => row.names.includes("b"))?.bytes).toBe(4096);
    expect(formatResourceReport(report)).toContain("unknown (unreadable");
  });

  it("starts at most two asynchronous scans and enforces one shared deadline", async () => {
    const dir = root(); config(dir, { instances: { a: {}, b: {}, c: {} } });
    let now = 0; let active = 0; let peak = 0;
    const releases: Array<() => void> = [];
    const diskUsage = vi.fn((_path: string, timeout: number) => new Promise<number>(resolve => {
      expect(timeout).toBe(100); active++; peak = Math.max(peak, active);
      releases.push(() => { active--; resolve(512); });
    }));
    const pending = collectResourceReport(dir, { ...probe, diskUsage, now: () => now, budgetMs: 100 });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(active).toBe(2); expect(peak).toBe(2);
    now = 101; for (const release of releases) release();
    const report = await pending;
    expect(diskUsage).toHaveBeenCalledTimes(2);
    expect(report.workspaces.filter(row => row.bytes === null)).toHaveLength(1);
  });

  it("drops orphan classification when a registry changes while scanning", async () => {
    const dir = root(); config(dir); instance(dir, "newly-registered");
    const report = await collectResourceReport(dir, { ...probe, diskUsage: async () => {
      config(dir, { instances: { "newly-registered": {} } }); return 1024;
    } });
    expect(report.orphans).toBeNull();
    expect(report.notes).toContain("A registry changed during the scan; repeat the report before judging unregistered directories");
  });

  it("measures allocated storage with real du and does not follow descendant symlinks", async () => {
    const dir = root(); const workspace = join(dir, "workspace $(literal); 研一"); mkdirSync(workspace);
    const outside = join(dir, "large-source"); mkdirSync(outside);
    writeFileSync(join(outside, "large"), Buffer.alloc(4 * MiB, 1));
    symlinkSync(outside, join(workspace, "linked"));
    const sparse = openSync(join(workspace, "sparse"), "w"); ftruncateSync(sparse, 64 * MiB); closeSync(sparse);
    const bytes = await probeDiskUsage(workspace, 2000);
    expect(bytes).not.toBeNull(); expect(bytes!).toBeLessThan(MiB);
    expect(await probeDiskUsage(join(dir, "missing"), 2000)).toBeNull();
    expect(readFileSync(join(outside, "large")).length).toBe(4 * MiB);
  });

  it("kills a hung scan while the parent event loop remains responsive", async () => {
    const dir = root(); const binary = join(dir, "slow-du");
    writeFileSync(binary, `#!${process.execPath}\nsetInterval(() => {}, 50);\n`); chmodSync(binary, 0o755);
    const started = Date.now();
    let settled = false;
    const pending = probeDiskUsage(dir, 500, binary).then(value => { settled = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(await pending).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it.each(["en", "zh-TW"] as const)("renders localized memory, zero swap, unknown size and orphan warnings in %s", async locale => {
    setLocale(locale);
    const dir = root(); config(dir, { instances: { missing: {} } }); instance(dir, "retired");
    const report = await collectResourceReport(dir, { memory: () => ({ ...memory(), swapTotalBytes: 0, swapFreeBytes: 0 }), diskUsage: async () => null });
    const text = formatResourceReport(report);
    expect(text).toContain(locale === "en" ? "Storage and host resources" : "磁碟與主機資源");
    expect(text).toContain(locale === "en" ? "6.0 MiB available / 8.0 MiB total" : "可用 6.0 MiB／總計 8.0 MiB");
    expect(text).toContain(locale === "en" ? "0 B free / 0 B total" : "剩餘 0 B／總計 0 B");
    expect(text).toContain(locale === "en" ? "unknown (unreadable" : "未知（無法讀取");
    expect(text).not.toMatch(/resources\.[a-z_]+/);
  });

  it("escapes control characters in filenames rather than injecting terminal controls", async () => {
    const dir = root(); config(dir); instance(dir, "bad\u001b[31m\nname");
    const text = formatResourceReport(await collectResourceReport(dir, probe));
    expect(text).not.toContain("\u001b[31m"); expect(text).toContain("\\u001b[31m\\u000aname");
  });

  it("has every resource label in both locales without an English fallback in zh-TW", () => {
    const keys = ["title", "memory", "memory_available", "memory_free", "swap", "swap_free", "swap_unknown", "workspace", "size_unknown", "orphans", "orphans_count", "orphans_unknown", "registry_unknown", "registry_changed", "scan_unknown", "note", "report_unknown"];
    for (const locale of ["en", "zh-TW"] as const) {
      setLocale(locale);
      for (const key of keys) {
        const text = t(`resources.${key}`, "1", "2", "3");
        expect(text).not.toBe(`resources.${key}`);
        if (locale === "zh-TW") expect(text).toMatch(/[\u3400-\u9fff]/u);
      }
    }
  });

  it("integrates resources into the real doctor collector and formatter, with best-effort failure", async () => {
    const dir = root(); config(dir, { defaults: { backend: "mock" }, instances: {} });
    const service = { installed: false, path: null, manager: "systemd --user" as const, enabled: null, active: null };
    const deps = { env: { TERM: "xterm" }, processAlive: () => false, connectSocket: async () => false,
      run: () => ({ status: 0, stdout: "tmux 3.7", stderr: "", pid: 1, signal: null, output: [] }) };
    const report = await collectDoctorReport(dir, service, { ...deps, collectResources: () => collectResourceReport(dir, probe) });
    expect(report.checks).toContainEqual(expect.objectContaining({ section: "Resources", label: "Host RAM", detail: "6.0 MiB available / 8.0 MiB total" }));
    expect(formatDoctorReport(report)).toContain("Storage and host resources");
    const failed = await collectDoctorReport(dir, service, { ...deps, collectResources: async () => { throw new Error("broken probe"); } });
    expect(failed.checks).toContainEqual(expect.objectContaining({ section: "Resources", status: "warn", detail: "Resource report unavailable; no files were changed" }));
  });
});
