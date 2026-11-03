/** Shared, side-effect-free validation for native creation and its settings confirmation. */
import { z } from "zod";
import type { FleetConfig } from "./types.js";

export const NativeInstanceCreateArgs = z.object({
  runtime: z.literal("windows"), native_adapter:z.enum(["exec","pane"]).optional(), channel_id:z.string().min(1).max(160).optional(), topic_name: z.string().max(64).optional(),
  machineId: z.string().uuid().optional(), directory: z.string().max(1024).optional(),
  backend: z.enum(["codex", "claude-code", "antigravity", "grok", "kiro-cli", "opencode", "muse"]).default("codex"),
  model: z.string().max(160).optional(), description: z.string().max(512).optional(),
  systemPrompt: z.string().max(8000).optional(), sandbox: z.enum(["read-only", "workspace-write"]).default("read-only"),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
}).strict().superRefine((value,ctx)=>{
  if(value.native_adapter==="pane"&&!['codex','claude-code'].includes(value.backend))ctx.addIssue({code:"custom",message:"Persistent Windows panes support Codex and Claude Code only"});
  if(value.channel_id&&value.native_adapter!=="pane")ctx.addIssue({code:"custom",message:"Only persistent panes allocate topics"});
});
/** Resolve before approval, then recheck this exact connection rather than substituting another world. */
export function nativePaneTopicTarget(config:FleetConfig|null,requested?:string){
  const channels=config?.channels??(config?.channel?[config.channel]:[]);
  if(!channels.length){if(requested)throw Error("Topic connection is unavailable");return null;}
  const selected=requested?channels.filter(channel=>(channel.id??channel.type)===requested):channels.slice(0,1);
  if(selected.length!==1||!['telegram','discord'].includes(selected[0].type))throw Error("Choose one configured chat connection for this pane");
  const channel=selected[0];return{id:channel.id??channel.type,type:channel.type,group_id:channel.group_id};
}

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
