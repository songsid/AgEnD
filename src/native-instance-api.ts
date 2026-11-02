/** Windows runtime adapter behind the shared Instance HTTP surface. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { readBoundedWebBody } from "./web-body.js";
import { nativeCliAuthorization } from "./windows-cli-api.js";
import { windowsCliEnabled } from "./windows-cli.js";
import { isWindowsInstance } from "./native-instance-registry.js";
import type { WebApiContext } from "./web-api.js";
import { settingsRequestExecution } from "./settings-request-capability.js";

const Provider = z.enum(["codex","claude-code","antigravity","grok","kiro-cli","opencode","muse"]);
const Tags = z.array(z.string().min(1).max(64)).max(32);
const Create = z.object({
  runtime:z.literal("windows"), topic_name:z.string().max(64).optional(),
  machineId:z.string().uuid().optional(),
  directory:z.string().max(1024).optional(), backend:Provider.default("codex"),
  model:z.string().max(160).optional(), description:z.string().max(512).optional(),
  systemPrompt:z.string().max(8000).optional(), sandbox:z.enum(["read-only","workspace-write"]).default("read-only"), tags:Tags.optional(),
}).strict();
const Patch = z.object({
  display_name:z.string().min(1).max(64).optional(), description:z.string().max(512).optional(),
  working_directory:z.string().min(1).max(1024).optional(), model:z.string().max(160).optional(),
  systemPrompt:z.string().max(8000).optional(), native_sandbox:z.enum(["read-only","workspace-write"]).optional(), tags:Tags.optional(),
}).strict().refine(value=>Object.keys(value).length>0,"Choose a setting to update");
const Message = z.object({requestId:z.string().uuid(),prompt:z.string().min(1).max(8000)}).strict();
function json(res:ServerResponse,status:number,value:unknown):void {
  if(res.destroyed || res.writableEnded)return;
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify(value));
}
function admission(req:IncomingMessage,res:ServerResponse,url:URL,ctx:WebApiContext):(()=>boolean)|null {
  if(!windowsCliEnabled()){json(res,404,{error:"Windows runtime is not enabled"});return null;}
  const allowed=()=>nativeCliAuthorization(req,url,ctx);
  if(!allowed()){json(res,403,{error:"Windows runtime requires an administrator on the local dashboard"});return null;}
  if(!ctx.nativeInstanceRuntime){json(res,503,{error:"The Fleet Windows runtime is not available"});return null;}
  return allowed;
}

/** The shared creation route has already read the body; Linux creation continues through its existing lifecycle. */
export async function createNativeInstance(req:IncomingMessage,res:ServerResponse,url:URL,ctx:WebApiContext,body:unknown):Promise<void> {
  const allowed=admission(req,res,url,ctx);if(!allowed)return;
  try {
    const input=Create.parse(body);
    const name=input.topic_name?.trim() || input.directory?.trim().replace(/[\\/]+$/,"").split(/[\\/]/).pop() || "";
    if(!name)throw new Error("Enter an agent name");
    const profile={name,cli:input.backend,...(input.directory?.trim()?{cwd:input.directory.trim()}:{}),
      ...(input.machineId ? {machineId:input.machineId} : {}),
      model:input.model,description:input.description ?? "",instructions:input.systemPrompt ?? "",sandbox:input.sandbox,...(input.tags?{tags:input.tags}:{})};
    const runtime=ctx.nativeInstanceRuntime!(),execution=settingsRequestExecution(req);
    const result=execution ? await runtime.create(profile,allowed,execution) : await runtime.create(profile,allowed);
    if(!allowed()){json(res,403,{error:"Authorization expired"});return;}
    ctx.emitSseEvent("status",ctx.getUiStatus());json(res,201,result);
  } catch(error) {json(res,allowed()?400:403,{error:allowed()?(error instanceof Error?error.message:"Could not create instance"):"Authorization expired"});}
}

/** Common CRUD/message routes. The old native URLs remain compatibility aliases. */
export function handleNativeInstanceRequest(req:IncomingMessage,res:ServerResponse,url:URL,ctx:WebApiContext):boolean {
  const match=/^\/ui\/instances\/([^/]+)(?:\/(messages|cancel|recover))?$/.exec(url.pathname);
  if(!match)return false;
  let name:string;try{name=decodeURIComponent(match[1]);}catch{return false;}
  if(!isWindowsInstance(ctx.fleetConfig?.instances[name]))return false;
  const allowed=admission(req,res,url,ctx);if(!allowed)return true;
  const service=ctx.nativeInstanceRuntime!(), operation=match[2], method=req.method ?? "GET";
  void (async()=>{
    if(method==="GET" && !operation){json(res,200,{name,runtime:"windows",agent:service.get(name)});return;}
    const raw=await readBoundedWebBody(req,40_000);
    if(!allowed()){json(res,403,{error:"Authorization expired"});return;}
    const body=raw.length?JSON.parse(raw.toString("utf8")):{};
    if(method==="PATCH" && !operation){
      const result=await service.update(name,Patch.parse(body),allowed);
      if(!allowed()){json(res,403,{error:"Authorization expired"});return;}
      ctx.emitSseEvent("status",ctx.getUiStatus());json(res,200,result);return;
    }
    if(method==="DELETE" && !operation){
      z.object({}).strict().parse(body);await service.remove(name,allowed);
      if(!allowed()){json(res,403,{error:"Authorization expired"});return;}
      ctx.emitSseEvent("status",ctx.getUiStatus());json(res,200,{deleted:name});return;
    }
    if(method==="POST" && operation==="messages"){
      const input=Message.parse(body);
      if(!input.prompt.trim())throw new Error("Enter a message");
      const existing=service.get(name)?.turns.find(turn=>turn.id===input.requestId);
      if(existing){if(existing.prompt!==input.prompt)throw new Error("requestId belongs to a different message");json(res,200,{accepted:true,repeated:true,agent:service.get(name)});return;}
      const ts=new Date().toISOString(), messageId=`native:${input.requestId}:user`;
      const sent=await ctx.deliverToInstance(name,{type:"fleet_inbound",content:input.prompt,requestId:input.requestId,targetSession:name,
        meta:{source:"web",user:"You",message_id:messageId,ts}},{stillCurrent:allowed});
      if(sent===false)throw new Error("The instance did not accept this message");
      if(!allowed()){json(res,403,{error:"Authorization expired"});return;}
      ctx.emitSseEvent("message",{instance:name,sender:"You",role:"user",text:input.prompt,ts,messageId});
      json(res,202,{accepted:true,agent:service.get(name)});return;
    }
    if(method==="POST" && operation==="cancel"){
      z.object({}).strict().parse(body);const result=service.cancel(name);json(res,202,{agent:service.get(name),task:result});return;
    }
    if(method==="POST" && operation==="recover"){
      const input=z.object({confirmedStopped:z.literal(true)}).strict().parse(body);json(res,200,{agent:service.recoverAsync ? await service.recoverAsync(name,input.confirmedStopped) : service.recover(name,input.confirmedStopped)});return;
    }
    json(res,405,{error:"Unsupported instance operation"});
  })().catch(error=>json(res,allowed()?400:403,{error:allowed()?(error instanceof Error?error.message:"Instance operation failed"):"Authorization expired"}));
  return true;
}
