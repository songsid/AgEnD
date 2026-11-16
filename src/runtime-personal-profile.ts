/** Local Runtime-only launch plan. Network callers never supply these profile paths or configuration. */
import { win32 } from "node:path";
import { validateNativeModel } from "./windows-cli-providers.js";
import { isPersonalAgentCli, type PersonalAgentCli } from "./runtime-personal-answer.js";
import { answerOnlyFiles, answerOnlyPrompt, ANSWER_ONLY_CATALOG_FILE } from "./runtime-personal-answer-only.js";

export const PERSONAL_AGENT_DEADLINE_MS = 300_000;
export const PERSONAL_AGENT_READ_CHECK_FILE = ".personal-read-check";
export const PERSONAL_AGENT_READ_CHECK_TEXT = "PERSONAL_PROFILE_READY";
/** These tools can read outside a command sandbox or inherit personal setup. Verify the effective flags before each turn. */
export const PERSONAL_CODEX_DISABLED_FEATURES = ["apps", "plugins", "remote_plugin", "hooks", "skill_search", "multi_agent", "code_mode",
  "view_image", "image_generation", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "in_app_browser", "computer_use", "shell_snapshot"] as const;
export interface PersonalFolderContext {
  home: string;
  systemRoots: readonly string[];
  privateRoots: readonly string[];
}
function path(value: string): string {
  if (typeof value !== "string" || value.length > 1024 || !/^[a-z]:[\\/]/i.test(value)
    || /[\x00-\x1f\x7f<>|?*]/.test(value) || value.slice(2).includes(":")) throw Error("Invalid personal-agent folder");
  const normalized = win32.normalize(value);
  if (normalized.split(/[\\/]/).slice(1).some(s => s && /[. ]$/.test(s))) throw Error("Invalid personal-agent folder");
  return normalized.replace(/\\+$/, "") || normalized;
}
const within = (base: string, child: string): boolean => {
  const r = win32.relative(base.toLowerCase(), child.toLowerCase());
  return !r || !win32.isAbsolute(r) && r !== ".." && !r.startsWith("..\\");
};
/** The caller supplies the realpath observed on the Windows computer, never a browser's claim of it. */
export function personalAgentFolder(value: string, canonical: string, context: PersonalFolderContext): string {
  const selected = path(value), actual = path(canonical), home = path(context.home);
  if (selected.toLowerCase() !== actual.toLowerCase() || /^[a-z]:$/i.test(actual)
    || within(actual, home) || context.systemRoots.some(p => within(path(p), actual))
    || context.privateRoots.some(p => within(path(p), actual) || within(actual, path(p)))) throw Error("Choose a separate folder to share with the personal agent");
  return actual;
}
const toml = (s: string) => JSON.stringify(s).replace(/\x7f/g, "\\u007f");
const uniquePaths = (values: readonly string[]) => [...new Map(values.map(p => [p.toLowerCase(), p])).values()];
export interface PersonalProfileInput {
  cli: PersonalAgentCli;
  answerOnly?: boolean;
  question: string;
  folder: string;
  canonicalFolder: string;
  context: PersonalFolderContext;
  /** Fresh sibling directories owned by this job; work contains an empty repository to stop ancestor discovery. */
  work: string;
  home: string;
  /** CLI/runtime binary directories selected locally by the runner, not arbitrary shared directories. */
  runtimeReads: readonly string[];
  /** Every skill discovered in the controlled profile, including provider-bundled system skills. */
  disabledSkills: readonly string[];
  model?: string;
}
export interface PersonalProfilePlan {
  cwd: string;
  args: string[];
  stdin: string;
  environment: Record<string, string>;
  files: Readonly<Record<string, string>>;
  deadlineMs: number;
  answerOnly?: true;
}
/** Does no I/O or execution. The worker must stage a fresh auth-only home and validate its final prompt before spawn. */
export function personalAgentProfile(input: PersonalProfileInput): PersonalProfilePlan {
  if (!isPersonalAgentCli(input.cli)) throw Error("Unsupported personal agent CLI");
  if (typeof input.question !== "string" || !input.question.trim() || input.question.length > 16_384 || input.question.includes("\0")) throw Error("Invalid personal-agent question");
  const work = path(input.work), home = path(input.home);
  if (/^[a-z]:$/i.test(work) || /^[a-z]:$/i.test(home) || within(work, home) || within(home, work)) throw Error("Personal-agent profile needs separate private directories");
  const folder = personalAgentFolder(input.folder, input.canonicalFolder, { ...input.context, privateRoots: [...input.context.privateRoots, work, home] });
  if (input.runtimeReads.length > 16 || input.disabledSkills.length > 512) throw Error("Personal-agent profile is too large");
  const runtimeReads = uniquePaths(input.runtimeReads.map(path)), skills = uniquePaths(input.disabledSkills.map(path));
  if (runtimeReads.some(p => /^[a-z]:$/i.test(p) || within(p, input.context.home) || within(p, home))) throw Error("Personal-agent runtime read roots are too broad");
  const model = validateNativeModel(input.model), withModel = model ? ["--model", model] : [];
  const base = { cwd: work, stdin: `Answer the question using only the shared folder ${folder}. Do not change files or request approval.\n\nQuestion:\n${input.question}`, deadlineMs: PERSONAL_AGENT_DEADLINE_MS };
  const environment = { HOME: home, USERPROFILE: home, HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2),
    APPDATA: win32.join(home, "AppData", "Roaming"), LOCALAPPDATA: win32.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: win32.join(home, ".config"), XDG_DATA_HOME: win32.join(home, ".local", "share"), XDG_STATE_HOME: win32.join(home, ".local", "state"),
    DISABLE_AUTOUPDATER: "1" };
  if (input.answerOnly) {
    if (input.cli !== "codex" || !model) throw Error("Answer only needs Codex and a locally reported model");
    return { ...base, answerOnly: true, stdin: answerOnlyPrompt(input.question),
      args: ["exec", "--json", "--ephemeral", "--ignore-rules", "--skip-git-repo-check", "-C", work, ...withModel, "-"],
      environment: { ...environment, CODEX_HOME: home },
      files: answerOnlyFiles({ model, catalogFile: win32.join(home, ANSWER_ONLY_CATALOG_FILE), work, home, disabledSkills: skills }) };
  }
  if (input.cli === "claude-code") return { ...base,
    args: ["--print", "--verbose", "--input-format", "text", "--output-format", "stream-json", "--safe-mode", "--restricted", "--disable-slash-commands",
      "--setting-sources", "", "--settings", JSON.stringify({ disableAllHooks: true, disableClaudeAiConnectors: true, disableBundledSkills: true,
        permissions: { blockWritesOutsideWorkingDirectories: true } }), "--permission-prompts", "none", "--permission-mode", "plan", "--tools", "Read,Glob,Grep",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence", "--no-chrome", "--add-dir", folder, ...withModel],
    environment: { ...environment, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ENABLE_TOOL_SEARCH: "false" }, files: {} };
  // Do not append --sandbox: that older option overrides the named read-root profile.
  const config = `approval_policy = "never"\ndefault_permissions = "hub-personal"\nproject_doc_max_bytes = 0\nweb_search = "disabled"\ncheck_for_update_on_startup = false\n` +
    `[windows]\nsandbox = "mxc"\n` +
    `[features]\n${PERSONAL_CODEX_DISABLED_FEATURES.map(name => `${name} = false\n`).join("")}skip_host_skill_discovery = true\n` +
    `[permissions.hub-personal.filesystem]\n":root" = "deny"\n":minimal" = "read"\n${uniquePaths([work, folder, ...runtimeReads]).map(p => `${toml(p)} = "read"`).join("\n")}\n` +
    `[permissions.hub-personal.network]\nenabled = false\n${skills.map(p => `\n[[skills.config]]\npath = ${toml(p)}\nenabled = false\n`).join("")}`;
  return { ...base, args: ["exec", "--json", "--ephemeral", "--ignore-rules", "--skip-git-repo-check", "-C", work, ...withModel, "-"],
    environment: { ...environment, CODEX_HOME: home }, files: { "config.toml": config } };
}
