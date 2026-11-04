import { t } from "./locale.js";
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
import { NativeInstancePatch, parseNativeInstanceCreate, type NativeInstanceCreateInput } from "./native-instance-input.js";
import type { SettingsExecution } from "./settings-transaction.js";

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

/** The Windows creation both paths run: the web's confirmed/direct request and #2942's confirmed agent request. */
export function createNativeWindowsInstance(host:NativeWindowsHost,parsed:NativeInstanceCreateInput,allowed:()=>boolean,execution?:SettingsExecution):Promise<unknown> {
  const {profile,input}=parsed;
  return input.native_adapter==="pane"
    ? (()=>{if(!execution||!host.createNativePaneInstance)throw Error("Persistent pane creation requires its approved Settings operation");return host.createNativePaneInstance(profile,input.channel_id,allowed,execution);})()
    : (async()=>{const runtime=host.nativeInstanceRuntime!();return execution ? runtime.create(profile,allowed,execution) : runtime.create(profile,allowed);})();
}
/** The Windows settings write both paths run (the web editor's PATCH and #2942's confirmed agent update). */
export function updateNativeWindowsInstance(host:NativeWindowsHost,name:string,patch:Record<string,unknown>,allowed:()=>boolean,execution?:SettingsExecution):Promise<unknown> {
  const pane=isNativePaneInstance(host.fleetConfig?.instances[name]);
  if(pane&&!host.updateNativePaneConfig)throw Error("Persistent pane settings are unavailable");
  // The web's own calls keep their arguments exactly; only a settings execution adds its transaction.
  if(pane) return execution ? host.updateNativePaneConfig!(name,patch,allowed,execution) : host.updateNativePaneConfig!(name,patch,allowed);
  return (async()=>execution ? host.nativeInstanceRuntime!().update(name,patch as never,allowed,execution) : host.nativeInstanceRuntime!().update(name,patch as never,allowed))();
}
export type NativeWindowsHost=Pick<WebApiContext,"fleetConfig"|"nativeInstanceRuntime"|"createNativePaneInstance"|"updateNativePaneConfig">;

/** The shared creation route has already read the body; Linux creation continues through its existing lifecycle. */
export async function createNativeInstance(req:IncomingMessage,res:ServerResponse,url:URL,ctx:WebApiContext,body:unknown):Promise<void> {
  const allowed=admission(req,res,url,ctx);if(!allowed)return;
  try {
    const parsed=parseNativeInstanceCreate(body),execution=settingsRequestExecution(req);
    const result=await createNativeWindowsInstance(ctx,parsed,allowed,execution);
    // A committed settings execution has already checked authority and persisted the identity. Its capability
    // cannot authorize another write, but the completed operation must still return its success receipt.
    if(!execution?.completed && !allowed()){json(res,403,{error:"Authorization expired"});return;}
    ctx.emitSseEvent("status",ctx.getUiStatus());json(res,201,result);
  } catch(error) {
    // S-35: an approved Settings replay answers only the server's own collector, never a browser. Its execution ends with the
    // failure, so allowed() is false there; answering "Authorization expired" hid the real cause (a relay that did not
    // start, a startup race, the per-PC agent limit). A real browser request keeps the old rule.
    const replay=settingsRequestExecution(req)!=null,ok=replay||allowed();
    json(res,ok?400:403,{error:ok?(error instanceof Error?error.message:"Could not create instance"):"Authorization expired"});
  }
}

/** Common CRUD/message routes. The old native URLs remain compatibility aliases. */
export function handleNativeInstanceRequest(req:IncomingMessage,res:ServerResponse,url:URL,ctx:WebApiContext):boolean {
  const match=/^\/ui\/instances\/([^/]+)(?:\/(messages|cancel|recover|recover-pane|new-conversation))?$/.exec(url.pathname);
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
      const patch=NativeInstancePatch.parse(body);
      const result=await updateNativeWindowsInstance(ctx,name,patch,allowed);
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
      if(isNativePaneInstance(ctx.fleetConfig?.instances[name]))throw Error("Use the shared chat endpoint for a persistent Windows pane");
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
    if(method==="POST" && operation==="new-conversation"){
      if(!isNativePaneInstance(ctx.fleetConfig?.instances[name])||!ctx.startFreshNativePane)throw Error(t("native_pane.unavailable"));
      const input=z.object({confirmedNewConversation:z.literal(true),launchId:z.string().uuid(),sessionId:z.string().uuid().nullable()}).strict().parse(body);
      await ctx.startFreshNativePane(name,input.launchId,input.sessionId,allowed);
      if(!allowed()){json(res,403,{error:"Authorization expired"});return;}
      ctx.emitSseEvent("status",ctx.getUiStatus());json(res,200,{agent:service.get(name)});return;
    }
    if(method==="POST" && operation==="recover-pane"){
      if(!isNativePaneInstance(ctx.fleetConfig?.instances[name])||!ctx.recoverNativePane)throw Error(t("native_pane.unavailable"));
      const input=z.object({confirmedStopped:z.literal(true),launchId:z.string().uuid()}).strict().parse(body);
      await ctx.recoverNativePane(name,input.launchId,allowed);
      if(!allowed()){json(res,403,{error:"Authorization expired"});return;}
      ctx.emitSseEvent("status",ctx.getUiStatus());json(res,200,{agent:service.get(name)});return;
    }
    if(method==="POST" && operation==="recover"){
      if(isNativePaneInstance(ctx.fleetConfig?.instances[name]))throw Error("Use the shared Start or Restart control to reconcile the retained pane");
      const input=z.object({confirmedStopped:z.literal(true)}).strict().parse(body);json(res,200,{agent:service.recoverAsync ? await service.recoverAsync(name,input.confirmedStopped) : service.recover(name,input.confirmedStopped)});return;
    }
    json(res,405,{error:"Unsupported instance operation"});
  })().catch(error=>json(res,allowed()?400:403,{error:allowed()?(error instanceof Error?error.message:"Instance operation failed"):"Authorization expired"}));
  return true;
}
