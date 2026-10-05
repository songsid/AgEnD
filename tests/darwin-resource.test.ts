import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mocks = vi.hoisted(() => ({ execFile: vi.fn(), free: vi.fn(() => 1024) }));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), platform: () => "darwin", totalmem: () => 16_000 * 1024 ** 2, freemem: mocks.free }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFile: mocks.execFile }));
import { collectResourceReport, formatResourceReport } from "../src/resource-report.js";
import { setLocale, t } from "../src/locale.js";
afterEach(() => { setLocale("en"); vi.useRealTimers(); mocks.execFile.mockReset(); });
it("doctor/status collector uses the async native reader, then displays failed samples as unknown in both locales", async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), "darwin-resource-")); writeFileSync(join(dir, "fleet.yaml"), "instances: {}\n");
  let fail = false;
  const healthy = readFileSync(new URL("./fixtures/darwin-memory/vm-stat-dts-16k.txt", import.meta.url), "utf8");
  mocks.execFile.mockImplementation((file, _args, _options, callback) => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    queueMicrotask(() => { callback(fail ? new Error("unavailable") : null, file.endsWith("vm_stat") ? healthy : "vm.swapusage: total = 0.00M used = 0.00M free = 0.00M"); child.emit("close"); });
    return child;
  });
  try {
    const report = await collectResourceReport(dir, { diskUsage: async () => 0 });
    expect(report.memory).toMatchObject({ availableKind: "available", availableBytes: 3121.6875 * 1024 ** 2, swapTotalBytes: 0 });
    expect(mocks.execFile).toHaveBeenCalledTimes(2); expect(mocks.free).not.toHaveBeenCalled();
    fail = true; await vi.advanceTimersByTimeAsync(30_000);
    const unknown = await collectResourceReport(dir, { diskUsage: async () => 0 });
    expect(unknown.memory).toMatchObject({ availableKind: "unknown", availableBytes: null, swapFreeBytes: null });
    for (const locale of ["en", "zh-TW"] as const) {
      setLocale(locale); expect(formatResourceReport(unknown)).toContain(t("resources.memory_unknown", "15.6 GiB"));
    }
    expect(mocks.execFile).toHaveBeenCalledTimes(4); expect(mocks.free).not.toHaveBeenCalled();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
