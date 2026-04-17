/**
 * zod schemas for outbound tool-call args.
 *
 * Single source of truth for both runtime validation (in outbound-handlers.ts)
 * and JSON Schema generation for MCP tool listings (in channel/mcp-tools.ts).
 */
import { z } from "zod";

// ── Shared field schemas ────────────────────────────────────────────────
// Reused across multiple tools; declaring once avoids drift.

const NonEmptyString = z.string().min(1);

// ── Instance management ─────────────────────────────────────────────────

export const ListInstancesArgs = z.object({
  tags: z.array(z.string()).optional().describe("Filter by tags"),
});

export const DescribeInstanceArgs = z.object({
  name: NonEmptyString.describe("Instance name to describe."),
});

export const StartInstanceArgs = z.object({
  name: NonEmptyString.describe("The instance name to start (from list_instances)"),
});

export const DeleteInstanceArgs = z.object({
  name: NonEmptyString.describe("The instance name to delete (from list_instances)"),
  delete_topic: z.boolean().optional()
    .describe("Whether to also delete the Telegram topic. Defaults to false."),
});

export const ReplaceInstanceArgs = z.object({
  name: NonEmptyString.describe("The instance name to replace"),
  reason: z.string().optional()
    .describe("Why the instance is being replaced (e.g. 'context polluted', 'stuck in loop')"),
});

// create_instance accepts the externally documented fields. passthrough() keeps
// any unknown keys so internal callers (deploy_template) can forward extras
// (profile-derived fields, start_point, …) without the schema stripping them.
export const CreateInstanceArgs = z.object({
  directory: z.string().optional().describe(
    "Absolute path or ~-prefixed path to the project directory. Optional — omit to auto-create a workspace at ~/.agend/workspaces/<name>.",
  ),
  topic_name: z.string().optional().describe(
    "Name for the Telegram topic. Defaults to directory basename. Required when directory is omitted.",
  ),
  description: z.string().optional().describe(
    "Human-readable description of what this instance does (e.g., 'Daily secretary for scheduling and reminders').",
  ),
  model: z.string().optional().describe(
    "Model to use. Claude: sonnet, opus, haiku, opusplan, best, sonnet[1m], opus[1m]. Codex: gpt-4o, o3. Gemini: gemini-2.5-pro. Omit for default.",
  ),
  backend: z.enum(["claude-code", "gemini-cli", "codex", "opencode", "kiro-cli"]).optional()
    .describe("CLI backend to use. Defaults to claude-code."),
  branch: z.string().optional().describe(
    "Git branch name. When specified, creates a git worktree from the directory's repo and uses it as the working directory. If the branch doesn't exist, it will be created.",
  ),
  detach: z.boolean().optional().describe(
    "Use detached HEAD (read-only). Useful for review instances that shouldn't commit to the branch.",
  ),
  worktree_path: z.string().optional().describe(
    "Custom path for the git worktree. Defaults to sibling directory of the repo.",
  ),
  systemPrompt: z.string().optional().describe(
    "Custom system prompt. Supports comma-separated file: paths for modularization (e.g. 'file:prompts/role.md, file:prompts/rules.md'). Injected after fleet context.",
  ),
  tags: z.array(z.string()).optional().describe("Tags for categorization and filtering."),
  workflow: z.string().optional().describe(
    "Workflow template. 'builtin' (default), 'false' to disable, or custom text.",
  ),
}).passthrough();

// ── Teams ───────────────────────────────────────────────────────────────

export const ListTeamsArgs = z.object({});

// ── Fleet Templates ─────────────────────────────────────────────────────

export const TeardownDeploymentArgs = z.object({
  name: NonEmptyString.describe("Deployment name (as used in deploy_template)."),
});

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Validate raw args with a zod schema. Returns a tagged result so callers can
 * propagate a clean error message to the agent without leaking internals.
 */
export function validateArgs<T>(
  schema: z.ZodType<T>,
  args: unknown,
  toolName: string,
): { ok: true; data: T } | { ok: false; error: string } {
  const parsed = schema.safeParse(args);
  if (parsed.success) return { ok: true, data: parsed.data };
  const detail = parsed.error.issues
    .map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error: `Invalid args for ${toolName}: ${detail}` };
}
