/**
 * #749 items 2 and 3.
 *
 * 2. The daemon's `context_lost` (it gave up resuming after repeated failed starts and began a fresh conversation,
 *    #737) had no listener: the only trace was an error line in daemon.log. The real InstanceLifecycle handler is
 *    driven here with an inert topic, log and webhook.
 * 3. deriveSpawnConcurrency was fed `os.cpus().length` — the host's cores, not the container's or the systemd slice's
 *    quota. effectiveCpuCount reads the cgroup quota; it is driven with a fake /proc and /sys.
 */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { freemem } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { t } from "../src/locale.js";
import { LOG_EVENT_TYPES } from "../src/log-service.js";

vi.mock("../src/cpu-quota.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cpu-quota.js")>();
  // With deps: the real function (the unit tests below). Without: the fleet's call, pinned to a 3-CPU quota.
  return { ...actual, effectiveCpuCount: vi.fn((deps?: Parameters<typeof actual.effectiveCpuCount>[0]) => deps ? actual.effectiveCpuCount(deps) : 3) };
});
const { effectiveCpuCount, cgroupCpuQuota } = await import("../src/cpu-quota.js");

function lifecycle(opts: { classic?: boolean; planned?: boolean; general?: string | null } = {}) {
  const notifyInstanceTopic = vi.fn(() => true);
  const insert = vi.fn();
  const webhookEmit = vi.fn();
  const general = opts.general === undefined ? "general" : opts.general;
  const instances: Record<string, Record<string, unknown>> = { worker: { backend: "claude-code" } };
  if (general) instances[general] = { ...(instances[general] ?? {}), general_topic: true };
  const lc = new InstanceLifecycle({
    fleetConfig: { instances, defaults: {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    eventLog: { insert },
    isPlannedRestart: () => opts.planned === true,
    stormSuppressed: () => true,
    isClassicInstance: (n: string) => opts.classic === true && n === "worker",
    notifyInstanceTopic,
    webhookEmit, clearCancelButton() {}, checkModelFailover() {}, setTopicIcon() {},
    restartSingleInstance: vi.fn(async () => {}),
  } as unknown as LifecycleContext);
  const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle() {} });
  lc.attachContextLostHandler("worker", daemon as never);
  return { daemon, notifyInstanceTopic, insert, webhookEmit };
}

describe("context_lost reaches the user (#749 item 2)", () => {
  it("posts in the instance's topic and in General, logs it, and fires the webhook", () => {
    const { daemon, notifyInstanceTopic, insert, webhookEmit } = lifecycle();
    daemon.emit("context_lost", "worker", "resume_repeatedly_failed", 3);
    expect(notifyInstanceTopic).toHaveBeenCalledWith("worker", t("inst.context_lost", "worker", "3"));
    expect(notifyInstanceTopic).toHaveBeenCalledWith("general", t("inst.context_lost_general", "worker", "3"));
    expect(notifyInstanceTopic).toHaveBeenCalledTimes(2);
    expect(insert).toHaveBeenCalledWith("worker", "context_lost", { reason: "resume_repeatedly_failed", attempts: 3 });
    expect(webhookEmit).toHaveBeenCalledWith("context_lost", "worker", { reason: "resume_repeatedly_failed", attempts: 3 });
    expect(t("inst.context_lost", "worker", "3")).toMatch(/worker.*3.*fresh/);
  });

  it("is not swallowed by a planned restart or a storm window — a restart is when people expect continuity", () => {
    const { daemon, notifyInstanceTopic } = lifecycle({ planned: true });
    daemon.emit("context_lost", "worker", "resume_repeatedly_failed", 3);
    expect(notifyInstanceTopic).toHaveBeenCalledTimes(2);
  });

  it("a ClassicBot's notice goes to General only, never to the end user's chat", () => {
    const { daemon, notifyInstanceTopic } = lifecycle({ classic: true });
    daemon.emit("context_lost", "worker", "resume_repeatedly_failed", 3);
    expect(notifyInstanceTopic).toHaveBeenCalledTimes(1);
    expect(notifyInstanceTopic).toHaveBeenCalledWith("general", t("inst.context_lost_general", "worker", "3"));
  });

  it("General losing its own context gets one notice, not two", () => {
    const { daemon, notifyInstanceTopic } = lifecycle({ general: "worker" });
    daemon.emit("context_lost", "worker", "resume_repeatedly_failed", 3);
    expect(notifyInstanceTopic).toHaveBeenCalledTimes(1);
    expect(notifyInstanceTopic).toHaveBeenCalledWith("worker", t("inst.context_lost", "worker", "3"));
  });

  it("no General configured: the instance's own topic still hears it", () => {
    const { daemon, notifyInstanceTopic } = lifecycle({ general: null });
    daemon.emit("context_lost", "worker", "resume_repeatedly_failed");
    expect(notifyInstanceTopic).toHaveBeenCalledTimes(1);
    expect(notifyInstanceTopic).toHaveBeenCalledWith("worker", t("inst.context_lost", "worker", "?"));
  });

  it("is attached before Daemon.start — the startup spawn is where the escape hatch fires", () => {
    // attachIncidentHandlers runs only after start() resolves; a listener there would miss every fleet-start loss.
    const src = readFileSync(new URL("../src/instance-lifecycle.ts", import.meta.url), "utf8");
    const attach = src.indexOf("this.attachContextLostHandler(name, daemon);");
    const start = src.indexOf("await InstanceLifecycle.startOrDispose(daemon, name");
    expect(attach).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(attach);
  });

  it("shows on the Log tab", () => {
    expect(LOG_EVENT_TYPES.has("context_lost")).toBe(true);
    const panel = readFileSync(new URL("../src/ui/panel-log.js", import.meta.url), "utf8");
    expect(panel.match(/ev_context_lost:/g)).toHaveLength(2);
  });
});

type Files = Record<string, string>;
const fs = (files: Files) => (path: string) => {
  if (!(path in files)) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
  return files[path];
};
const linux = (files: Files, parallelism = 16) =>
  ({ platform: "linux" as const, availableParallelism: () => parallelism, readFile: fs(files) });

describe("effectiveCpuCount reads the cgroup quota (#749 item 3)", () => {
  it("cgroup v2 container: cpu.max at the namespace root", () => {
    expect(effectiveCpuCount(linux({ "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/cpu.max": "200000 100000\n" }))).toBe(2);
  });

  it("cgroup v2 systemd slice: the tightest level from the process's cgroup up to the root wins", () => {
    const files = {
      "/proc/self/cgroup": "0::/system.slice/agend.service\n",
      "/sys/fs/cgroup/system.slice/agend.service/cpu.max": "max 100000\n",
      "/sys/fs/cgroup/system.slice/cpu.max": "300000 100000\n",
    };
    expect(effectiveCpuCount(linux(files))).toBe(3);
    expect(cgroupCpuQuota({ readFile: fs({ ...files, "/sys/fs/cgroup/system.slice/agend.service/cpu.max": "400000 100000" }) }))
      .toBe(3);
  });

  it("a fractional quota rounds up, never to zero", () => {
    expect(effectiveCpuCount(linux({ "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/cpu.max": "150000 100000" }))).toBe(2);
    expect(effectiveCpuCount(linux({ "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/cpu.max": "10000 100000" }))).toBe(1);
  });

  it("no quota anywhere: the affinity count, which is what availableParallelism reports", () => {
    expect(effectiveCpuCount(linux({ "/proc/self/cgroup": "0::/user.slice\n", "/sys/fs/cgroup/user.slice/cpu.max": "max 100000" }, 6))).toBe(6);
    expect(effectiveCpuCount(linux({}, 6)), "no /proc at all").toBe(6);
  });

  it("an affinity mask tighter than the quota still binds", () => {
    expect(effectiveCpuCount(linux({ "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/cpu.max": "800000 100000" }, 2))).toBe(2);
  });

  it("cgroup v1: cfs quota over period; -1 is unlimited", () => {
    const cg = "12:cpu,cpuacct:/docker/abc\n11:memory:/docker/abc\n";
    expect(effectiveCpuCount(linux({
      "/proc/self/cgroup": cg,
      "/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us": "250000\n",
      "/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us": "100000\n",
    }))).toBe(3);
    expect(effectiveCpuCount(linux({
      "/proc/self/cgroup": cg,
      "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1",
      "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000",
    }, 5))).toBe(5);
  });

  it("a path outside the cgroup namespace only consults the mount root", () => {
    const read = vi.fn(fs({ "/proc/self/cgroup": "0::/../../other\n", "/sys/fs/cgroup/cpu.max": "100000 100000" }));
    expect(cgroupCpuQuota({ readFile: read })).toBe(1);
    expect(read.mock.calls.map(c => c[0])).toEqual(["/proc/self/cgroup", "/sys/fs/cgroup/cpu.max"]);
  });

  it("garbage and other platforms fall back to the affinity count", () => {
    expect(effectiveCpuCount(linux({ "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/cpu.max": "lots 0" }, 4))).toBe(4);
    expect(effectiveCpuCount({ platform: "darwin", availableParallelism: () => 8, readFile: () => { throw new Error("unused"); } })).toBe(8);
  });
});

describe("the fleet's startup concurrency uses it", () => {
  it("spawnConcurrency feeds effectiveCpuCount, not the host's cpus()", async () => {
    const { FleetManager, deriveSpawnConcurrency } = await import("../src/fleet-manager.js");
    const fm = Object.create(FleetManager.prototype) as { fleetConfig: unknown; spawnConcurrency(): number };
    fm.fleetConfig = { defaults: {}, instances: {} };
    // Mocked above to a 3-CPU quota; enough free memory and an unmocked cpus() would allow more.
    expect(fm.spawnConcurrency()).toBe(deriveSpawnConcurrency(Math.round(freemem() / (1024 * 1024)), 3));
    expect(effectiveCpuCount).toHaveBeenCalledWith();
  });
});
