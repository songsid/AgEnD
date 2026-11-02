/** Shared, side-effect-free validation for native creation and its settings confirmation. */
import { z } from "zod";

export const NativeInstanceCreateArgs = z.object({
  runtime: z.literal("windows"), topic_name: z.string().max(64).optional(),
  machineId: z.string().uuid().optional(), directory: z.string().max(1024).optional(),
  backend: z.enum(["codex", "claude-code", "antigravity", "grok", "kiro-cli", "opencode", "muse"]).default("codex"),
  model: z.string().max(160).optional(), description: z.string().max(512).optional(),
  systemPrompt: z.string().max(8000).optional(), sandbox: z.enum(["read-only", "workspace-write"]).default("read-only"),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
}).strict();

export function parseNativeInstanceCreate(body: unknown) {
  const parsed = NativeInstanceCreateArgs.parse(body);
  const name = parsed.topic_name?.trim() || parsed.directory?.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  if (!name) throw new Error("Enter an agent name");
  const cwd = parsed.directory?.trim();
  const input = { ...parsed, topic_name: name, directory: cwd || undefined };
  const profile = { name, cli: input.backend, ...(cwd ? { cwd } : {}),
    ...(input.machineId ? { machineId: input.machineId } : {}), model: input.model,
    description: input.description ?? "", instructions: input.systemPrompt ?? "", sandbox: input.sandbox,
    ...(input.tags ? { tags: input.tags } : {}) };
  return { input, profile };
}
