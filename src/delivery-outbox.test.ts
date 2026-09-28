import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { DeliveryOutbox, type NewOutboxDelivery } from "./delivery-outbox.js";

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

  it("survives killing the writer process after its SQLite admission commit", async () => {
    const dbPath = tempDb();
    const storeUrl = pathToFileURL(join(process.cwd(), "src/delivery-outbox.ts")).href;
    const managerUrl = pathToFileURL(join(process.cwd(), "src/fleet-manager.ts")).href;
    const script = [
      `import { FleetManager } from ${JSON.stringify(managerUrl)};`,
      `import { DeliveryOutbox } from ${JSON.stringify(storeUrl)};`,
      `const manager = new FleetManager(${JSON.stringify(dirname(dbPath))});`,
      `const outbox = new DeliveryOutbox(${JSON.stringify(dbPath)}, manager.managerBootId);`,
      `manager.deliveryOutbox = outbox;`,
      `manager.lifecycle.daemons.set("source", { bootId: "source-boot-1" });`,
      `manager.admitDurableDelivery({ operationId: "op-1", sourceDaemonBootId: "source-boot-1", sourceInstance: "source", targetInstance: "worker", kind: "fleet_inbound", correlationId: "same-correlation", payload: { type: "fleet_inbound", content: "hello", meta: {} } });`,
      `process.stdout.write("committed\\n");`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    const committed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("writer child did not commit in time")), 10_000);
      lines.once("line", line => {
        clearTimeout(timer);
        if (line === "committed") resolve();
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
    const restarted = new DeliveryOutbox(dbPath, replacementManager.managerBootId);
    replacementManager.deliveryOutbox = restarted;
    (replacementManager as any).shuttingDown = true;
    replacementManager.lifecycle.daemons.set("source", { bootId: "source-boot-2" } as any);
    const recovered = restarted.recoverForBoot(replacementManager.managerBootId);
    replacementManager.onDaemonReady("source", "source-boot-2");
    expect(restarted.listPending()).toMatchObject([
      { operationId: "op-1", targetInstance: "worker", state: "queued", payload: { content: "hello" } },
      { operationId: expect.stringContaining("notice:source-boot-1:op-1:worker"), targetInstance: "source", state: "queued" },
    ]);
    expect(recovered).toEqual({ queued: 0, uncertain: 0 });
    expect(restarted.getUnansweredAccepted("source", "source-boot-2")).toHaveLength(1);
    restarted.close();
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
    expect(outbox.recoverTargetGeneration("worker", "target-boot-3").uncertain).toBe(1);
    expect(outbox.get(claimed.deliveryId)?.state).toBe("uncertain");
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
});
