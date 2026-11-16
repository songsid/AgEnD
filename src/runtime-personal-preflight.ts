/** Local prompt rendering only; never starts a model turn and never returns the rendered private input. */
import { promisify } from "node:util";
import { statSync } from "node:fs";
import { win32 } from "node:path";
import { execFile } from "./child-process.js";
import { PersonalAgentStageError } from "./runtime-personal-stage.js";
import type { NativeCliExecutable } from "./windows-cli-worker.js";
import { PERSONAL_AGENT_READ_CHECK_FILE, PERSONAL_AGENT_READ_CHECK_TEXT, PERSONAL_CODEX_DISABLED_FEATURES, type PersonalProfilePlan } from "./runtime-personal-profile.js";
const exec = promisify(execFile);
/** Codex's Windows discovery prefers pwsh, then Windows PowerShell. Store launchers cannot run under MXC.
 * Resolve outside the sandbox: a denied pwsh must not silently become a passing Windows PowerShell probe. */
export function resolvePersonalCodexShell(environment: NodeJS.ProcessEnv, file: (path: string) => boolean = p => {
  try { return statSync(p).isFile(); } catch { return false; }
}): string | null {
  const paths = [...new Set(Object.entries(environment).filter(([key, value]) => key.toUpperCase() === "PATH" && value !== undefined).map(([, value]) => value!))];
  if (paths.length > 1 || (paths[0]?.length ?? 0) > 32_768) return null;
  const dirs = (paths[0] ?? "").split(";");
  if (dirs.length > 256) return null;
  const local = dirs.filter(p => /^[a-z]:[\\/]/i.test(p) && !/[\x00-\x1f<>|?*]/.test(p) && !p.slice(2).includes(":"));
  for (const [name, fallback] of [["pwsh.exe", "C:\\Program Files\\PowerShell\\7\\pwsh.exe"],
    ["powershell.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]]) {
    for (const path of [...local.map(p => win32.join(p, name)), fallback]) {
      if (/(?:^|[\\/])WindowsApps[\\/](?:pwsh\.exe$|powershell\.exe$|Microsoft\.PowerShell)/i.test(path)) continue;
      if (file(path)) return path;
    }
  }
  return null;
}
export function validatePersonalFeaturesOutput(text: string): void {
  const flags = new Map(text.split(/\r?\n/).flatMap(line => {
    const match = /^(\w+)\s+.+?\s+(true|false)\s*$/.exec(line);
    return match ? [[match[1], match[2]] as const] : [];
  }));
  if (PERSONAL_CODEX_DISABLED_FEATURES.some(name => flags.get(name) !== "false") || flags.get("skip_host_skill_discovery") !== "true")
    throw new PersonalAgentStageError("profile-unavailable");
}
export function validatePersonalPromptOutput(text: string): void {
  if (Buffer.byteLength(text) > 512 * 1024) throw new PersonalAgentStageError("profile-unavailable");
  let value: unknown; try { value = JSON.parse(text); } catch { throw new PersonalAgentStageError("profile-unavailable"); }
  if (!Array.isArray(value) || !value.length) throw new PersonalAgentStageError("profile-unavailable");
  // The CLI's stock developer text explains how skills work even when no skills are offered. Refuse the
  // actual injected catalog/instructions, not those generic instructions in the built-in prompt.
  for (const row of value) {
    const text = Array.isArray(row?.content) ? row.content.map((part: { text?: unknown }) => typeof part?.text === "string" ? part.text : "").join("\n") : "";
    const kinds: unknown = row?.internal_chat_message_metadata_passthrough?.content_item_kinds;
    if (/<skills_instructions>|^#{1,3} Skills\s*$|^# AGENTS\.md instructions for /im.test(text)
      || Array.isArray(kinds) && kinds.some(kind => typeof kind === "string" && /^(host_skills|user_instructions)\./.test(kind))) throw new PersonalAgentStageError("profile-unavailable");
  }
}
export async function checkPersonalCodexPrompt(binary: NativeCliExecutable, plan: PersonalProfilePlan, environment: NodeJS.ProcessEnv): Promise<void> {
  try {
    const flags = await exec(binary.command, [...binary.args, "-C", plan.cwd, "features", "list"],
      { cwd: plan.cwd, env: environment, encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 128 * 1024 });
    validatePersonalFeaturesOutput(flags.stdout);
    const rendered = await exec(binary.command, [...binary.args, "-C", plan.cwd, "debug", "prompt-input", "Personal-agent setup verification."],
      { cwd: plan.cwd, env: environment, encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 512 * 1024 });
    validatePersonalPromptOutput(rendered.stdout);
    // Explicit MXC refuses an unsupported host instead of provisioning legacy sandbox users, ACLs or a UAC prompt.
    try {
      const sandbox = await exec(binary.command, [...binary.args, "-C", plan.cwd, "sandbox", "-P", "hub-personal", "--", process.execPath, "-e", 'process.stdout.write("PERSONAL_PROFILE_READY")'],
        { cwd: plan.cwd, env: environment, encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 4096 });
      if (sandbox.stdout.trim() !== "PERSONAL_PROFILE_READY") throw Error("Sandbox did not start");
    } catch { throw new PersonalAgentStageError("sandbox-unavailable"); }
    // Node can work under MXC while PowerShell's FileSystem provider fails to initialize. Verify an actual
    // shell file read before marking the computer ready or spending a person's model request.
    const shell = resolvePersonalCodexShell(environment);
    if (!shell) throw new PersonalAgentStageError("profile-unavailable");
    const canary = win32.join(plan.cwd, PERSONAL_AGENT_READ_CHECK_FILE).replaceAll("'", "''");
    const read = await exec(binary.command, [...binary.args, "-C", plan.cwd, "sandbox", "-P", "hub-personal", "--", shell,
      "-NoProfile", "-NonInteractive", "-Command", `Get-Content -LiteralPath '${canary}' -Raw -ErrorAction Stop`],
      { cwd: plan.cwd, env: environment, encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 4096 });
    if (read.stdout.trim() !== PERSONAL_AGENT_READ_CHECK_TEXT) throw new PersonalAgentStageError("profile-unavailable");
  } catch (error) { throw error instanceof PersonalAgentStageError ? error : new PersonalAgentStageError("profile-unavailable"); }
}
