/** Detached native Node owner: Windows PowerShell needs an attached launch, even with redirected pipes. */
import { spawn } from "./child-process.js";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validWindowsAgentId, validWindowsDirectory, nativeCliEnvironment } from "./windows-cli-worker.js";

export function runPaneJobOwner(args: string[]): void {
  const [directory, launch, pane, agent, owner] = args;
  if (process.platform !== "win32" || args.length !== 5 || !validWindowsDirectory(directory)
    || ![launch, pane, agent].every(validWindowsAgentId) || !/^[1-9]\d{0,9}$/.test(owner)) throw Error("Invalid local pane owner");
  // Only fixed program paths. The private first stdin frame still controls the validated configured CLI.
  const child = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./runtime-pane-job.ps1", import.meta.url)),
    "-NodePath", process.execPath, "-WorkerPath", fileURLToPath(new URL("./runtime-pane-worker.js", import.meta.url)),
    "-StateDirectory", directory, "-LaunchId", launch, "-PaneId", pane, "-AgentId", agent,
    "-OwnerPid", owner, "-ReceiptPid", String(process.pid),
  ], { windowsHide: true, shell: false, env: nativeCliEnvironment(), stdio: "inherit" });
  child.on("error", () => { process.exitCode = 1; });
  child.on("close", code => { process.exitCode = code ?? 1; });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runPaneJobOwner(process.argv.slice(2)); } catch { process.exitCode = 1; }
}
