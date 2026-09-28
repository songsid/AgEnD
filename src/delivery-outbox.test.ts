import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { DeliveryOutbox, DURABLE_DELIVERY_ABORT_BACKOFF_MS, DURABLE_DELIVERY_MAX_AGE_MS, DURABLE_DELIVERY_MAX_ATTEMPTS, type NewOutboxDelivery } from "./delivery-outbox.js";
import { finishTargetReconciliation } from "./delivery-reconciliation.js";

const roots: string[] = [];
function tempDb(): string {
  const root = mkdtempSync(join(tmpdir(), "agend-outbox-test-"));
  roots.push(root);
  return join(root, "delivery-outbox.db");
}

function input(overrides: Partial<NewOutboxDelivery> = {}): NewOutboxDelivery {
  const id = overrides.operationId ?? "op-1";
  const target = overrides.targetInstance ?? "worker";
  return {
    operationId: id,
    sourceKey: `mcp:source:${id}:${target}:fleet_inbound`,
    sourceInstance: "source",
    sourceDaemonBootId: "source-boot-1",
    targetInstance: target,
    kind: "fleet_inbound",
    correlationId: "same-correlation",
    payload: { type: "fleet_inbound", content: "hello", meta: {} },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DeliveryOutbox", () => {
  it("commits admission before returning and makes an operation retry idempotent", () => {
    const outbox = new DeliveryOutbox(tempDb(), "manager-1");
    const first = outbox.admit(input());
    const retry = outbox.admit(input());

    expect(first.inserted).toBe(true);
    expect(retry.inserted).toBe(false);
    expect(retry.delivery.deliveryId).toBe(first.delivery.deliveryId);
    expect(retry.delivery.state).toBe("queued");
    outbox.close();
  });

  it("recovers a pre-begin dispatch after SIGKILL when target stays stopped, then expires it visibly", async () => {
    const dbPath = tempDb();
    const storeUrl = pathToFileURL(join(process.cwd(), "src/delivery-outbox.ts")).href;
    const managerUrl = pathToFileURL(join(process.cwd(), "src/fleet-manager.ts")).href;
    const daemonUrl = pathToFileURL(join(process.cwd(), "src/daemon.ts")).href;
    const script = [
      `import { FleetManager } from ${JSON.stringify(managerUrl)};`,
      `import { DeliveryOutbox } from ${JSON.stringify(storeUrl)};`,
      `import { Daemon } from ${JSON.stringify(daemonUrl)};`,
      `import { mkdirSync, writeFileSync } from "node:fs";`,
      `import pino from "pino";`,
      `const manager = new FleetManager(${JSON.stringify(dirname(dbPath))});`,
      `const outbox = new DeliveryOutbox(${JSON.stringify(dbPath)}, manager.managerBootId);`,
      `manager.deliveryOutbox = outbox;`,
      `manager.shuttingDown = true;`,
      `const logger = pino({ level: "silent" });`,
      `const makeDaemon = name => new Daemon(name, { working_directory: "/tmp", log_level: "error" }, ${JSON.stringify(dirname(dbPath))} + "/instances/" + name, false, undefined, undefined, logger);`,
      `const source = makeDaemon("source");`,
      `const target = makeDaemon("worker");`,
      `source.setDeliveryOutboxPort(outbox); target.setDeliveryOutboxPort(outbox);`,
      `manager.lifecycle.daemons.set("source", source); manager.lifecycle.daemons.set("worker", target);`,
      `const accepted = manager.admitDurableDelivery({ operationId: "op-1", sourceDaemonBootId: source.bootId, sourceInstance: "source", targetInstance: "worker", kind: "fleet_inbound", correlationId: "same-correlation", payload: { type: "fleet_inbound", content: "hello", meta: {} } });`,
      `const claimed = outbox.claimNext(manager.managerBootId, name => manager.lifecycle.daemons.get(name)?.bootId ?? null, new Set());`,
      `const targetDaemon = manager.lifecycle.daemons.get("worker");`,
      `const instanceDir = ${JSON.stringify(dirname(dbPath))} + "/instances/worker";`,
      `mkdirSync(instanceDir, { recursive: true }); writeFileSync(instanceDir + "/window-id", "@worker");`,
      `targetDaemon.tmux = { capturePane: async () => "❯", pasteBuffer: async () => true, sendSpecialKey: async () => true, getLastPasteError: () => undefined, isLastPasteFailureRecoverable: () => true };`,
      `targetDaemon.controlClient = {};`,
      `targetDaemon.paneReadinessForDelivery = async () => "busy";`,
      `targetDaemon.probeBlockingDialog = async () => ({ state: "clear" });`,
      `targetDaemon.hasPositiveDeliveryInput = async () => false;`,
      `targetDaemon.waitForPaneReadyForDelivery = async () => { process.stdout.write("dispatch-waiting\\n"); return new Promise(() => {}); };`,
      `targetDaemon.pushChannelMessage("hello", { delivery_id: accepted.deliveryId, delivery_attempt: String(claimed.attemptNo), from_instance: "source", correlation_id: "same-correlation", user: "instance:source", user_id: "instance:source", message_id: "message-crash-before-begin", chat_id: "", thread_id: "", ts: new Date().toISOString() });`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let childStderr = "";
    child.stderr.setEncoding("utf8").on("data", chunk => { childStderr += chunk; });
    const lines = createInterface({ input: child.stdout });
    const committed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`writer child did not reach the pre-begin wait: ${childStderr}`));
      }, 8_000);
      lines.once("line", line => {
        clearTimeout(timer);
        if (line === "dispatch-waiting") resolve();
        else reject(new Error(`unexpected child output: ${line}`));
      });
      child.once("error", err => {
        clearTimeout(timer);
        reject(err);
      });
    });
    await committed;
    child.kill("SIGKILL");
    await once(child, "exit");
    lines.close();

    const replacementManager = new (await import("./fleet-manager.js")).FleetManager(dirname(dbPath));
    (replacementManager as any).shuttingDown = true;
    // Exercise FleetManager's production startup wiring: it opens the durable
    // store and runs recoverForBoot itself before any target Daemon is started.
    (replacementManager as any).ensureDeliveryOutbox();
    const restarted = replacementManager.deliveryOutbox!;
    const { Daemon } = await import("./daemon.js");
    const pinoModule = await import("pino");
    const logger = pinoModule.default({ level: "silent" });
    const makeDaemon = (name: string) => new Daemon(
      name,
      { working_directory: "/tmp", log_level: "error", restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 }, context_guardian: { max_age_hours: 4, grace_period_ms: 600000 } },
      join(dirname(dbPath), "instances", name),
      false,
      undefined,
      undefined,
      logger as any,
    );
    const sourceDaemon = makeDaemon("source");
    sourceDaemon.setDeliveryOutboxPort(restarted);
    replacementManager.lifecycle.daemons.set("source", sourceDaemon);
    replacementManager.onDaemonReady("source", sourceDaemon.bootId);
    const statusAfterCrash = replacementManager.queryDurableDeliveryStatus("source", { operationId: "op-1" });
    expect(statusAfterCrash.items).toMatchObject([
      { operation_id: "op-1", target_instance: "worker", state: "queued", safe_to_retry: true },
    ]);
    expect(statusAfterCrash.items[0]).not.toHaveProperty("payload");
    const pendingAfterRecovery = restarted.listPending();
    expect(pendingAfterRecovery).toMatchObject([
      { operationId: "op-1", targetInstance: "worker", state: "queued", payload: { content: "hello" } },
      { operationId: expect.stringContaining("notice:"), targetInstance: "source", state: "queued" },
    ]);
    expect(replacementManager.lifecycle.daemons.has("worker")).toBe(false);
    expect(restarted.getUnansweredAccepted("source", sourceDaemon.bootId)).toHaveLength(1);

    const queuedDelivery = pendingAfterRecovery.find(row => row.operationId === "op-1")!;
    const createdAt = (restarted as any).db.prepare(
      "SELECT created_at FROM deliveries WHERE delivery_id=?",
    ).get(queuedDelivery.deliveryId).created_at as string;
    expect(restarted.expireStale(Date.parse(createdAt) + DURABLE_DELIVERY_MAX_AGE_MS + 1)).toBe(1);
    expect(restarted.get(queuedDelivery.deliveryId)).toMatchObject({ state: "failed" });
    const failureNotice = (restarted as any).db.prepare(
      "SELECT state,target_instance,payload_json FROM deliveries WHERE kind='delivery_outcome_notice' AND operation_id=?",
    ).get(`notice:op-1:${queuedDelivery.deliveryId}`) as { state: string; target_instance: string; payload_json: string } | undefined;
    expect(failureNotice?.state).toBe("queued");
    expect(failureNotice?.target_instance).toBe("source");
    expect(JSON.parse(failureNotice!.payload_json).content).toContain("state=failed");
    restarted.close();
  });

  it("replays a whole-process SIGKILL before Enter because no write-ahead Enter marker exists", async () => {
    const dbPath = tempDb();
    const storeUrl = pathToFileURL(join(process.cwd(), "src/delivery-outbox.ts")).href;
    const managerUrl = pathToFileURL(join(process.cwd(), "src/fleet-manager.ts")).href;
    const daemonUrl = pathToFileURL(join(process.cwd(), "src/daemon.ts")).href;
    const script = [
      `import { FleetManager } from ${JSON.stringify(managerUrl)};`,
      `import { DeliveryOutbox } from ${JSON.stringify(storeUrl)};`,
      `import { Daemon } from ${JSON.stringify(daemonUrl)};`,
      `import { mkdirSync, writeFileSync } from "node:fs";`,
      `import pino from "pino";`,
      `const root = ${JSON.stringify(dirname(dbPath))};`,
      `const manager = new FleetManager(root);`,
      `const outbox = new DeliveryOutbox(${JSON.stringify(dbPath)}, manager.managerBootId);`,
      `manager.deliveryOutbox = outbox; manager.shuttingDown = true;`,
      `const logger = pino({ level: "silent" });`,
      `const makeDaemon = name => new Daemon(name, { working_directory: "/tmp", log_level: "error" }, root + "/instances/" + name, false, undefined, undefined, logger);`,
      `const source = makeDaemon("source"); const target = makeDaemon("worker");`,
      `source.setDeliveryOutboxPort(outbox); target.setDeliveryOutboxPort(outbox);`,
      `manager.lifecycle.daemons.set("source", source); manager.lifecycle.daemons.set("worker", target);`,
      `const accepted = manager.admitDurableDelivery({ operationId: "op-paste-crash", sourceDaemonBootId: source.bootId, sourceInstance: "source", targetInstance: "worker", kind: "fleet_inbound", correlationId: "corr-paste-crash", payload: { type: "fleet_inbound", content: "hello", meta: {} } });`,
      `const claimed = outbox.claimNext(manager.managerBootId, name => manager.lifecycle.daemons.get(name)?.bootId ?? null, new Set());`,
      `const instanceDir = root + "/instances/worker"; mkdirSync(instanceDir, { recursive: true }); writeFileSync(instanceDir + "/window-id", "@worker");`,
      `target.tmux = { capturePane: async () => "❯", pasteBuffer: async () => { process.stdout.write("pane-paste-started\\n"); return new Promise(() => {}); }, sendSpecialKey: async () => true, getLastPasteError: () => undefined, isLastPasteFailureRecoverable: () => true };`,
      `target.pushChannelMessage("hello", { delivery_id: accepted.deliveryId, delivery_attempt: String(claimed.attemptNo), from_instance: "source", correlation_id: "corr-paste-crash", user: "instance:source", user_id: "instance:source", message_id: "message-paste-crash", chat_id: "", thread_id: "", ts: new Date().toISOString() });`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    const pasted = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child did not reach the pane paste")), 10_000);
      lines.once("line", line => {
        clearTimeout(timer);
        if (line === "pane-paste-started") resolve();
        else reject(new Error(`unexpected child output: ${line}`));
      });
      child.once("error", err => {
        clearTimeout(timer);
        reject(err);
      });
    });
    await pasted;
    child.kill("SIGKILL");
    await once(child, "exit");
    lines.close();

    const replacementManager = new (await import("./fleet-manager.js")).FleetManager(dirname(dbPath));
    (replacementManager as any).shuttingDown = true;
    (replacementManager as any).ensureDeliveryOutbox();
    const restarted = replacementManager.deliveryOutbox!;
    const { Daemon } = await import("./daemon.js");
    const pinoModule = await import("pino");
    const logger = pinoModule.default({ level: "silent" });
    const makeDaemon = (name: string) => new Daemon(
      name,
      { working_directory: "/tmp", log_level: "error", restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 }, context_guardian: { max_age_hours: 4, grace_period_ms: 600000 } },
      join(dirname(dbPath), "instances", name), false, undefined, undefined, logger as any,
    );
    const sourceDaemon = makeDaemon("source");
    sourceDaemon.setDeliveryOutboxPort(restarted);
    replacementManager.lifecycle.daemons.set("source", sourceDaemon);

    replacementManager.onDaemonReady("source", sourceDaemon.bootId);
    const row = restarted.getByOperation("source", "op-paste-crash")[0];
    expect(row).toMatchObject({ state: "reconciliation_pending", reconciliationPending: true, targetInstance: "worker" });
    const candidate = restarted.getReconciliationCandidates("worker")[0]!;
    expect(candidate.attempt.enterStartedAt).toBeNull();
    expect(restarted.reconcileAttempt(candidate.deliveryId, candidate.attempt.targetDaemonBootId,
      candidate.attempt.attemptNo, "retry_wait", "enter-not-started; pre-kill-pane-captured")).toBe(true);
    expect(restarted.get(row.deliveryId)).toMatchObject({ state: "retry_wait", reconciliationPending: false });
    expect(restarted.listPending().filter(item => item.kind === "delivery_outcome_notice")).toHaveLength(0);
    restarted.close();
  });

  it("whole-process SIGKILL after tmux accepts Enter stays uncertain even if the stale pane still shows the marker", async () => {
    const dbPath = tempDb();
    const transcriptPath = join(dirname(dbPath), "empty-codex-rollout.jsonl");
    writeFileSync(transcriptPath, "");
    const storeUrl = pathToFileURL(join(process.cwd(), "src/delivery-outbox.ts")).href;
    const daemonUrl = pathToFileURL(join(process.cwd(), "src/daemon.ts")).href;
    const managerUrl = pathToFileURL(join(process.cwd(), "src/fleet-manager.ts")).href;
    const script = [
      `import { DeliveryOutbox } from ${JSON.stringify(storeUrl)};`,
      `import { Daemon } from ${JSON.stringify(daemonUrl)};`,
      `import { FleetManager } from ${JSON.stringify(managerUrl)};`,
      `import { mkdirSync, writeFileSync } from "node:fs";`,
      `import pino from "pino";`,
      `const db = ${JSON.stringify(dbPath)};`,
      `const root = ${JSON.stringify(dirname(dbPath))};`,
      `const manager = new FleetManager(root); manager.shuttingDown = true;`,
      `const outbox = new DeliveryOutbox(db, manager.managerBootId); manager.deliveryOutbox = outbox;`,
      `const logger = pino({ level: "silent" });`,
      `const source = new Daemon("source", { backend: "codex", working_directory: "/tmp", log_level: "error" }, root + "/instances/source", false, undefined, undefined, logger);`,
      `const target = new Daemon("worker", { backend: "codex", working_directory: "/tmp", log_level: "error" }, root + "/instances/worker", false, undefined, undefined, logger);`,
      `mkdirSync(root + "/instances/worker", { recursive: true }); writeFileSync(root + "/instances/worker/window-id", "@old");`,
      `source.setDeliveryOutboxPort(outbox); target.setDeliveryOutboxPort(outbox);`,
      `manager.lifecycle.daemons.set("source", source); manager.lifecycle.daemons.set("worker", target);`,
      `const row = outbox.admit(${JSON.stringify(input({ operationId: "op-enter-crash", sourceKey: "source:op-enter-crash" }))}).delivery;`,
      `const claimed = outbox.claimNext(manager.managerBootId, name => manager.lifecycle.daemons.get(name)?.bootId ?? null, new Set());`,
      `target.backend = { binaryName: "codex", supportsQueuedInput: () => true };`,
      `target.controlClient = {};`,
      `target.paneReadinessForDelivery = async () => "busy";`,
      `target.probeBlockingDialog = async () => ({ state: "clear" });`,
      `target.hasPositiveDeliveryInput = async () => true;`,
      `target.waitForInputTransientToClear = async () => true;`,
      `target.capturePaneEvidence = async () => ({ captured: true });`,
      `target.tmux = { getWindowId: () => "@old", capturePane: async () => "", pasteBuffer: async () => true, sendSpecialKey: async () => { process.stdout.write("tmux-enter-accepted\\n"); return new Promise(() => {}); }, getLastPasteError: () => undefined, isLastPasteFailureRecoverable: () => true };`,
      `target.pushChannelMessage("hello", { delivery_id: row.deliveryId, delivery_attempt: String(claimed.attemptNo), from_instance: "source", correlation_id: "same-correlation", user: "instance:source", user_id: "instance:source", message_id: "message-native-queue-crash", chat_id: "", thread_id: "", ts: new Date().toISOString() });`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let childStderr = "";
    child.stderr.setEncoding("utf8").on("data", chunk => { childStderr += chunk; });
    const lines = createInterface({ input: child.stdout });
    const accepted = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`writer child did not reach tmux Enter: ${childStderr}`)), 8_000);
      lines.once("line", line => {
        clearTimeout(timer);
        if (line === "tmux-enter-accepted") resolve();
        else reject(new Error(`unexpected child output: ${line}`));
      });
      child.once("error", err => {
        clearTimeout(timer);
        reject(err);
      });
    });
    await accepted;
    child.kill("SIGKILL");
    await once(child, "exit");
    lines.close();

    const replacementManager = new (await import("./fleet-manager.js")).FleetManager(dirname(dbPath));
    (replacementManager as any).shuttingDown = true;
    (replacementManager as any).ensureDeliveryOutbox();
    const replacement = replacementManager.deliveryOutbox!;
    expect(replacement.getReconciliationCandidates("worker")).toHaveLength(1);
    const candidate = replacement.getReconciliationCandidates("worker")[0]!;
    expect(candidate.attempt.enterStartedAt).toBeTruthy();
    expect(candidate.attempt).toMatchObject({
      backend: "codex",
      backendVersion: null,
      submissionMode: "native_queue_handoff",
      queueResumePolicy: "unknown",
    });
    const reconciled = await finishTargetReconciliation(replacement, {
      targetInstance: "worker",
      sessionName: "test-session",
      savedWindowId: "@old",
      attempts: [{
        candidate,
        paneWindowId: "@old",
        panePid: null,
        pane: `[agend-delivery-id:${candidate.deliveryId}]\n› [from:source] hello`,
        paneCaptureError: null,
      }],
    }, true);
    expect(reconciled).toEqual({ delivered: 0, retry: 0, uncertain: 1, safeToStart: true });
    expect(replacement.get(candidate.deliveryId)).toMatchObject({ state: "uncertain" });
    expect(replacement.queryStatusForInstance("source", { operationId: "op-enter-crash" }).items)
      .toMatchObject([{ delivery_id: candidate.deliveryId, state: "uncertain", safe_to_retry: false }]);
    expect(replacement.listPending().filter(item => item.kind === "delivery_outcome_notice")).toHaveLength(1);
    replacement.close();
  });

  it("fences begin by attempt and target generation; abort safely returns work to retry", () => {
    const outbox = new DeliveryOutbox(tempDb(), "manager-1");
    const row = outbox.admit(input()).delivery;
    const claimed = outbox.claimNext("manager-1", () => "target-boot-1", new Set())!;

    expect(outbox.begin(row.deliveryId, "old-target", claimed.attemptNo)).toBe("stale");
    expect(outbox.begin(row.deliveryId, "target-boot-1", claimed.attemptNo)).toBe("begun");
    expect(outbox.begin(row.deliveryId, "target-boot-1", claimed.attemptNo)).toBe("duplicate");
    expect(outbox.begin(row.deliveryId, "target-boot-1", claimed.attemptNo + 1)).toBe("stale");
    expect(outbox.abort(row.deliveryId, "target-boot-1", claimed.attemptNo, "pane lock recheck")).toBe(true);
    expect(outbox.abort(row.deliveryId, "target-boot-1", claimed.attemptNo, "retry duplicate")).toBe(true);
    expect(outbox.get(row.deliveryId)?.state).toBe("retry_wait");
    expect(Date.parse(outbox.get(row.deliveryId)!.nextAttemptAt!)).toBeGreaterThanOrEqual(Date.now() + DURABLE_DELIVERY_ABORT_BACKOFF_MS - 100);
    outbox.close();
  });

  it("persists transcript checkpoint and Enter-start before recovery can classify the attempt", () => {
    const outbox = new DeliveryOutbox(tempDb(), "manager-1");
    const row = outbox.admit(input()).delivery;
    const claimed = outbox.claimNext("manager-1", () => "target-boot-1", new Set())!;
    const evidence = {
      backend: "codex",
      windowId: "@old",
      transcriptPath: "/tmp/rollout.jsonl",
      transcriptOffset: 2048,
      transcriptSessionId: "rollout-session-1",
      submissionMode: "idle_submit" as const,
    };
    expect(outbox.begin(row.deliveryId, "target-boot-1", claimed.attemptNo, evidence)).toBe("begun");
    const rawAttempt = (outbox as any).db.prepare(
      "SELECT backend,window_id,transcript_path,transcript_offset,transcript_session_id,submission_mode,enter_started_at FROM delivery_attempts WHERE delivery_id=?",
    ).get(row.deliveryId);
    expect(rawAttempt).toMatchObject({
      backend: "codex", window_id: "@old", transcript_path: "/tmp/rollout.jsonl",
      transcript_offset: 2048, transcript_session_id: "rollout-session-1", submission_mode: "idle_submit",
      enter_started_at: null,
    });

    expect(outbox.markEnterStarted(row.deliveryId, "target-boot-1", claimed.attemptNo)).toBe(true);
    expect((outbox as any).db.prepare(
      "SELECT enter_started_at FROM delivery_attempts WHERE delivery_id=?",
    ).get(row.deliveryId).enter_started_at).toBeTruthy();
    expect(outbox.recoverForBoot("manager-2").reconciliationPending).toBe(1);
    const candidate = outbox.getReconciliationCandidates("worker")[0]!;
    expect(candidate).toMatchObject({ state: "reconciliation_pending", attempt: { enterStartedAt: expect.any(String) } });
    expect(outbox.reconcileAttempt(row.deliveryId, "target-boot-1", claimed.attemptNo, "uncertain", "no transcript marker after Enter")).toBe(true);
    expect(outbox.get(row.deliveryId)).toMatchObject({ state: "uncertain", reconciliationPending: false });
    expect(outbox.listPending().filter(item => item.kind === "delivery_outcome_notice")).toHaveLength(1);
    outbox.close();
  });

  it("holds only a target lane until its recovered attempt is classified", () => {
    const outbox = new DeliveryOutbox(tempDb(), "manager-1");
    const active = outbox.admit(input({ operationId: "active", sourceKey: "active", targetInstance: "worker-a" })).delivery;
    const newer = outbox.admit(input({ operationId: "newer", sourceKey: "newer", targetInstance: "worker-a" })).delivery;
    const independent = outbox.admit(input({ operationId: "other", sourceKey: "other", targetInstance: "worker-b" })).delivery;
    const first = outbox.claimNext("manager-1", target => `boot-${target}`, new Set())!;
    expect(first.deliveryId).toBe(active.deliveryId);
    expect(outbox.begin(active.deliveryId, first.targetDaemonBootId, first.attemptNo)).toBe("begun");
    expect(outbox.markEnterStarted(active.deliveryId, first.targetDaemonBootId, first.attemptNo)).toBe(true);
    outbox.recoverForBoot("manager-2");

    const available = outbox.claimNext("manager-2", target => `replacement-${target}`, new Set());
    expect(available?.deliveryId).toBe(independent.deliveryId);
    expect(outbox.get(newer.deliveryId)?.state).toBe("queued");
    expect(outbox.reconcileAttempt(active.deliveryId, first.targetDaemonBootId, first.attemptNo, "uncertain", "ambiguous")).toBe(true);
    const next = outbox.claimNext("manager-2", target => `replacement-${target}`, new Set());
    expect(next?.deliveryId).toBe(newer.deliveryId);
    outbox.close();
  });

  it("surfaces a reconciliation that remains pending through the visible TTL bound", () => {
    const outbox = new DeliveryOutbox(tempDb(), "manager-1");
    const row = outbox.admit(input()).delivery;
    const claimed = outbox.claimNext("manager-1", () => "target-boot-1", new Set())!;
    expect(outbox.begin(row.deliveryId, claimed.targetDaemonBootId, claimed.attemptNo, {
      backend: "muse", windowId: "@old", transcriptPath: null, transcriptOffset: null,
      transcriptSessionId: null, submissionMode: "idle_submit",
    })).toBe("begun");
    outbox.markEnterStarted(row.deliveryId, claimed.targetDaemonBootId, claimed.attemptNo);
    outbox.recoverForBoot("manager-2");
    (outbox as any).db.prepare("UPDATE deliveries SET created_at=? WHERE delivery_id=?")
      .run(new Date(Date.now() - 2_000).toISOString(), row.deliveryId);

    expect(outbox.expireStale(Date.now(), 1_000)).toBe(1);
    expect(outbox.get(row.deliveryId)).toMatchObject({ state: "uncertain", reconciliationPending: false });
    expect(outbox.listPending().filter(item => item.kind === "delivery_outcome_notice")).toHaveLength(1);
    outbox.close();
  });

  it("keeps FIFO per target across retry backoff while allowing another target to progress", () => {
    const outbox = new DeliveryOutbox(tempDb(), "manager-1");
    const first = outbox.admit(input({ operationId: "op-1", sourceKey: "one", targetInstance: "worker-a" })).delivery;
    const second = outbox.admit(input({ operationId: "op-2", sourceKey: "two", targetInstance: "worker-a" })).delivery;
    const independent = outbox.admit(input({ operationId: "op-3", sourceKey: "three", targetInstance: "worker-b" })).delivery;
    const claimed = outbox.claimNext("manager-1", target => `boot-${target}`, new Set())!;
    expect(claimed.deliveryId).toBe(first.deliveryId);
    expect(outbox.retryBeforeBegin(first.deliveryId, claimed.targetDaemonBootId, claimed.attemptNo, "temporarily unavailable", 60_000)).toBe(true);

    const next = outbox.claimNext("manager-1", target => `boot-${target}`, new Set());
    expect(next?.deliveryId).toBe(independent.deliveryId);
    expect(outbox.get(second.deliveryId)?.state).toBe("queued");
    outbox.close();
  });

  it("recovers unsubmitted leases and fences old target generations", () => {
    const outbox = new DeliveryOutbox(tempDb(), "manager-1");
    const queued = outbox.admit(input({ operationId: "queued", sourceKey: "queued" })).delivery;
    const claimed = outbox.claimNext("manager-1", () => "target-boot-1", new Set())!;
    expect(outbox.recoverForBoot("manager-2").queued).toBe(1);
    expect(outbox.get(queued.deliveryId)?.state).toBe("queued");

    const afterBoot = outbox.claimNext("manager-2", () => "target-boot-2", new Set())!;
    expect(outbox.begin(afterBoot.deliveryId, "target-boot-1", afterBoot.attemptNo)).toBe("stale");
    expect(outbox.begin(afterBoot.deliveryId, "target-boot-2", afterBoot.attemptNo)).toBe("begun");
    expect(outbox.recoverTargetGeneration("worker", "target-boot-3").reconciliationPending).toBe(1);
    expect(outbox.get(claimed.deliveryId)).toMatchObject({ state: "reconciliation_pending", reconciliationPending: true });
    outbox.close();
  });

  it("tracks the MCP response boundary and deduplicates post-restart notices", () => {
    const outbox = new DeliveryOutbox(tempDb(), "manager-1");
    const parent = outbox.admit(input()).delivery;
    expect(outbox.getUnansweredAccepted("source", "source-boot-2")).toHaveLength(1);
    expect(outbox.markResponseDelivered("source", "op-1")).toBe(1);
    expect(outbox.getUnansweredAccepted("source", "source-boot-2")).toHaveLength(0);

    const unanswered = outbox.admit(input({
      operationId: "op-2",
      sourceKey: "mcp:source:op-2:worker:fleet_inbound",
    })).delivery;
    const notice = outbox.admitPostRestartOutcomeNotice(unanswered, "source-boot-2");
    const duplicate = outbox.admitPostRestartOutcomeNotice(unanswered, "source-boot-2");
    expect(notice?.payload.content).toContain("Do not resend this operation");
    expect(duplicate?.deliveryId).toBe(notice?.deliveryId);
    const broadcastSibling = outbox.admit(input({
      operationId: "op-2",
      sourceKey: "mcp:source:op-2:worker-2::broadcast",
      targetInstance: "worker-2",
      kind: "broadcast",
    })).delivery;
    const siblingNotice = outbox.admitPostRestartOutcomeNotice(broadcastSibling, "source-boot-2");
    expect(siblingNotice?.deliveryId).not.toBe(notice?.deliveryId);
    expect(outbox.get(parent.deliveryId)?.responseDeliveredAt).not.toBeNull();
    outbox.close();
  });

  it("turns a target-unavailable row into a visible terminal failure at its TTL", () => {
    const outbox = new DeliveryOutbox(tempDb(), "manager-1");
    const row = outbox.admit(input()).delivery;
    expect(outbox.claimNext("manager-1", () => null, new Set())).toBeUndefined();

    const expired = outbox.expireStale(Date.now() + DURABLE_DELIVERY_MAX_AGE_MS + 1);

    expect(expired).toBe(1);
    expect(outbox.get(row.deliveryId)).toMatchObject({ state: "failed", lastError: "delivery TTL expired before target became available" });
    expect(outbox.listPending()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "delivery_outcome_notice", targetInstance: "source", state: "queued" }),
    ]));
    outbox.close();
  });

  it("does not spend submission attempts on repeated pre-begin readiness deferrals", () => {
    const outbox = new DeliveryOutbox(tempDb(), "manager-1");
    const row = outbox.admit(input()).delivery;
    for (let attempt = 1; attempt <= DURABLE_DELIVERY_MAX_ATTEMPTS + 1; attempt++) {
      const claimed = outbox.claimNext("manager-1", () => "target-boot-1", new Set())!;
      expect(claimed.attemptNo).toBe(attempt);
      expect(outbox.retryBeforeBegin(row.deliveryId, "target-boot-1", attempt, "readiness timeout", 0)).toBe(true);
    }
    expect(outbox.get(row.deliveryId)?.state).toBe("retry_wait");
    expect(outbox.get(row.deliveryId)?.lastError).toBe("readiness timeout");
    expect(outbox.listPending().filter(item => item.kind === "delivery_outcome_notice")).toHaveLength(0);
    outbox.close();
  });

  it("bounds actual pane submission attempts and atomically queues one notice", () => {
    vi.useFakeTimers();
    const outbox = new DeliveryOutbox(tempDb(), "manager-1");
    const row = outbox.admit(input()).delivery;
    for (let attempt = 1; attempt <= DURABLE_DELIVERY_MAX_ATTEMPTS; attempt++) {
      const claimed = outbox.claimNext("manager-1", () => "target-boot-1", new Set())!;
      expect(claimed.attemptNo).toBe(attempt);
      expect(outbox.begin(row.deliveryId, "target-boot-1", attempt)).toBe("begun");
      expect(outbox.abort(row.deliveryId, "target-boot-1", attempt, "pane confirmed no write")).toBe(true);
      vi.advanceTimersByTime(DURABLE_DELIVERY_ABORT_BACKOFF_MS + 1);
    }
    const exhausted = outbox.claimNext("manager-1", () => "target-boot-1", new Set())!;
    expect(exhausted.attemptNo).toBe(DURABLE_DELIVERY_MAX_ATTEMPTS + 1);
    expect(outbox.begin(row.deliveryId, "target-boot-1", exhausted.attemptNo)).toBe("stale");
    expect(outbox.get(row.deliveryId)?.state).toBe("failed");
    expect(outbox.listPending().filter(item => item.kind === "delivery_outcome_notice")).toHaveLength(1);
    outbox.close();
  });

  it("atomically notices uncertain submissions and never recursively notices a failed notice", () => {
    vi.useFakeTimers();
    const outbox = new DeliveryOutbox(tempDb(), "manager-1");
    const row = outbox.admit(input()).delivery;
    const claimed = outbox.claimNext("manager-1", () => "target-boot-1", new Set())!;
    expect(outbox.begin(row.deliveryId, "target-boot-1", claimed.attemptNo)).toBe("begun");
    expect(outbox.complete(row.deliveryId, "target-boot-1", claimed.attemptNo, "uncertain", "pane outcome unknown")).toBe(true);
    const notice = outbox.listPending().find(item => item.kind === "delivery_outcome_notice")!;
    expect(notice.payload.content).toContain("state=uncertain");
    expect(notice.payload.content).toContain("Do not resend");

    for (let attempt = 1; attempt <= DURABLE_DELIVERY_MAX_ATTEMPTS; attempt++) {
      const noticeClaim = outbox.claimNext("manager-1", () => "source-boot-1", new Set())!;
      expect(noticeClaim.deliveryId).toBe(notice.deliveryId);
      expect(outbox.begin(notice.deliveryId, "source-boot-1", attempt)).toBe("begun");
      expect(outbox.abort(notice.deliveryId, "source-boot-1", attempt, "source unavailable")).toBe(true);
      vi.advanceTimersByTime(DURABLE_DELIVERY_ABORT_BACKOFF_MS + 1);
    }
    const finalClaim = outbox.claimNext("manager-1", () => "source-boot-1", new Set())!;
    expect(outbox.begin(notice.deliveryId, "source-boot-1", finalClaim.attemptNo)).toBe("stale");
    expect(outbox.get(notice.deliveryId)?.state).toBe("failed");
    expect(outbox.listPending().filter(item => item.kind === "delivery_outcome_notice")).toHaveLength(0);
    outbox.close();
  });
});
