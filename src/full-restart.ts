import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
 * systemd, launchd, or the detached-process hand-off. Do not use
 * `fleet restart --reload` here: its SIGUSR1 path exits successfully, so a
 * systemd unit with Restart=on-failure would stay down and kill this helper as
 * part of the old service cgroup.
 */
export function launchFullRestartHelper(
  spawnProcess: SpawnProcess = spawn,
  cliEntry = join(dirname(fileURLToPath(import.meta.url)), "cli.js"),
): Promise<FullRestartHelperHandle> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(
        process.execPath,
        [cliEntry, "restart"],
        { detached: true, stdio: "ignore" },
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
