/** Model discovery for the native runtime, behind the shared Settings surface. */
import { remoteRuntimeEnabled } from "./runtime-switches.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebApiContext } from "./web-api.js";
import { nativeCliAuthorization, remoteSetupActor } from "./windows-cli-api.js";
import { windowsBridgeFor, windowsCliEnabled, type WindowsCliBridge } from "./windows-cli.js";
import { isNativeProviderId } from "./windows-cli-providers.js";
import { validCredentialProfileName } from "./runtime-credential-profiles.js";
import { MODEL_REFRESH_CAPABILITY } from "./runtime-remote-setup.js";
import { isWindowsInstance } from "./native-instance-registry.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

export interface ModelRefreshTarget { backend:string; instance?:string|null; runtime?:"windows"|"wsl"; machineId?:string; profile?:string }
type ModelReply = {models:Array<{id:string;label:string;description?:string}>;source:string;refreshed:boolean};
const catalogs = new WeakMap<object,Map<string,{at:number;value:ModelReply}>>();
const flights = new WeakMap<object,Map<string,Promise<ModelReply>>>();
function selection(ctx:WebApiContext,input:ModelRefreshTarget) {
  const config = input.instance && Object.hasOwn(ctx.fleetConfig?.instances ?? {},input.instance) ? ctx.fleetConfig!.instances[input.instance] : undefined;
  if (input.runtime !== "windows" && !isWindowsInstance(config)) {
    if (input.machineId) throw Error("Invalid runtime target");
    return null;
  }
  if (!windowsCliEnabled() || !isNativeProviderId(input.backend) || input.runtime === "wsl" || input.instance && (!isWindowsInstance(config) || config?.backend !== input.backend)
    || input.instance && input.machineId && input.machineId !== config?.machine_id) throw Error("The selected runtime, CLI and computer do not match");
  const machineId=input.machineId ?? config?.machine_id;
  const machine=machineId ? ctx.runtimeCoordinator?.().machine(machineId) : undefined;
  if (machineId && (!remoteRuntimeEnabled() || !machine || machine.status !== "online")) throw Error("The selected computer is unavailable");
  const options = config?.backend_options?.[input.backend];
  if (options?.provider) throw Error("Model refresh for this native provider is unavailable");
  const profile=input.profile ?? (typeof options?.credential_profile === "string" ? options.credential_profile : "");
  if (profile && (!validCredentialProfileName(profile) || input.backend !== "claude-code" || !machineId)) throw Error("Model refresh for this account is unavailable");
  const expected=profile || (input.backend === "claude-code" ? machine?.inventory?.credentialProfiles?.default : undefined) || null;
  const key=JSON.stringify([input.backend,input.instance??null,"windows",machineId??null,profile,config,expected,machine?.approvedAt,machine?.inventoryUpdatedAt,machine?.generation,machine?.bootId,machine?.inventory?.credentialProfiles,machine?.inventory?.clis.map(c=>[c.id,c.identity,c.authenticated])]);
  return {config,machineId,machine,profile,expected,key};
}
function checkedModels(value:unknown,cli:string,profile:string|null):ModelReply {
  if (!value || typeof value!=="object" || Array.isArray(value)) throw Error("Invalid model result");
  const v=value as Record<string,unknown>;
  if (v.cli!==cli || v.profile!==profile || !["account-api","cli-list"].includes(String(v.source))
      || !Array.isArray(v.models) || !v.models.length || v.models.length>200 || Buffer.byteLength(JSON.stringify(v))>16*1024) throw Error("Invalid model result");
  const models=v.models.map(raw=>{
    if(!raw || typeof raw!=="object" || Array.isArray(raw)) throw Error("Invalid model row");
    const m=raw as Record<string,unknown>;
    if(typeof m.id!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._:/[\] -]{0,159}$/.test(m.id) || m.name!==undefined&&typeof m.name!=="string" || m.description!==undefined&&typeof m.description!=="string")throw Error("Invalid model row");
    return {id:m.id,label:typeof m.name==="string"?m.name.slice(0,200):m.id,...(typeof m.description==="string"?{description:m.description.slice(0,300)}:{})};
  });
  return {models,source:String(v.source),refreshed:true};
}
export function cachedNativeModelCatalog(owner:object,input:ModelRefreshTarget):ModelReply|null {
  const ctx=owner as WebApiContext;
  try { const target=selection(ctx,input),hit=target?catalogs.get(ctx)?.get(target.key):undefined;return hit&&Date.now()-hit.at<24*60*60_000?hit.value:null; } catch {return null;}
}
/** Explicit refresh only. Ordinary GETs never invoke this or perform vendor discovery. */
export async function refreshNativeModelCatalog(req:IncomingMessage,url:URL,ctx:WebApiContext,input:ModelRefreshTarget,bridge?:WindowsCliBridge):Promise<ModelReply|null> {
  const target=selection(ctx,input);if(!target)return null;
  const actor=remoteSetupActor(req,url,ctx);
  const current=()=>{
    const next=selection(ctx,input);
    return nativeCliAuthorization(req,url,ctx) && (!target.machineId || actor!==null&&remoteSetupActor(req,url,ctx)===actor) && next?.key===target.key && next.config===target.config;
  };
  if(!current())throw Error("Model discovery requires an administrator on the local dashboard");
  const active=flights.get(ctx)??new Map();flights.set(ctx,active);
  if(active.has(target.key))return active.get(target.key)!;
  if(active.size>=2)throw Error("Other model refreshes are running");
  const work=(async()=>{
    let raw:unknown;
    if(target.machineId){
      if(!actor || !target.machine?.runtimeInfo?.capabilities.includes(MODEL_REFRESH_CAPABILITY))throw Error("Update the selected computer's Runtime to refresh models");
      raw=await ctx.runtimeCoordinator!().callAccount(target.machineId,"models.refresh",{cli:input.backend,profile:target.profile,actor},25_000);
    }else raw={...await (bridge??windowsBridgeFor(ctx)).refreshModels(input.backend,current),cli:input.backend,profile:null};
    if(!current())throw Error("Model target or authorization changed");
    const answer=checkedModels(raw,input.backend,target.expected);
    const remembered=catalogs.get(ctx)??new Map();catalogs.set(ctx,remembered);if(remembered.size>=64)remembered.delete(remembered.keys().next().value!);remembered.set(target.key,{at:Date.now(),value:answer});
    return answer;
  })().finally(()=>active.delete(target.key));active.set(target.key,work);return work;
}

/** Caller validates the ordinary dashboard gate and the query shape first. */
export function handleNativeModelCatalog(req: IncomingMessage, res: ServerResponse, url: URL, ctx: WebApiContext, bridge?: WindowsCliBridge): boolean {
  const instance = url.searchParams.get("instance");
  const config = instance && Object.hasOwn(ctx.fleetConfig?.instances ?? {},instance) ? ctx.fleetConfig!.instances[instance] : undefined;
  const requestedMachine=url.searchParams.get("machineId"), machineId=requestedMachine ?? config?.machine_id;
  if (url.searchParams.get("runtime") !== "windows" && !isWindowsInstance(config)) {
    if(requestedMachine!==null){json(res,400,{error:"A machine model catalog requires a Windows runtime"});return true;}
    return false;
  }
  if (!windowsCliEnabled()) { json(res, 404, { error: "Windows runtime is not enabled" }); return true; }
  const allowed = (): boolean => nativeCliAuthorization(req, url, ctx);
  if (!allowed()) { json(res, 403, { error: "Windows model discovery requires an administrator on the local dashboard" }); return true; }
  const backend = url.searchParams.get("backend") ?? "";
  if (!isNativeProviderId(backend)) { json(res, 400, { error: "Unknown Windows CLI provider" }); return true; }
  if (url.searchParams.get("runtime") === "wsl" || instance && (!isWindowsInstance(config) || config?.backend !== backend)) {
    json(res, 400, { error: "The selected runtime and CLI do not match this instance" }); return true;
  }
  if (instance && requestedMachine !== null && requestedMachine !== config?.machine_id) {
    json(res,400,{error:"The selected machine does not own this conversation"});return true;
  }
  void (async () => {
    // M-2239 P1-2: a GET reads the administrator's last detection, including remote machines.
    // Detection is an explicit administrator POST; a model-list `refresh` never launches a CLI.
    let catalog;
    if(machineId){
      if(!remoteRuntimeEnabled() || !ctx.runtimeCoordinator)throw new Error("Remote runtimes are not enabled");
      const hub=ctx.runtimeCoordinator(), machine=hub.machine(machineId);
      if(!machine || machine.status==="pending" || machine.status==="revoked")throw new Error("Unknown runtime machine");
      catalog=machine.inventory;
      if(!catalog)throw new Error("Runtime inventory is not ready");
    } else catalog = await (bridge ?? windowsBridgeFor(ctx)).probe();
    if (!allowed()) { json(res, 403, { error: "Authorization expired" }); return; }
    const input={backend,instance,runtime:"windows" as const,...(machineId?{machineId}:{}),...(url.searchParams.has("profile")?{profile:url.searchParams.get("profile")!}:{})};
    const target=selection(ctx,input),hit=target?catalogs.get(ctx)?.get(target.key):undefined;
    if(hit&&Date.now()-hit.at<24*60*60_000){json(res,200,{backend,runtime:"windows",...hit.value});return;}
    if(target?.expected){json(res,200,{backend,runtime:"windows",models:[],source:"unavailable"});return;}
    const cli = catalog.clis.find(row => row.id === backend);
    json(res, 200, {
      backend, runtime: "windows", ...(machineId ? {machineId} : {}),
      models: (cli?.models ?? []).map(model => ({ id: model.id, label: model.name ?? model.id, ...(model.description ? { description: model.description } : {}) })),
      source: cli?.modelsSource ?? (cli?.models.length ? "cli-list" : "unavailable"),
    });
  })().catch(() => json(res, allowed() ? 503 : 403, { error: allowed() ? "Windows model discovery failed. Retry the CLI inventory." : "Authorization expired" }));
  return true;
}
