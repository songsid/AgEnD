import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPLY_FLEET_TARGET, ApplyJobStore, type ApplyJob } from "../src/apply-job.js";
import { FleetManager } from "../src/fleet-manager.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import {
  checkSelfRestartAllowance,
  readSelfRestartAttempts,
  recordSelfRestartAttempt,
  SELF_RESTART_MAX_PER_WINDOW,
  SELF_RESTART_MIN_INTERVAL_MS,
  SELF_RESTART_WINDOW_MS,
} from "../src/self-restart-limit.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-self-restart-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── The rate limit ──────────────────────────────────────────────────────────

describe("self-restart rate limit", () => {
  it("allows the first attempt and refuses the next one for ten minutes", () => {
    const dir = tempDir();
    const t0 = 1_000_000_000;

    expect(checkSelfRestartAllowance(dir, t0).allowed).toBe(true);
    recordSelfRestartAttempt(dir, t0);

    const tooSoon = checkSelfRestartAllowance(dir, t0 + SELF_RESTART_MIN_INTERVAL_MS - 1_000);
    expect(tooSoon).toMatchObject({ allowed: false, reason: "too-soon" });
    expect(tooSoon.retryAfterSeconds).toBe(1);
    expect(checkSelfRestartAllowance(dir, t0 + SELF_RESTART_MIN_INTERVAL_MS).allowed).toBe(true);
  });

  it("caps the hour even when each attempt waits out the interval", () => {
    const dir = tempDir();
    const t0 = 2_000_000_000;
    for (let i = 0; i < SELF_RESTART_MAX_PER_WINDOW; i++) {
      const at = t0 + i * SELF_RESTART_MIN_INTERVAL_MS;
      expect(checkSelfRestartAllowance(dir, at).allowed, `attempt ${i}`).toBe(true);
      recordSelfRestartAttempt(dir, at);
    }
    const fourth = t0 + SELF_RESTART_MAX_PER_WINDOW * SELF_RESTART_MIN_INTERVAL_MS;

    expect(checkSelfRestartAllowance(dir, fourth)).toMatchObject({ allowed: false, reason: "hourly-cap" });
    expect(checkSelfRestartAllowance(dir, t0 + SELF_RESTART_WINDOW_MS + 1).allowed).toBe(true);
  });

  it("counts attempts, not successes", () => {
    // A restart that reliably fails would otherwise be retryable forever, which
    // is the cheapest attack available.
    const dir = tempDir();
    const t0 = 3_000_000_000;
    recordSelfRestartAttempt(dir, t0);

    expect(checkSelfRestartAllowance(dir, t0 + 1_000).allowed).toBe(false);
  });

  it("survives the restart it records, with 0600 permissions", () => {
    const dir = tempDir();
    recordSelfRestartAttempt(dir, 4_000_000_000);

    // A new process reading the same data dir.
    expect(readSelfRestartAttempts(dir)).toEqual([4_000_000_000]);
    expect(statSync(join(dir, "self-restart.json")).mode & 0o777).toBe(0o600);
  });

  it("reports failure to record instead of pretending", () => {
    const dir = tempDir();
    const notADir = join(dir, "file");
    writeFileSync(notADir, "");

    expect(recordSelfRestartAttempt(notADir)).toBe(false);
  });

  it("treats a damaged file as spent, not as fresh", () => {
    // A control that disarms itself when its own state is in doubt is not a
    // control. Recovery is deleting the file on the host, which needs the same
    // access as running `agend restart` there.
    const dir = tempDir();

    writeFileSync(join(dir, "self-restart.json"), "{ not json");
    expect(checkSelfRestartAllowance(dir)).toMatchObject({ allowed: false, reason: "unreadable" });

    // A half-written file, which is what an interrupted write leaves behind.
    writeFileSync(join(dir, "self-restart.json"), "");
    expect(checkSelfRestartAllowance(dir).allowed).toBe(false);

    // Valid JSON of the wrong shape.
    writeFileSync(join(dir, "self-restart.json"), JSON.stringify({ attempts: 5 }));
    expect(checkSelfRestartAllowance(dir).allowed).toBe(false);
    writeFileSync(join(dir, "self-restart.json"), JSON.stringify({}));
    expect(checkSelfRestartAllowance(dir).allowed).toBe(false);

    // …and the right shape with junk inside is not trusted either.
    writeFileSync(join(dir, "self-restart.json"), JSON.stringify({ attempts: ["soon"] }));
    expect(checkSelfRestartAllowance(dir).allowed).toBe(false);
  });

  it("still starts fresh when the file has simply never been written", () => {
    expect(checkSelfRestartAllowance(tempDir()).allowed).toBe(true);
  });

  it("is never cleared by anything in the web layer", () => {
    const settings = readFileSync(join(process.cwd(), "src", "settings-api.ts"), "utf8");
    const web = readFileSync(join(process.cwd(), "src", "web-api.ts"), "utf8");

    // A rate limit an attacker can reset is not a rate limit: no web route may
    // name the file, write it, or import anything that does.
    for (const source of [settings, web]) {
      expect(source).not.toContain("self-restart.json");
      expect(source).not.toContain("self-restart-limit");
      expect(source).not.toContain("recordSelfRestartAttempt");
      expect(source).not.toContain("SELF_RESTART_");
    }
  });
});

// ── The FleetManager envelope ───────────────────────────────────────────────

function fleetWith(dir: string, lines: string[]): { fm: FleetManager; configPath: string } {
  const configPath = join(dir, "fleet.yaml");
  writeFileSync(configPath, lines.join("\n"));
  const fm = new FleetManager(dir);
  fm.loadConfig(configPath);
  (fm as unknown as { startupComplete: boolean }).startupComplete = true;
  return { fm, configPath };
}

/** A fleet with a pending fleet-level change and a job whose row reflects it. */
async function fleetWithPendingRestart(dir: string) {
  const { fm, configPath } = fleetWith(dir, [
    "channel:", "  type: telegram", "  bot_token_env: TELEGRAM_BOT_TOKEN", "  group_id: '123'", "defaults:", "  locale: en", "instances: {}", "",
  ]);
  (fm as unknown as { finishStartup(): void }).finishStartup();
  const sendText = vi.fn(async () => ({ chatId: "123", messageId: "m1", threadId: undefined }));
  (fm as unknown as { adapter: unknown }).adapter = { id: "telegram", sendText };
  const fullRestart = vi.spyOn(fm, "requestFullRestart").mockResolvedValue(true);
  writeFileSync(configPath, [
    "channel:", "  type: telegram", "  bot_token_env: TELEGRAM_BOT_TOKEN", "  group_id: '123'", "defaults:", "  locale: zh-TW", "instances: {}", "",
  ].join("\n"));
  fm.fleetConfig!.defaults!.locale = "zh-TW";

  const { job } = fm.startSettingsApply("key-pending-fleet-change") as { job: ApplyJob };
  await vi.waitFor(() => expect(fm.applyJobs.get(job.id)!.status).toBe("done"));
  expect(fm.applyJobs.get(job.id)!.targets.find(r => r.target === APPLY_FLEET_TARGET)!.status)
    .toBe("restart-required");
  return { fm, configPath, job, sendText, fullRestart };
}

describe("restarting AgEnD from Settings", () => {
  it("announces it, records the attempt before launching, and consumes the row", async () => {
    const dir = tempDir();
    const { fm, job, sendText, fullRestart } = await fleetWithPendingRestart(dir);
    // The attempt has to be on disk before anything spawns, because the process
    // is about to be replaced.
    let attemptsAtLaunch: number[] = [];
    fullRestart.mockImplementation(async () => {
      attemptsAtLaunch = readSelfRestartAttempts(dir);
      return true;
    });

    const result = await fm.requestSettingsSelfRestart(job.id, "key-self-restart-001");

    expect(result).toMatchObject({ ok: true, jobId: job.id });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(attemptsAtLaunch).toHaveLength(1);
    expect(fullRestart).toHaveBeenCalledWith(expect.anything(), "123", undefined, "m1");
    // Consumed: the row is in flight, so the next process settles it.
    const row = fm.applyJobs.get(job.id)!.targets.find(r => r.target === APPLY_FLEET_TARGET)!;
    expect(row.status).toBe("running");
    expect(fm.applyJobs.get(job.id)!.restart_key).toBe("key-self-restart-001");
    expect(fm.applyJobs.get(job.id)!.deadlineMs).toBe(300_000);
  });

  it("refuses a second restart for the same job", async () => {
    const dir = tempDir();
    const { fm, job, fullRestart } = await fleetWithPendingRestart(dir);
    await fm.requestSettingsSelfRestart(job.id, "key-self-restart-002");

    const second = await fm.requestSettingsSelfRestart(job.id, "key-self-restart-003");

    expect(second).toMatchObject({ ok: false, status: 409 });
    expect(fullRestart).toHaveBeenCalledTimes(1);
  });

  it("returns the original outcome for a retried key instead of restarting twice", async () => {
    const dir = tempDir();
    const { fm, job, fullRestart } = await fleetWithPendingRestart(dir);
    const first = await fm.requestSettingsSelfRestart(job.id, "key-retried-restart");

    const retry = await fm.requestSettingsSelfRestart(job.id, "key-retried-restart");

    expect(retry).toMatchObject({ ok: true, jobId: job.id, reused: true });
    expect(first).toMatchObject({ ok: true });
    expect(fullRestart).toHaveBeenCalledTimes(1);
  });

  it("refuses when the change was reverted, even though the old job still has the row", async () => {
    // The row alone is not enough: a job keeps it for the whole retention
    // window, so apply-then-revert would leave a restartable-looking job.
    const dir = tempDir();
    const { fm, configPath, job, fullRestart } = await fleetWithPendingRestart(dir);
    writeFileSync(configPath, [
      "channel:", "  type: telegram", "  bot_token_env: TELEGRAM_BOT_TOKEN", "  group_id: '123'", "defaults:", "  locale: en", "instances: {}", "",
    ].join("\n"));
    fm.fleetConfig!.defaults!.locale = "en";

    const result = await fm.requestSettingsSelfRestart(job.id, "key-after-revert");

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as { error: string }).error).toContain("no fleet-level change is pending");
    expect(fullRestart).not.toHaveBeenCalled();
  });

  it("refuses for a job that has no fleet row at all", async () => {
    const dir = tempDir();
    const { fm } = await fleetWithPendingRestart(dir);
    const unrelated = fm.applyJobs.create("key-unrelated", [{ target: "one", kind: "hot" }]);

    const result = await fm.requestSettingsSelfRestart(unrelated.id, "key-no-fleet-row");

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as { error: string }).error).toContain("no pending fleet-level change");
  });

  it("refuses while a reconcile is running", async () => {
    const dir = tempDir();
    const { fm, job, fullRestart } = await fleetWithPendingRestart(dir);
    (fm as unknown as { reconcileInFlight: Promise<void> | null }).reconcileInFlight = Promise.resolve();

    const result = await fm.requestSettingsSelfRestart(job.id, "key-during-reconcile");

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(fullRestart).not.toHaveBeenCalled();
  });

  it("refuses with 429 once the rate limit is spent", async () => {
    const dir = tempDir();
    const { fm, job, fullRestart } = await fleetWithPendingRestart(dir);
    recordSelfRestartAttempt(dir);

    const result = await fm.requestSettingsSelfRestart(job.id, "key-rate-limited");

    expect(result).toMatchObject({ ok: false, status: 429 });
    expect((result as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect(fullRestart).not.toHaveBeenCalled();
  });

  it("refuses when the restart cannot be announced", async () => {
    // No untraceable restarts: the same rule as refusing when the progress
    // marker cannot be written.
    const dir = tempDir();
    const { fm, job, fullRestart } = await fleetWithPendingRestart(dir);
    (fm as unknown as { adapter: unknown }).adapter = {
      id: "telegram",
      sendText: vi.fn(async () => { throw new Error("gateway down"); }),
    };

    const result = await fm.requestSettingsSelfRestart(job.id, "key-no-audit");

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as { error: string }).error).toContain("agend restart");
    expect(fullRestart).not.toHaveBeenCalled();
    // The attempt is recorded before the notice is posted, so a failed
    // announcement still costs an attempt — otherwise a data dir that cannot be
    // written turns the announcement into an unlimited channel-spam primitive.
    expect(readSelfRestartAttempts(dir)).toHaveLength(1);
  });

  it("refuses on a deployment with no chat channel at all", async () => {
    const dir = tempDir();
    const { fm, job, fullRestart } = await fleetWithPendingRestart(dir);
    (fm as unknown as { adapter: unknown }).adapter = null;

    const result = await fm.requestSettingsSelfRestart(job.id, "key-no-channel");

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as { error: string }).error).toContain("agend restart");
    expect(fullRestart).not.toHaveBeenCalled();
  });

  it("refuses to restart unmetered when the attempt cannot be recorded", async () => {
    const dir = tempDir();
    const { fm, job, fullRestart, sendText } = await fleetWithPendingRestart(dir);
    // A directory that does not exist: reading the (absent) limit file gives
    // ENOENT and so reads as "no attempts yet", while writing it fails. That is
    // the read-only-mount shape, and it reaches the record step rather than
    // being turned away by the unreadable check first.
    (fm as unknown as { dataDir: string }).dataDir = join(dir, "missing", "deeper");

    const result = await fm.requestSettingsSelfRestart(job.id, "key-unrecordable");

    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(fullRestart).not.toHaveBeenCalled();
    // And nothing was announced: a restart that cannot be metered must not
    // repeatedly tell the channel it is restarting.
    expect(sendText).not.toHaveBeenCalled();
  });

  it("refuses with 503 when the rate-limit file itself is damaged", async () => {
    const dir = tempDir();
    const { fm, job, fullRestart, sendText } = await fleetWithPendingRestart(dir);
    writeFileSync(join(dir, "self-restart.json"), "{ half-writ");

    const result = await fm.requestSettingsSelfRestart(job.id, "key-damaged-limit");

    expect(result).toMatchObject({ ok: false, status: 503 });
    expect((result as { error: string }).error).toContain("self-restart.json");
    expect(fullRestart).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("marks the row failed when the launch itself fails", async () => {
    const dir = tempDir();
    const { fm, job, fullRestart } = await fleetWithPendingRestart(dir);
    fullRestart.mockResolvedValue(false);

    const result = await fm.requestSettingsSelfRestart(job.id, "key-launch-failed");

    expect(result).toMatchObject({ ok: false, status: 409 });
    const row = fm.applyJobs.get(job.id)!.targets.find(r => r.target === APPLY_FLEET_TARGET)!;
    expect(row.status).toBe("failed");
    expect(fm.applyJobs.get(job.id)!.status).toBe("failed");
  });
});

// ── The startup consistency check ───────────────────────────────────────────

describe("startup signature consistency", () => {
  it("is clean when the file and the running config agree", () => {
    const dir = tempDir();
    const { fm } = fleetWith(dir, ["defaults:", "  locale: en", "instances: {}", ""]);
    (fm as unknown as { finishStartup(): void }).finishStartup();

    expect(fm.fleetSignatureMismatchKeys()).toBeNull();
  });

  it("names the disagreeing keys instead of offering a restart that cannot clear them", async () => {
    const dir = tempDir();
    const { fm, configPath } = fleetWith(dir, [
      "channel:", "  type: telegram", "  bot_token_env: TELEGRAM_BOT_TOKEN", "  group_id: '123'", "defaults:", "  locale: en", "instances: {}", "",
    ]);
    // A startup rewrite that leaves memory and disk disagreeing — the shape of
    // slimFleetConfigAtStartup() and the general fixups, which all run before
    // finishStartup().
    writeFileSync(configPath, [
      "channel:", "  type: telegram", "  bot_token_env: TELEGRAM_BOT_TOKEN", "  group_id: '123'", "defaults:", "  locale: zh-TW", "instances: {}", "",
    ].join("\n"));
    (fm as unknown as { finishStartup(): void }).finishStartup();

    expect(fm.fleetSignatureMismatchKeys()).toEqual(["defaults.locale"]);

    // And the self restart is refused, because restarting cannot fix it.
    (fm as unknown as { adapter: unknown }).adapter = {
      id: "telegram", sendText: vi.fn(async () => ({ chatId: "123", messageId: "m1" })),
    };
    const fullRestart = vi.spyOn(fm, "requestFullRestart").mockResolvedValue(true);
    const job = fm.applyJobs.create("key-mismatch", [{ target: APPLY_FLEET_TARGET, kind: "restart" }]);
    fm.applyJobs.setTargetStatus(job.id, APPLY_FLEET_TARGET, "restart-required");

    const result = await fm.requestSettingsSelfRestart(job.id, "key-mismatch-restart");

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as { error: string }).error).toContain("fleet.log");
    expect(fullRestart).not.toHaveBeenCalled();
  });
});

// ── The HTTP surface ────────────────────────────────────────────────────────

function request(
  path: string,
  ctx: SettingsApiContext,
  method = "POST",
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as EventEmitter & {
      method: string; headers: Record<string, string>; destroy(): void;
    };
    req.method = method;
    req.headers = opts.headers ?? {};
    req.destroy = () => undefined;
    let status = 0;
    const headers: Record<string, string> = {};
    const res = {
      setHeader(name: string, value: string) { headers[name] = value; },
      writeHead(code: number) { status = code; },
      end(payload: string) { resolve({ status, body: JSON.parse(payload) as Record<string, unknown>, headers }); },
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

function apiContext(dir: string, restart: SettingsApiContext["requestSettingsSelfRestart"]) {
  return {
    fleetConfig: { defaults: {}, instances: {} },
    configPath: join(dir, "fleet.yaml"),
    dataDir: dir,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    getRawFleetConfig: () => ({}),
    saveFleetConfig: vi.fn(),
    lifecycle: { isPaused: () => false, pause: vi.fn(), wake: vi.fn() },
    applyJobs: new ApplyJobStore(dir),
    requestSettingsSelfRestart: restart,
  } as unknown as SettingsApiContext;
}

describe("POST /api/settings/restart-fleet", () => {
  const accept = vi.fn(async (jobId: string) => ({ ok: true as const, jobId }));

  it("needs the literal confirmation, not a truthy value", async () => {
    const dir = tempDir();
    const called = vi.fn(async (jobId: string) => ({ ok: true as const, jobId }));
    const ctx = apiContext(dir, called);

    const truthy = await request("/api/settings/restart-fleet", ctx, "POST", {
      headers: { "idempotency-key": "key-truthy-confirm" },
      body: { job_id: "j1", confirm: true },
    });

    expect(truthy.status).toBe(400);
    expect(called).not.toHaveBeenCalled();
  });

  it("needs a key and a job id", async () => {
    const dir = tempDir();
    const called = vi.fn(async (jobId: string) => ({ ok: true as const, jobId }));
    const ctx = apiContext(dir, called);

    const noKey = await request("/api/settings/restart-fleet", ctx, "POST", {
      body: { job_id: "j1", confirm: "restart-agend" },
    });
    const noJob = await request("/api/settings/restart-fleet", ctx, "POST", {
      headers: { "idempotency-key": "key-missing-job" },
      body: { confirm: "restart-agend" },
    });

    expect(noKey.status).toBe(400);
    expect(noJob.status).toBe(400);
    expect(called).not.toHaveBeenCalled();
  });

  it("accepts a well-formed request", async () => {
    const dir = tempDir();
    const ctx = apiContext(dir, accept);

    const res = await request("/api/settings/restart-fleet", ctx, "POST", {
      headers: { "idempotency-key": "key-well-formed" },
      body: { job_id: "job-1", confirm: "restart-agend" },
    });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ job_id: "job-1", restarting: true });
  });

  it("passes a rate-limit refusal through with Retry-After", async () => {
    const dir = tempDir();
    const ctx = apiContext(dir, async () => ({
      ok: false as const, status: 429 as const, error: "too many", retryAfterSeconds: 420,
    }));

    const res = await request("/api/settings/restart-fleet", ctx, "POST", {
      headers: { "idempotency-key": "key-rate-limit-http" },
      body: { job_id: "job-1", confirm: "restart-agend" },
    });

    expect(res.status).toBe(429);
    expect(res.headers["Retry-After"]).toBe("420");
    expect(res.body.retry_after_seconds).toBe(420);
  });
});

describe("GET /api/settings/schema", () => {
  it("tells the page when a restart could not clear the fleet row", async () => {
    const dir = tempDir();
    const ctx = apiContext(dir, async (jobId: string) => ({ ok: true as const, jobId }));
    (ctx as unknown as { fleetSignatureMismatchKeys(): string[] }).fleetSignatureMismatchKeys =
      () => ["defaults.locale"];

    const res = await request("/api/settings/schema", ctx, "GET");

    expect(res.body.fleet_signature_mismatch).toEqual(["defaults.locale"]);
  });
});

describe("the settings page keeps the two restarts apart", () => {
  const html = readFileSync(join(process.cwd(), "src", "ui", "settings.html"), "utf8");

  it("asks for its own confirmation and its own key", () => {
    expect(html).toContain('confirm(t("restartFleetConfirm"))');
    expect(html).toContain('api("/api/settings/restart-fleet"');
    expect(html).toContain('confirm: "restart-agend"');
    // Not reachable from applyPendingChanges: a single Apply must not carry it.
    expect(html).not.toMatch(/applyPendingChanges[\s\S]{0,800}restart-fleet/);
  });

  it("hides the button when a restart could not clear the row", () => {
    expect(html).toContain("if (needsRestart && !mismatch)");
    expect(html).toContain("signatureMismatch");
  });

  it("shows how long to wait when the limit refuses", () => {
    expect(html).toContain("retry_after_seconds");
    expect(html).toContain("restartFleetRateLimited");
  });
});
