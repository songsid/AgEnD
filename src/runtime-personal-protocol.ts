/** The opted-in personal Runtime is an execution boundary, not an ordinary Fleet Runtime. */
import { isPersonalAgentCli } from "./runtime-personal-answer.js";
import type { NativeTaskInput } from "./windows-cli-worker.js";
export const PERSONAL_AGENT_PROFILE = "personal-agent-v1";
export const PERSONAL_AGENT_ANSWER_ONLY_PROFILE = "personal-agent-answer-only-v1";
export type PersonalProfile = typeof PERSONAL_AGENT_PROFILE | typeof PERSONAL_AGENT_ANSWER_ONLY_PROFILE;
export const isPersonalProfile = (value: unknown): value is PersonalProfile => value === PERSONAL_AGENT_PROFILE || value === PERSONAL_AGENT_ANSWER_ONLY_PROFILE;
export type PersonalCliStatus = "ready" | "sandbox-unavailable" | "profile-unavailable";
export const PERSONAL_TASK_FAILURES = ["failed", "interrupted", "incomplete", "empty", "protocol", "output-limit", "unsupported-platform", "folder-invalid", "authentication-unavailable", "profile-unavailable", "sandbox-unavailable", "timeout", "action-refused"] as const;
export type PersonalTaskFailure = typeof PERSONAL_TASK_FAILURES[number];
export const personalTaskFailure = (value: unknown): value is PersonalTaskFailure => typeof value === "string" && (PERSONAL_TASK_FAILURES as readonly string[]).includes(value);
export function assertPersonalTask(task: NativeTaskInput, options: Record<string, unknown>): void {
  if ((options.answerOnly === true || options.profile === PERSONAL_AGENT_ANSWER_ONLY_PROFILE) && (task.cli !== "codex" || !task.model)) throw Error("Answer only requires Codex and an explicit model");
  if (!isPersonalAgentCli(task.cli) || task.sandbox !== "read-only"
    || ["resumeSessionId", "mcp", "credentialProfile", "credentialHome", "context"].some(k => options[k] !== undefined)) throw Error("Personal agent requires an isolated read-only one-shot task");
}
