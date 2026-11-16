/** Local prompt rendering only; never starts a model turn and never returns the rendered private input. */
import { promisify } from "node:util";
import { execFile } from "./child-process.js";
import { PersonalAgentStageError } from "./runtime-personal-stage.js";
import type { NativeCliExecutable } from "./windows-cli-worker.js";
import { PERSONAL_CODEX_DISABLED_FEATURES, type PersonalProfilePlan } from "./runtime-personal-profile.js";
const exec = promisify(execFile);
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
  } catch { throw new PersonalAgentStageError("profile-unavailable"); }
}
