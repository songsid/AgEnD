import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Synchronous evidence before shutdown: neither a network nor logger worker is required. */
export function recordFleetFatal(dataDir: string, error: unknown): void {
  mkdirSync(dataDir, { recursive: true });
  const fd = openSync(join(dataDir, "fleet-fatal.log"), "a", 0o600);
  try {
    writeSync(fd, JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid,
      argv: process.argv, reason: "uncaughtException", error: String(error),
      stack: error instanceof Error ? error.stack : undefined }) + "\n");
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

interface FleetProcessOptions {
  dataDir: string;
  manager: { stopAll(): Promise<void>; notifyFleetError(message: string): void };
  runtime: Pick<NodeJS.Process, "on" | "exit">;
  describeSignal: () => string;
  console?: Pick<Console, "log" | "error">;
  writeFatal?: typeof recordFleetFatal;
}

/** Identical process policy for cold start and the legacy in-process reload. */
export function installFleetProcessHandlers(options: FleetProcessOptions): { readonly stopping: boolean } {
  const { runtime, manager } = options;
  const output = options.console ?? console;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    output.log("\nStopping fleet...");
    // stopAll fences new controls and drains CPU profiles before disposal.
    await manager.stopAll().catch(error => output.error("Shutdown error:", error));
    runtime.exit(0);
  };
  runtime.on("SIGINT", shutdown);
  runtime.on("SIGTERM", () => {
    output.log(options.describeSignal());
    return shutdown();
  });
  runtime.on("uncaughtException", async error => {
    output.error("Uncaught exception:", error);
    try { (options.writeFatal ?? recordFleetFatal)(options.dataDir, error); }
    catch (writeError) { output.error("Failed to persist fleet fatal reason:", writeError); }
    if (stopping) return;
    stopping = true;
    // Arbitrary uncaught exceptions still leave unknown state and remain fatal.
    await manager.stopAll().catch(() => {});
    runtime.exit(1);
  });
  runtime.on("unhandledRejection", error => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("409") && message.includes("getUpdates")) {
      output.error("Bot polling conflict (409) — retrying...");
      return;
    }
    output.error("Unhandled rejection (fleet continues):", error);
    if (error instanceof Error && error.stack) output.error(error.stack);
    try {
      manager.notifyFleetError(`⚠️ Fleet caught an unhandled error and kept running:\n\`${message}\`\nSee fleet.log for the stack trace.`);
    } catch (notifyError) { output.error("Failed to report unhandled rejection:", notifyError); }
  });
  return { get stopping() { return stopping; } };
}
