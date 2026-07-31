import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

// Four health-check exits set healthCheckPaused = true and returned without telling
// anyone: a clean CLI exit, max_retries <= 0, crash retries exhausted, and the
// instance directory being deleted. Only the crash-LOOP case emitted an event, so a
// fleet could quietly contain a dead instance that still looked fine on the
// dashboard — while messages routed to it queued or failed with a bare ❌.

describe("supervision_ended is reported to the operator", () => {
  it("is emitted by the daemon with a cause and a remedy", async () => {
    // Exercised through the daemon's own emitter rather than a full health tick:
    // the four call sites all funnel through emitSupervisionEnded.
    const { Daemon } = await import("../src/daemon.js");
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-sup-"));
    const daemon = Object.create(Daemon.prototype) as EventEmitter & {
      name: string;
      emitSupervisionEnded(reason: string, remedy: string): void;
    };
    EventEmitter.call(daemon as unknown as EventEmitter);
    Object.assign(daemon, { name: "alpha", instanceDir });

    const seen: unknown[] = [];
    daemon.on("supervision_ended", d => seen.push(d));
    daemon.emitSupervisionEnded("the CLI exited normally (code 0)", "Start it again when you need it.");

    expect(seen).toEqual([{
      name: "alpha",
      reason: "the CLI exited normally (code 0)",
      remedy: "Start it again when you need it.",
    }]);
  });
});

describe("rejected config reloads are reported", () => {
  function makeFleet() {
    const fm = new FleetManager(mkdtempSync(join(tmpdir(), "agend-reload-")));
    const notify = vi.fn();
    (fm as unknown as { notifyFleetError: unknown }).notifyFleetError = notify;
    return { fm, notify };
  }

  it("reports a validation failure with the offending paths", async () => {
    const { fm, notify } = makeFleet();
    const internals = fm as unknown as {
      configPath: string;
      fleetConfig: unknown;
      rawFleetConfig: unknown;
      loadConfig(path: string): void;
      reconcileInstances(): Promise<void>;
    };
    internals.configPath = "/tmp/does-not-matter.yaml";
    internals.fleetConfig = { defaults: {}, instances: { alpha: {} } };
    // loadConfig succeeds but produces a config the validator rejects.
    internals.loadConfig = () => {
      internals.fleetConfig = { defaults: {}, instances: { alpha: {} } };
      internals.rawFleetConfig = { channel: "not-a-mapping", instances: { alpha: {} } };
    };

    await internals.reconcileInstances();

    expect(notify).toHaveBeenCalledOnce();
    const text = notify.mock.calls[0][0] as string;
    expect(text).toContain("REJECTED");
    expect(text).toContain("validation failed");
    expect(text).toContain("still running");
  });

  it("reports a reload that would delete every instance", async () => {
    const { fm, notify } = makeFleet();
    const internals = fm as unknown as {
      configPath: string;
      fleetConfig: unknown;
      rawFleetConfig: unknown;
      loadConfig(path: string): void;
      reconcileInstances(): Promise<void>;
    };
    internals.configPath = "/tmp/does-not-matter.yaml";
    internals.fleetConfig = { defaults: {}, instances: { alpha: {}, beta: {} } };
    internals.loadConfig = () => {
      internals.fleetConfig = { defaults: {}, instances: {} };
      internals.rawFleetConfig = { channel: { type: "telegram", bot_token_env: "T", access: { mode: "open" } }, instances: {} };
    };

    await internals.reconcileInstances();

    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][0]).toContain("removed every instance");
  });

  it("reports a parse failure from the SIGHUP path", async () => {
    const { fm, notify } = makeFleet();
    const internals = fm as unknown as {
      startupComplete: boolean;
      reconcileInstances(): Promise<void>;
      scheduleReconcile(): void;
      reconcileInFlight: Promise<void> | null;
    };
    internals.startupComplete = true;
    internals.reconcileInstances = () => Promise.reject(new Error("bad indentation at line 12"));

    internals.scheduleReconcile();
    await internals.reconcileInFlight;

    expect(notify).toHaveBeenCalledOnce();
    const text = notify.mock.calls[0][0] as string;
    expect(text).toContain("FAILED");
    expect(text).toContain("bad indentation at line 12");
  });

  it("says nothing when the reload succeeds", async () => {
    const { fm, notify } = makeFleet();
    const internals = fm as unknown as {
      startupComplete: boolean;
      reconcileInstances(): Promise<void>;
      scheduleReconcile(): void;
      reconcileInFlight: Promise<void> | null;
    };
    internals.startupComplete = true;
    internals.reconcileInstances = () => Promise.resolve();

    internals.scheduleReconcile();
    await internals.reconcileInFlight;

    expect(notify).not.toHaveBeenCalled();
  });
});
