/** Windows runtime adapter behind the shared Instance HTTP surface. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { readBoundedWebBody } from "./web-body.js";
import { nativeCliAuthorization } from "./windows-cli-api.js";
import { windowsCliEnabled } from "./windows-cli.js";
import { authorizeExplicitInstanceRemoval } from "./instance-removal.js";
import { isWindowsInstance, isNativePaneInstance } from "./native-instance-registry.js";
import type { WebApiContext } from "./web-api.js";
import { settingsRequestExecution } from "./settings-request-capability.js";
import { parseNativeInstanceCreate } from "./native-instance-input.js";

const Tags = z.array(z.string().min(1).max(64)).max(32);
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
    const {profile}=parseNativeInstanceCreate(body);
    const runtime=ctx.nativeInstanceRuntime!(),execution=settingsRequestExecution(req);
    const result=execution ? await runtime.create(profile,allowed,execution) : await runtime.create(profile,allowed);
    // A committed settings execution has already checked authority and persisted the identity. Its capability
    // cannot authorize another write, but the completed operation must still return its success receipt.
    if(!execution?.completed && !allowed()){json(res,403,{error:"Authorization expired"});return;}
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
      z.object({}).strict().parse(body);
      if (isNativePaneInstance(ctx.fleetConfig?.instances[name])) await ctx.removeInstance(name,authorizeExplicitInstanceRemoval("dashboard-confirmed"),settingsRequestExecution(req));
      else await service.remove(name,allowed);
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
      z.object({}).strict().parse(body);
      if (isNativePaneInstance(ctx.fleetConfig?.instances[name])) {
        if (!ctx.cancelInstance || !ctx.cancelInstance(name)) throw Error("The native pane is not running");
        json(res,202,{agent:service.get(name),task:null});return;
      }
      const result=service.cancel(name);json(res,202,{agent:service.get(name),task:result});return;
    }
    if(method==="POST" && operation==="recover"){
      const input=z.object({confirmedStopped:z.literal(true)}).strict().parse(body);json(res,200,{agent:service.recoverAsync ? await service.recoverAsync(name,input.confirmedStopped) : service.recover(name,input.confirmedStopped)});return;
    }
    json(res,405,{error:"Unsupported instance operation"});
  })().catch(error=>json(res,allowed()?400:403,{error:allowed()?(error instanceof Error?error.message:"Instance operation failed"):"Authorization expired"}));
  return true;
}
