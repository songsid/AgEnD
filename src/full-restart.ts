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
 * Start the existing environment-aware reload wrapper and wait until the OS has
 * actually spawned it. The helper, not the chat-facing fleet process, owns
 * SIGUSR1 plus the systemd/launchd/detached hand-off. This matters for detached
 * fleets: a direct SIGUSR1 would stop the only process without replacing it.
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
        [cliEntry, "fleet", "restart", "--reload"],
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
      // still alive; after SIGUSR1, the new fleet owns the persisted marker.
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
