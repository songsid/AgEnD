import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "./child-process.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withOrigin } from "./fleet-control-audit.js";
import { canonicalCliEntry } from "./cli-entry.js";

export interface FullRestartHelperCompletion {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: unknown;
}

export interface FullRestartHelperHandle {
  completion: Promise<FullRestartHelperCompletion>;
}

type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/**
 * Start the canonical environment-aware service restart and wait until the OS
 * has actually spawned it. The top-level `agend restart` command selects
 * systemd, launchd, or the detached-process hand-off. It is the only full
 * restart (#2356): the old `fleet restart --reload` SIGUSR1 path exited 0, so a
 * systemd unit with Restart=on-failure stayed down and killed its caller with
 * the old service cgroup.
 */
export function launchFullRestartHelper(
  spawnProcess: SpawnProcess = spawn,
  cliEntry = canonicalCliEntry(),
): Promise<FullRestartHelperHandle> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(
        process.execPath,
        [cliEntry, "restart"],
        { detached: true, stdio: "ignore", env: withOrigin("full-restart-helper") },
      );
    } catch (err) {
      reject(err);
      return;
    }

    const completion = new Promise<FullRestartHelperCompletion>(complete => {
      child.once("exit", (code, signal) => complete({ code, signal }));
      // Keep a post-spawn error from becoming an unhandled EventEmitter error.
      // The old fleet can turn it into a visible failed progress state if it is
      // still alive; after the service restart begins, the new fleet owns the
      // persisted marker.
      child.once("error", error => complete({ code: null, signal: null, error }));
    });

    const failSpawn = (err: unknown) => reject(err);
    child.once("error", failSpawn);
    child.once("spawn", () => {
      child.removeListener("error", failSpawn);
      child.unref();
      resolve({ completion });
    });
  });
}
