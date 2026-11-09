/**
 * start the Runtime again every time this Windows user signs in, with a per-user scheduled task.
 *
 * Deliberately not a Windows Service and not a system task: the task belongs to the signed-in user, runs with that user's ordinary (limited) rights, is
 * created and removed without a UAC prompt, and only runs while that user is signed in, which is exactly when their Windows CLIs and sign-ins exist.
 * The task does not keep the Runtime running itself. At sign-in it runs a short command, `agend-runtime start --profile <folder>`, which launches the detached
 * background Runtime (or finds it already running) and ends. One task per profile, named after the profile.
 *
 * The task is registered from an XML definition through the Task Scheduler's own `schtasks.exe` (no PowerShell, no module, no shell: arguments only), so what is
 * asked of Windows is one reviewable text. Nothing in it names a password, SYSTEM, "run whether the user is signed in or not" or "highest privileges".
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { userInfo } from "node:os";
import { execFile } from "./child-process.js";

export const AUTOSTART_TASK_PREFIX = "AgEnD Runtime - ";
/** The trigger waits a little after sign-in so the network (a VPN such as Tailscale) has a chance to be up; the Runtime reconnects by itself either way. */
export const AUTOSTART_DELAY_SECONDS = 20;

export function autostartTaskName(label: string): string {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(label)) throw new Error("Invalid Runtime profile name for a scheduled task");
  return `${AUTOSTART_TASK_PREFIX}${label}`;
}
export interface AutostartAction { command: string; args: string }
const forbidden = /["%\r\n\0<>|&^]/;
/** A path the task can carry: no quote, `%` (Task Scheduler expands it), `& ^ | < >` or line break. A Windows user name may contain `%`, so a profile path or an install path can too. */
function carryable(path: string): string {
  if (forbidden.test(path)) throw new Error(`The path ${JSON.stringify(path)} contains a character a scheduled task cannot carry safely (a quote, %, & ^ | < > or a line break). Move the install or the profile folder, then run agend-runtime autostart enable again.`);
  return path;
}
const quoted = (path: string): string => `"${carryable(path)}"`;
/**
 * What the task runs. A managed install (`<root>\bin\agend-runtime.cmd` next to the version folders) runs that shim, which always starts the newest installed
 * version, so signing in after an update starts the update. A ZIP or other layout runs this very node and script.
 */
export function autostartAction(input: { cliPath: string; execPath: string; profile: string; shimExists?: (path: string) => boolean }): AutostartAction {
  const versionFolder = dirname(dirname(input.cliPath)), shim = join(dirname(versionFolder), "bin", "agend-runtime.cmd");
  const managed = basename(dirname(input.cliPath)) === "dist" && (input.shimExists ?? existsSync)(shim);
  const tail = `start --profile ${quoted(input.profile)}`;
  // The program itself goes into <Command> as it is (spaces are fine there), but it gets the same character check as every path in the arguments.
  return managed ? { command: carryable(shim), args: tail } : { command: carryable(input.execPath), args: `${quoted(input.cliPath)} ${tail}` };
}
const xml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
/** The task definition. The principal is the current user with their ordinary token and least privilege; the trigger is that user's sign-in. */
export function buildAutostartTaskXml(input: { label: string; user: string; action: AutostartAction; workingDirectory?: string }): string {
  if (!input.user || /[\r\n\0]/.test(input.user)) throw new Error("The Windows user name is unavailable");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xml(`Reconnects the AgEnD Runtime (profile ${input.label}) when you sign in. Created by agend-runtime autostart enable; remove it with agend-runtime autostart disable.`)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(input.user)}</UserId>
      <Delay>PT${AUTOSTART_DELAY_SECONDS}S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(input.user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(input.action.command)}</Command>
      <Arguments>${xml(input.action.args)}</Arguments>${input.workingDirectory ? `
      <WorkingDirectory>${xml(input.workingDirectory)}</WorkingDirectory>` : ""}
    </Exec>
  </Actions>
</Task>
`;
}
/** schtasks.exe reads a UTF-16 definition with a byte-order mark. */
export function encodeTaskXml(text: string): Buffer { return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]); }

export interface SchtasksResult { code: number; output: string; /** schtasks' own stdout, unchanged (a task list names every task, in any language); for a caller that must look inside it. */ raw?: string }
export type RunSchtasks = (args: string[]) => Promise<SchtasksResult>;
function systemTool(name: string, env: NodeJS.ProcessEnv = process.env): string { return join(env.SystemRoot || env.windir || "C:\\Windows", "System32", name); }
/** schtasks.exe with arguments only (never a shell). Its words come back in the console's code page, so only a short, printable slice of them is kept. */
export const runSchtasks: RunSchtasks = args => new Promise(done => {
  execFile(systemTool("schtasks.exe"), args, { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024, encoding: "utf8", shell: false }, (error, stdout, stderr) => {
    const output = `${stdout ?? ""}\n${stderr ?? ""}`.replace(/[^\x20-\x7e\r\n]/g, "").trim().slice(0, 400);
    done({ code: error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0, output, raw: String(stdout ?? "") });
  });
});
/** `DOMAIN\user`, the form the Task Scheduler wants for the one signed-in account. */
export function currentWindowsUser(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.USERNAME || userInfo().username, domain = env.USERDOMAIN;
  return domain ? `${domain}\\${name}` : name;
}

export interface AutostartService {
  /** Creates or replaces this profile's sign-in task. Throws a plain explanation when Windows refuses. */
  enable(input: { label: string; profile: string; cliPath: string; execPath: string; workFolder: string }): Promise<void>;
  /** Removes it; true when there was one. */
  disable(label: string): Promise<boolean>;
  exists(label: string): Promise<boolean>;
}
export interface AutostartDeps { run?: RunSchtasks; user?: () => string; shimExists?: (path: string) => boolean }
export function createAutostartService(deps: AutostartDeps = {}): AutostartService {
  const run = deps.run ?? runSchtasks;
  /**
   * Whether the task exists. A failing `/Query /TN` can mean "no such task" or "schtasks itself is broken", and its words are in the console's language, so they cannot
   * tell the two apart. Only a task LIST that Windows produced (exit 0) and that does not name the task is "no task"; if even the list fails, this throws instead of
   * answering, and the caller says so rather than pretending there was nothing to remove.
   */
  const exists = async (label: string): Promise<boolean> => {
    const name = autostartTaskName(label);
    if ((await run(["/Query", "/TN", name])).code === 0) return true;
    const list = await run(["/Query", "/FO", "CSV", "/NH"]);
    if (list.code !== 0) throw new Error(`Windows did not say whether the sign-in task "${name}" exists (${list.output || `exit status ${list.code}`}). Open Task Scheduler and look for it in the library's root.`);
    return (list.raw ?? list.output).toLowerCase().includes(`"\\${name.toLowerCase()}"`);   // the CSV lists `"\TaskName","next run","status"`; task names are case-insensitive
  };
  return {
    exists,
    async enable(input) {
      const name = autostartTaskName(input.label);
      const action = autostartAction({ cliPath: input.cliPath, execPath: input.execPath, profile: input.profile, ...(deps.shimExists ? { shimExists: deps.shimExists } : {}) });
      const definition = encodeTaskXml(buildAutostartTaskXml({ label: input.label, user: (deps.user ?? currentWindowsUser)(), action, workingDirectory: input.profile }));   // the profile folder, not a version folder: those may be cleaned up later, the task must keep working
      mkdirSync(input.workFolder, { recursive: true });
      const file = join(input.workFolder, "autostart-task.xml");
      writeFileSync(file, definition);
      try {
        const result = await run(["/Create", "/TN", name, "/XML", file, "/F"]);
        if (result.code !== 0) throw new Error(`Windows did not create the sign-in task "${name}" (${result.output || `exit status ${result.code}`}). The Runtime itself is not affected; run agend-runtime autostart enable to try again, or start it yourself after signing in with agend-runtime start.`);
      } finally { try { rmSync(file, { force: true }); } catch { /* a leftover definition holds no secret */ } }
    },
    async disable(label) {
      if (!await exists(label)) return false;
      const result = await run(["/Delete", "/TN", autostartTaskName(label), "/F"]);
      if (result.code !== 0) throw new Error(`Windows did not remove the sign-in task "${autostartTaskName(label)}" (${result.output || `exit status ${result.code}`}). Remove it in Task Scheduler (it is in the library's root), or run agend-runtime autostart disable again.`);
      return true;
    },
  };
}
