/** Shared, side-effect-free validation for native creation and its settings confirmation. */
import { z } from "zod";
import type { FleetConfig } from "./types.js";
import { validCredentialProfileName } from "./runtime-credential-profiles.js";

export const NativeInstanceCreateArgs = z.object({
  runtime: z.literal("windows"), native_adapter:z.enum(["exec","pane"]).optional(), channel_id:z.string().min(1).max(160).optional(), topic_name: z.string().max(64).optional(),
  machineId: z.string().uuid().optional(), directory: z.string().max(1024).optional(),
  backend: z.enum(["codex", "claude-code", "antigravity", "grok", "kiro-cli", "opencode", "muse"]).default("codex"),
  model: z.string().max(160).optional(), description: z.string().max(512).optional(),
  systemPrompt: z.string().max(8000).optional(), sandbox: z.enum(["read-only", "workspace-write"]).default("read-only"),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  /** A NAME only: a Claude sign-in kept on the chosen Runtime computer. The server never accepts, stores or sends a folder for it. */
  credentialProfile: z.string().max(64).refine(validCredentialProfileName,"Invalid credential profile name").optional(),
}).strict().superRefine((value,ctx)=>{
  if(value.credentialProfile&&(!value.machineId||value.backend!=="claude-code"))ctx.addIssue({code:"custom",message:"A credential profile is a Claude Code sign-in kept on a paired Runtime computer"});
  if(value.native_adapter==="pane"&&!['codex','claude-code'].includes(value.backend))ctx.addIssue({code:"custom",message:"Persistent Windows panes support Codex and Claude Code only"});
  if(value.channel_id&&value.native_adapter!=="pane")ctx.addIssue({code:"custom",message:"Only persistent panes allocate topics"});
});
/** The web editor's Windows settings patch (PATCH /ui/instances/:name). The one parser for it: the web and #2942's pending MCP update. */
export const NativeInstancePatch = z.object({
  display_name:z.string().min(1).max(64).optional(), description:z.string().max(512).optional(),
  working_directory:z.string().min(1).max(1024).optional(), model:z.string().max(160).optional(),
  systemPrompt:z.string().max(8000).optional(), native_sandbox:z.enum(["read-only","workspace-write"]).optional(),
  tags:z.array(z.string().min(1).max(64)).max(32).optional(),
}).strict().refine(value=>Object.keys(value).length>0,"Choose a setting to update");
/** The Windows settings an agent may ask to change (#2942): the web editor's fields the MCP schema offers, nothing more. */
export const NativeInstanceConfigEdit = z.object({
  display_name:z.string().min(1).max(64).optional(), description:z.string().max(512).optional(), model:z.string().max(160).optional(),
}).strict().refine(value=>Object.keys(value).length>0,"Choose a setting to update");
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
    ...(input.tags ? { tags: input.tags } : {}), ...(input.credentialProfile ? { credentialProfile: input.credentialProfile } : {}) };
  return { input, profile };
}
export type NativeInstanceCreateInput = ReturnType<typeof parseNativeInstanceCreate>;
