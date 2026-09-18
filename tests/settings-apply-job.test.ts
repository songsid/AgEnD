import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPLY_FLEET_TARGET,
  APPLY_JOB_DEADLINE_MS,
  APPLY_JOB_RETENTION_MS,
  ApplyJobStore,
  viewOf,
} from "../src/apply-job.js";
import { FleetManager } from "../src/fleet-manager.js";
import type { ApplyJob } from "../src/apply-job.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";

const dirs: string[] = [];
const DEAD_PID = 999_999;

/** Re-stamp a job as the work of a process that is no longer here, which is
 * what "left behind by the previous fleet" means on disk. */
function asPreviousProcess(store: ApplyJobStore, id: string): void {
  store.update(id, job => { job.pid = DEAD_PID; });
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-apply-job-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── The store ───────────────────────────────────────────────────────────────

describe("apply job store", () => {
  it("survives the process that created it", () => {
    const dir = tempDir();
    const first = new ApplyJobStore(dir);
    const job = first.create("key-abcdefgh", [{ target: "one", kind: "restart" }]);
    first.setTargetStatus(job.id, "one", "running");

    // A separate store on the same data dir is what the replacement process is.
    const replacement = new ApplyJobStore(dir);

    expect(replacement.get(job.id)).toMatchObject({
      id: job.id,
      key: "key-abcdefgh",
      status: "running",
      targets: [{ target: "one", kind: "restart", status: "running" }],
    });
    expect(existsSync(join(dir, "settings-apply-jobs.json"))).toBe(true);
  });

  it("is findable by key from another process before any work has happened", () => {
    const dir = tempDir();
    const creating = new ApplyJobStore(dir);
    const job = creating.create("key-before-any-work", [{ target: "one", kind: "restart" }]);

    // The process dies here — between minting the job and the first transition.
    // The retry lands on the replacement, which must recognise the key.
    const replacement = new ApplyJobStore(dir);

    expect(replacement.findByKey("key-before-any-work")?.id).toBe(job.id);
  });

  it("settles a job the restart finished, and says the restart finished it", () => {
    const dir = tempDir();
    const before = new ApplyJobStore(dir);
    const job = before.create("key-restarted", [
      { target: "one", kind: "restart" },
      { target: "two", kind: "hot" },
    ]);
    before.setTargetStatus(job.id, "one", "running");
    asPreviousProcess(before, job.id);

    const after = new ApplyJobStore(dir);
    const settled = after.settleAfterRestart();

    expect(settled.map(item => item.id)).toEqual([job.id]);
    const reread = after.get(job.id)!;
    expect(reread.status).toBe("done");
    expect(reread.finishedAt).toBeGreaterThan(0);
    for (const row of reread.targets) {
      expect(row.status).toBe("done");
      expect(row.settled_by).toBe("fleet-restart");
    }
    // Persisted, so a second new process agrees.
    expect(new ApplyJobStore(dir).get(job.id)!.status).toBe("done");
  });

  it("leaves this process's own in-flight job alone", () => {
    // The health server answers a little before startup finishes, so an apply
    // can already be running here when the settle pass runs. Declaring it
    // finished by a restart would report someone else's outcome.
    const dir = tempDir();
    const store = new ApplyJobStore(dir);
    const mine = store.create("key-started-here", [{ target: "one", kind: "restart" }]);
    store.setTargetStatus(mine.id, "one", "running");

    expect(store.settleAfterRestart()).toEqual([]);
    expect(store.get(mine.id)!.status).toBe("running");
    expect(store.get(mine.id)!.targets[0]!.settled_by).toBeUndefined();
  });

  it("leaves a job that already finished alone", () => {
    const dir = tempDir();
    const store = new ApplyJobStore(dir);
    const job = store.create("key-finished", [{ target: "one", kind: "hot" }]);
    store.finish(job.id);
    asPreviousProcess(store, job.id);

    expect(new ApplyJobStore(dir).settleAfterRestart()).toEqual([]);
    expect(store.get(job.id)!.targets[0]!.settled_by).toBe("no-change");
  });

  it("returns the same job for a repeated key and a new one for a fresh key", () => {
    const store = new ApplyJobStore(tempDir());
    const first = store.create("key-repeated", []);

    expect(store.findByKey("key-repeated")!.id).toBe(first.id);
    expect(store.findByKey("key-other")).toBeNull();
  });

  it("stops honouring a key once it has aged out", () => {
    let now = 1_000_000;
    const store = new ApplyJobStore(tempDir(), () => now);
    store.create("key-aging", []);

    now += APPLY_JOB_RETENTION_MS + 1;

    expect(store.findByKey("key-aging")).toBeNull();
  });

  it("ignores an unreadable jobs file instead of blocking the apply", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "settings-apply-jobs.json"), "{ not json");

    const store = new ApplyJobStore(dir);

    expect(store.all()).toEqual([]);
    expect(() => store.create("key-recovered", [])).not.toThrow();
  });

  it("says so when the job cannot be written down", () => {
    const dir = tempDir();
    // A file where the data dir should be: every write under it fails ENOTDIR,
    // which is what a full or read-only data dir looks like from here.
    const notADir = join(dir, "blocked");
    writeFileSync(notADir, "");
    const warn = vi.fn();
    const store = new ApplyJobStore(notADir, Date.now, { warn });

    store.create("key-unwritable", []);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      expect.stringContaining("could not be persisted"),
    );
  });

  it("marks a job failed when any target failed", () => {
    const store = new ApplyJobStore(tempDir());
    const job = store.create("key-partial", [
      { target: "one", kind: "restart" },
      { target: "two", kind: "hot" },
    ]);
    store.setTargetStatus(job.id, "one", "failed", "boom");

    store.finish(job.id);

    expect(store.get(job.id)!.status).toBe("failed");
    expect(store.get(job.id)!.targets[1]!.status).toBe("done");
  });
});

describe("apply job deadline", () => {
  it("says how long it has been instead of spinning silently", () => {
    const store = new ApplyJobStore(tempDir());
    const job = store.create("key-slow", [{ target: "one", kind: "restart" }]);

    const inTime = viewOf(job, job.startedAt + 5_000);
    expect(inTime.overdue).toBe(false);
    expect(inTime.message).toBe("");

    const late = viewOf(job, job.startedAt + APPLY_JOB_DEADLINE_MS + 7_000);
    expect(late.overdue).toBe(true);
    expect(late.message).toBe("Still restarting (127s)");
  });

  it("never calls a finished job overdue, however long the page was closed", () => {
    const store = new ApplyJobStore(tempDir());
    const job = store.create("key-done", []);
    store.finish(job.id);

    const view = viewOf(store.get(job.id)!, Date.now() + 10 * APPLY_JOB_DEADLINE_MS);

    expect(view.overdue).toBe(false);
    expect(view.elapsed_ms).toBeLessThan(APPLY_JOB_DEADLINE_MS);
  });
});

// ── The HTTP surface ────────────────────────────────────────────────────────

function request(
  path: string,
  ctx: SettingsApiContext,
  method = "GET",
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as EventEmitter & {
      method: string; headers: Record<string, string>; destroy(): void;
    };
    req.method = method;
    req.headers = opts.headers ?? {};
    req.destroy = () => undefined;
    let status = 0;
    const res = {
      writeHead(code: number) { status = code; },
      end(payload: string) { resolve({ status, body: JSON.parse(payload) as Record<string, unknown> }); },
    };
    try {
      expect(handleSettingsRequest(req as never, res as never, new URL(`http://localhost${path}`), ctx)).toBe(true);
      queueMicrotask(() => {
        if (opts.body !== undefined) req.emit("data", Buffer.from(JSON.stringify(opts.body)));
        req.emit("end");
      });
    } catch (err) { reject(err); }
  });
}

function apiContext(dir: string) {
  const store = new ApplyJobStore(dir);
  const started: string[] = [];
  const ctx = {
    fleetConfig: { defaults: {}, instances: {} },
    configPath: join(dir, "fleet.yaml"),
    dataDir: dir,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    getRawFleetConfig: () => ({}),
    saveFleetConfig: vi.fn(),
    lifecycle: { isPaused: () => false, pause: vi.fn(), wake: vi.fn() },
    applyJobs: store,
    startSettingsApply: (key: string) => {
      started.push(key);
      const existing = store.findByKey(key);
      if (existing) return { job: existing, reused: true };
      return { job: store.create(key, [{ target: "one", kind: "hot" }]), reused: false };
    },
  } as unknown as SettingsApiContext;
  return { ctx, store, started };
}

describe("POST /api/settings/apply", () => {
  it("answers with a job", async () => {
    const { ctx } = apiContext(tempDir());

    const res = await request("/api/settings/apply", ctx, "POST", {
      headers: { "idempotency-key": "key-first-apply" },
    });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "running", key: "key-first-apply" });
    expect(res.body.id).toBeTruthy();
    expect(res.body).toHaveProperty("targets");
  });

  it("returns the original job when the client retries the same key", async () => {
    const dir = tempDir();
    const { ctx, store } = apiContext(dir);

    const first = await request("/api/settings/apply", ctx, "POST", {
      headers: { "idempotency-key": "key-retried-once" },
    });
    const retry = await request("/api/settings/apply", ctx, "POST", {
      headers: { "idempotency-key": "key-retried-once" },
    });

    expect(retry.body.id).toBe(first.body.id);
    expect(retry.status).toBe(200);
    // The point of the key: no second apply was minted behind the retry.
    expect(store.all()).toHaveLength(1);
  });

  it("accepts the key in the body for clients that cannot set headers", async () => {
    const { ctx, store } = apiContext(tempDir());

    const res = await request("/api/settings/apply", ctx, "POST", {
      body: { idempotency_key: "key-from-body" },
    });

    expect(res.status).toBe(202);
    expect(store.all()).toHaveLength(1);
  });

  it("answers 409 with the running job when a reconcile already owns the slot", async () => {
    const dir = tempDir();
    const store = new ApplyJobStore(dir);
    const running = store.create("key-already-running", [{ target: "one", kind: "restart" }]);
    const ctx = {
      fleetConfig: { defaults: {}, instances: {} },
      configPath: join(dir, "fleet.yaml"),
      dataDir: dir,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      getRawFleetConfig: () => ({}),
      saveFleetConfig: vi.fn(),
      lifecycle: { isPaused: () => false, pause: vi.fn(), wake: vi.fn() },
      applyJobs: store,
      startSettingsApply: () => ({ busy: running }),
    } as unknown as SettingsApiContext;

    const res = await request("/api/settings/apply", ctx, "POST", {
      headers: { "idempotency-key": "key-second-attempt" },
    });

    expect(res.status).toBe(409);
    expect(res.body.running_job_id).toBe(running.id);
  });

  it("refuses to mint a job without a usable key", async () => {
    const { ctx, store } = apiContext(tempDir());

    const missing = await request("/api/settings/apply", ctx, "POST", {});
    const tooShort = await request("/api/settings/apply", ctx, "POST", {
      headers: { "idempotency-key": "short" },
    });

    expect(missing.status).toBe(400);
    expect(tooShort.status).toBe(400);
    expect(store.all()).toEqual([]);
  });
});

describe("GET /api/settings/apply/:jobId", () => {
  it("is the authority, including for a job this process did not start", async () => {
    const dir = tempDir();
    const previousProcess = new ApplyJobStore(dir);
    const job = previousProcess.create("key-earlier-process", [{ target: "one", kind: "restart" }]);
    previousProcess.setTargetStatus(job.id, "one", "running");
    asPreviousProcess(previousProcess, job.id);
    // The replacement process: a fresh store over the same data dir.
    const { ctx } = apiContext(dir);
    (ctx.applyJobs as ApplyJobStore).settleAfterRestart();

    const res = await request(`/api/settings/apply/${job.id}`, ctx);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: job.id, status: "done" });
    expect((res.body.targets as Array<Record<string, unknown>>)[0]).toMatchObject({
      status: "done", settled_by: "fleet-restart",
    });
  });

  it("404s an id it has never seen", async () => {
    const { ctx } = apiContext(tempDir());

    const res = await request("/api/settings/apply/00000000-0000-0000-0000-000000000000", ctx);

    expect(res.status).toBe(404);
  });
});

describe("the settings page tells the truth about a restart it cannot perform", () => {
  const html = readFileSync(
    join(process.cwd(), "src", "ui", "settings.html"),
    "utf8",
  );

  it("renders restart-required as its own terminal state, not as success", () => {
    expect(html).toContain('row.status === "restart-required" ? "🔄🔄"');
    expect(html).toContain('row.status === "restart-required" ? t("applyRestartNeeded")');
    expect(html).toContain('applyRestartNeeded: "Saved — restart AgEnD to apply"');
    expect(html).toContain("applyRestartHint");
    // The panel must not fade away while a restart is still owed.
    expect(html).toContain("if (!needsRestart) setTimeout");
  });

  it("names the rows the reconcile found nothing to do", () => {
    expect(html).toContain('row.settled_by === "no-change"');
  });

  it("tells the user to retry when the fleet is already reloading", () => {
    expect(html).toContain("started.status === 409");
    expect(html).toContain("applyBusy");
  });
});

// ── Real wiring: the rows are the reconcile's own work ──────────────────────

function fleetWithInstance(dir: string, body: string[]): { fm: FleetManager; configPath: string } {
  const configPath = join(dir, "fleet.yaml");
  writeFileSync(configPath, body.join("\n"));
  const fm = new FleetManager(dir);
  fm.loadConfig(configPath);
  (fm as unknown as { startupComplete: boolean }).startupComplete = true;
  return { fm, configPath };
}

describe("a Settings apply drives the real reconcile", () => {
  it("reports a hot change as hot and finishes the job", async () => {
    const dir = tempDir();
    const { fm } = fleetWithInstance(dir, [
      "instances:", "  one:", "    working_directory: /tmp/one", "",
    ]);
    const runtimeConfig = structuredClone(fm.fleetConfig!.instances.one!);
    fm.lifecycle.daemons.set("one", {
      getConfigSnapshot: () => runtimeConfig,
      applyConfigUpdate: vi.fn(),
    } as never);
    const stop = vi.spyOn(fm, "stopInstance").mockResolvedValue(undefined);
    fm.fleetConfig!.instances.one!.tool_progress = "verbose";

    expect(fm.planConfigApply()).toEqual([{ target: "one", kind: "hot" }]);
    const { job } = fm.startSettingsApply("key-hot-change") as { job: ApplyJob };

    expect(job.targets).toEqual([{ target: "one", kind: "hot", status: "pending" }]);
    await vi.waitFor(() => expect(fm.applyJobs.get(job.id)!.status).toBe("done"));
    expect(fm.applyJobs.get(job.id)!.targets[0]).toMatchObject({ target: "one", kind: "hot", status: "done" });
    expect(stop).not.toHaveBeenCalled();
  });

  it("reports a cold change as a restart and stops the instance", async () => {
    const dir = tempDir();
    const { fm, configPath } = fleetWithInstance(dir, [
      "instances:", "  one:", "    working_directory: /tmp/one", "",
    ]);
    const runtimeConfig = structuredClone(fm.fleetConfig!.instances.one!);
    fm.lifecycle.daemons.set("one", { getConfigSnapshot: () => runtimeConfig } as never);
    const stop = vi.spyOn(fm, "stopInstance").mockResolvedValue(undefined);
    vi.spyOn(fm as unknown as {
      startInstanceUnattended(...args: unknown[]): Promise<void>;
    }, "startInstanceUnattended").mockResolvedValue(undefined);
    const frames: unknown[][] = [];
    vi.spyOn(fm, "emitSseEvent").mockImplementation((event, data) => {
      if (event === "apply_progress") frames.push([event, structuredClone(data)]);
    });
    writeFileSync(configPath, [
      "instances:", "  one:", "    working_directory: /tmp/one", "    backend: codex", "",
    ].join("\n"));
    fm.fleetConfig!.instances.one!.backend = "codex";

    expect(fm.planConfigApply()).toEqual([{ target: "one", kind: "restart" }]);
    const { job } = fm.startSettingsApply("key-cold-change") as { job: ApplyJob };
    await vi.waitFor(() => expect(fm.applyJobs.get(job.id)!.status).toBe("done"));
    expect(stop).toHaveBeenCalledWith("one");
    expect(fm.applyJobs.get(job.id)!.targets[0]!.status).toBe("done");
    // The row has to have been reported in flight. Asserting only the terminal
    // state would pass even if the reconcile never said anything, because
    // finishing a job tidies leftover rows to done.
    const seen = frames.flatMap(([, data]) => (data as { targets: Array<{ target: string; status: string }> }).targets)
      .filter(row => row.target === "one")
      .map(row => row.status);
    expect(seen).toContain("running");
    expect(seen.indexOf("running")).toBeLessThan(seen.lastIndexOf("done"));
  });

  it("pushes apply_progress frames without making them the authority", async () => {
    const dir = tempDir();
    const { fm } = fleetWithInstance(dir, [
      "instances:", "  one:", "    working_directory: /tmp/one", "",
    ]);
    const runtimeConfig = structuredClone(fm.fleetConfig!.instances.one!);
    fm.lifecycle.daemons.set("one", {
      getConfigSnapshot: () => runtimeConfig,
      applyConfigUpdate: vi.fn(),
    } as never);
    const emit = vi.spyOn(fm, "emitSseEvent").mockImplementation(() => {});
    fm.fleetConfig!.instances.one!.tool_progress = "verbose";

    const { job } = fm.startSettingsApply("key-sse-frames") as { job: ApplyJob };
    await vi.waitFor(() => expect(fm.applyJobs.get(job.id)!.status).toBe("done"));

    const frames = emit.mock.calls.filter(([event]) => event === "apply_progress");
    expect(frames.length).toBeGreaterThan(1);
    // The frame is a view of the job, and carries no id of its own to resume from.
    expect(frames[0]![1]).toMatchObject({ id: job.id });
    expect(frames[0]![1]).not.toHaveProperty("event_id");
  });

  it("does not run a second reconcile for a retried key", async () => {
    const dir = tempDir();
    const { fm } = fleetWithInstance(dir, [
      "instances:", "  one:", "    working_directory: /tmp/one", "",
    ]);
    fm.lifecycle.daemons.set("one", {
      getConfigSnapshot: () => structuredClone(fm.fleetConfig!.instances.one!),
      applyConfigUpdate: vi.fn(),
    } as never);
    const reconcile = vi.spyOn(fm as unknown as {
      reconcileInstances(): Promise<void>;
    }, "reconcileInstances").mockResolvedValue(undefined);

    const { job: first } = fm.startSettingsApply("key-double-submit") as { job: ApplyJob };
    const retry = fm.startSettingsApply("key-double-submit") as { job: ApplyJob };

    expect(retry.job.id).toBe(first.id);
    await vi.waitFor(() => expect(fm.applyJobs.get(first.id)!.status).toBe("done"));
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(fm.applyJobs.all()).toHaveLength(1);
  });

  it("plans a fleet row when the fleet-level config moved under a running process", () => {
    const dir = tempDir();
    const { fm } = fleetWithInstance(dir, [
      "defaults:", "  backend: claude-code", "instances: {}", "",
    ]);
    (fm as unknown as { finishStartup(): void }).finishStartup();

    expect(fm.planConfigApply()).toEqual([]);
    fm.fleetConfig!.defaults!.backend = "codex";

    expect(fm.planConfigApply()).toEqual([{ target: APPLY_FLEET_TARGET, kind: "restart" }]);
  });

  it("refuses a second, different apply while one is still running", async () => {
    const dir = tempDir();
    const { fm } = fleetWithInstance(dir, [
      "instances:", "  one:", "    working_directory: /tmp/one", "",
    ]);
    fm.lifecycle.daemons.set("one", {
      getConfigSnapshot: () => structuredClone(fm.fleetConfig!.instances.one!),
      applyConfigUpdate: vi.fn(),
    } as never);
    let release!: () => void;
    const reconcile = vi.spyOn(fm as unknown as {
      reconcileInstances(): Promise<void>;
    }, "reconcileInstances").mockImplementation(() => new Promise(resolve => { release = () => resolve(); }));

    const first = fm.startSettingsApply("key-concurrent-one") as { job: ApplyJob };
    await Promise.resolve();
    const second = fm.startSettingsApply("key-concurrent-two") as { busy: ApplyJob | null };

    // Two reconciles would stop and start the same agent in parallel.
    expect("busy" in second).toBe(true);
    expect(second.busy?.id).toBe(first.job.id);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(fm.applyJobs.all()).toHaveLength(1);

    release();
    await vi.waitFor(() => expect(fm.applyJobs.get(first.job.id)!.status).toBe("done"));
  });

  it("reserves the slot before the work starts, so a request in the gap is refused", () => {
    const dir = tempDir();
    const { fm } = fleetWithInstance(dir, ["instances: {}", ""]);

    const first = fm.startSettingsApply("key-gap-first") as { job: ApplyJob };
    // Synchronously after the first call: the reconcile has not begun yet,
    // because it is deferred to a microtask.
    const second = fm.startSettingsApply("key-gap-second");

    expect("busy" in second).toBe(true);
    expect((second as { busy: ApplyJob | null }).busy?.id).toBe(first.job.id);
  });

  it("coalesces a SIGHUP arriving mid-apply instead of starting a second reconcile", async () => {
    const dir = tempDir();
    const { fm } = fleetWithInstance(dir, ["instances: {}", ""]);
    let running = 0;
    let peak = 0;
    let release!: () => void;
    vi.spyOn(fm as unknown as { reconcileInstances(): Promise<void> }, "reconcileInstances")
      .mockImplementation(() => {
        running++; peak = Math.max(peak, running);
        return new Promise(resolve => { release = () => { running--; resolve(); }; });
      });

    const { job } = fm.startSettingsApply("key-sighup-overlap") as { job: ApplyJob };
    await Promise.resolve();
    (fm as unknown as { handleSighup(): void }).handleSighup();
    (fm as unknown as { handleSighup(): void }).handleSighup();

    expect(peak).toBe(1);
    release();
    await vi.waitFor(() => expect(fm.applyJobs.get(job.id)!.status).toBe("done"));
    // The coalesced signal replays once the slot is free.
    await vi.waitFor(() => expect(peak).toBe(1));
  });

  it("reports a fleet-level change as restart-required, and keeps reporting it", async () => {
    const dir = tempDir();
    const { fm, configPath } = fleetWithInstance(dir, [
      "defaults:", "  backend: claude-code", "instances: {}", "",
    ]);
    (fm as unknown as { finishStartup(): void }).finishStartup();
    writeFileSync(configPath, ["defaults:", "  backend: codex", "instances: {}", ""].join("\n"));
    fm.fleetConfig!.defaults!.backend = "codex";

    const { job } = fm.startSettingsApply("key-fleet-level-one") as { job: ApplyJob };
    await vi.waitFor(() => expect(fm.applyJobs.get(job.id)!.status).toBe("done"));

    const row = fm.applyJobs.get(job.id)!.targets.find(item => item.target === APPLY_FLEET_TARGET)!;
    // Not "done": this process is still running the old fleet-level config.
    expect(row.status).toBe("restart-required");

    // And the debt is not forgotten. A reconcile does not restart the process,
    // so the next apply must say the same thing.
    expect(fm.planConfigApply()).toEqual([{ target: APPLY_FLEET_TARGET, kind: "restart" }]);
    const { job: second } = fm.startSettingsApply("key-fleet-level-two") as { job: ApplyJob };
    await vi.waitFor(() => expect(fm.applyJobs.get(second.id)!.status).toBe("done"));
    expect(fm.applyJobs.get(second.id)!.targets.find(item => item.target === APPLY_FLEET_TARGET)!.status)
      .toBe("restart-required");
  });

  it("reports a newly added instance as it is started", async () => {
    const dir = tempDir();
    const { fm, configPath } = fleetWithInstance(dir, ["instances: {}", ""]);
    const frames: Array<{ targets: Array<{ target: string; kind: string; status: string }> }> = [];
    vi.spyOn(fm, "emitSseEvent").mockImplementation((event, data) => {
      if (event === "apply_progress") frames.push(structuredClone(data) as never);
    });
    const start = vi.spyOn(fm as unknown as {
      startInstanceUnattended(...args: unknown[]): Promise<void>;
    }, "startInstanceUnattended").mockResolvedValue(undefined);
    writeFileSync(configPath, [
      "instances:", "  fresh:", "    working_directory: /tmp/fresh", "",
    ].join("\n"));
    fm.fleetConfig!.instances.fresh = { working_directory: "/tmp/fresh" } as never;

    expect(fm.planConfigApply()).toEqual([{ target: "fresh", kind: "restart" }]);
    const { job } = fm.startSettingsApply("key-new-instance") as { job: ApplyJob };
    await vi.waitFor(() => expect(fm.applyJobs.get(job.id)!.status).toBe("done"));

    expect(start).toHaveBeenCalled();
    const seen = frames.flatMap(frame => frame.targets).filter(row => row.target === "fresh");
    expect(seen.map(row => row.status)).toContain("running");
    expect(seen.every(row => row.kind === "restart")).toBe(true);
  });

  it("marks a forecast row the reconcile found nothing to do as no-change", async () => {
    const dir = tempDir();
    const { fm } = fleetWithInstance(dir, ["instances: {}", ""]);
    const store = fm.applyJobs;
    const job = store.create("key-overforecast", [{ target: "ghost", kind: "restart" }]);

    store.finish(job.id);

    expect(store.get(job.id)!.targets[0]).toMatchObject({ status: "done", settled_by: "no-change" });
  });

  it("settles a job left running by the process that died, on the next startup", async () => {
    const dir = tempDir();
    const dying = new ApplyJobStore(dir);
    const job = dying.create("key-across-restart", [
      { target: "one", kind: "restart" },
      { target: APPLY_FLEET_TARGET, kind: "restart" },
    ]);
    dying.setTargetStatus(job.id, "one", "running");
    asPreviousProcess(dying, job.id);

    // The replacement fleet process reaching the end of startup.
    const { fm } = fleetWithInstance(dir, ["instances: {}", ""]);
    (fm as unknown as { finishStartup(): void }).finishStartup();

    const settled = fm.applyJobs.get(job.id)!;
    expect(settled.status).toBe("done");
    expect(settled.targets.map(row => row.settled_by)).toEqual(["fleet-restart", "fleet-restart"]);
    // And the on-disk copy agrees, so a later GET from any process does too.
    const onDisk = JSON.parse(readFileSync(join(dir, "settings-apply-jobs.json"), "utf-8")) as {
      jobs: Array<{ id: string; status: string }>;
    };
    expect(onDisk.jobs.find(item => item.id === job.id)!.status).toBe("done");
  });
});
