/** #1629: caller-scoped effect operations. Host ingress supplies identity; no tool takes a target or holder. */
import { EFFECT_REGION, chatCompatible, resolveEffectParams } from "./web-effect.js";
import { WebEffectLibrary } from "./web-effect-library.js";
import { EffectUploads } from "./web-effect-upload.js";
import type { AppearanceBucket, AppearanceLimiter } from "./web-appearance-policy.js";

type Answer=Record<string,unknown>;
export interface EffectPlacementInput { id:string; params?:Record<string,unknown> }
export interface EffectToolDeps {
  library:WebEffectLibrary;
  limiter:AppearanceLimiter;
  /** The SAME switch/lock/limiter helper used by theme writes, run synchronously. */
  authorize(instance:string,buckets:readonly AppearanceBucket[]):Answer|null;
  placed(instance:string):Array<{id:string;params?:Record<string,unknown>}>;
  place(instance:string,effects:Array<string|EffectPlacementInput>):{ok:true;rev:number}|{ok:false;error:string};
  changed():void;
  preview(instance:string,id:string,title:string):Promise<Answer>;
  profiles(id:string):Answer;
  profileSummary?(id:string):Answer;
  playbackSummary?(instance:string,id:string):Answer;
  profileSummaries?(ids:readonly string[]):Record<string,Answer>;
  clock?:()=>number;
}
export const WEB_EFFECT_TOOLS: ReadonlySet<string> = new Set(["upload_web_effect","list_web_effects","preview_web_effect","profile_web_effect","apply_web_effect","remove_web_effect","delete_web_effect"]);
const ID=/^[0-9a-f]{32}$/;
export class WebEffectTools {
  private readonly uploads:EffectUploads;
  constructor(private readonly deps:EffectToolDeps) { this.uploads=new EffectUploads(deps.clock); }
  private principal(instance:string) { return {kind:"agent" as const,id:instance}; }
  upload(instance:string,args:Answer):Answer {
    const refused=this.deps.authorize(instance,[]);   // the switch and the lock; uploads are not counted (the user's decision)
    if(refused){this.uploads.forget(instance);return refused;}
    return this.uploads.accept(instance,args,files=>{
      const last=this.deps.authorize(instance,[]);if(last)return last;
      const stage=this.deps.library.stage(files,this.principal(instance));
      if(!stage.ok)return {error:stage.error};
      const committed=this.deps.library.commit(stage.stageId);
      if(!committed.ok){this.deps.library.abort(stage.stageId);return {error:committed.error};}
      this.deps.changed();
      return {id:committed.ids[0],warnings:stage.entries[0]!.warnings};
    });
  }
  list(instance:string):Answer {
    const result=this.deps.library.list(this.principal(instance));
    if(!result.ok)return {error:result.error};
    const profiles=this.deps.profileSummaries?.(result.entries.map(e=>e.id));
    const placed=new Set(this.deps.placed(instance).map(e=>e.id));
    return {effects:result.entries.map(e=>({id:e.id,name:e.manifest.name,title:e.manifest.title,regions:e.manifest.regions,layer:e.manifest.layer,bytes:e.bytes,...(placed.has(e.id)&&this.deps.playbackSummary?{playback:this.deps.playbackSummary(instance,e.id)}:{}),latest_profile:profiles?profiles[e.id]:this.deps.profileSummary?this.deps.profileSummary(e.id):this.deps.profiles(e.id)}))};
  }
  apply(instance:string,args:Answer):Answer {
    const refused=this.deps.authorize(instance,["change"]);if(refused)return refused;
    if(Object.keys(args).some(k=>k!=="id"&&k!=="params")||typeof args.id!=="string"||!ID.test(args.id))return {error:"effect_args"};
    const entry=this.deps.library.read(args.id,this.principal(instance));if(!entry.ok)return {error:entry.error};
    // #2017: a chat placement needs an effect that plays in chat — refused before anything is placed, written or counted.
    if(!chatCompatible(entry.entry.manifest))return {...EFFECT_REGION};
    const params=resolveEffectParams(entry.entry.manifest,args.params===undefined?{}:args.params);if(!params.ok)return {error:"effect_params"};
    const previous=this.deps.placed(instance);
    const target:EffectPlacementInput={id:args.id,...(Object.keys(params.overrides).length?{params:params.overrides}:{})};
    const next=previous.map(e=>e.id===args.id?target:e.id);
    if(!previous.some(e=>e.id===args.id))next.push(target);
    if(next.length>2)return {error:"effects",message:"At most two effects in your own chat; remove one first."};
    // Retained string entries keep the host's provenance; the explicit target is always restamped agent-side.
    const result=this.deps.place(instance,next);
    if(!result.ok)return {error:result.error};
    this.deps.limiter.record(instance,["change"]);this.deps.changed();
    return {id:args.id,region:"chat",params:params.overrides,rev:result.rev};
  }
  remove(instance:string,args:Answer):Answer {
    const refused=this.deps.authorize(instance,["change"]);if(refused)return refused;
    if(Object.keys(args).some(k=>k!=="id")||args.id!==undefined&&(typeof args.id!=="string"||!ID.test(args.id)))return {error:"effect_args"};
    const before=this.deps.placed(instance),removed=before.filter(e=>args.id===undefined||e.id===args.id).map(e=>e.id);
    if(!removed.length)return {removed:[]};
    const result=this.deps.place(instance,before.filter(e=>!removed.includes(e.id)).map(e=>e.id));
    if(!result.ok)return {error:result.error};
    this.deps.limiter.record(instance,["change"]);this.deps.library.collectUnreferenced(removed);this.deps.changed();
    return {removed,rev:result.rev};
  }
  delete(instance:string,args:Answer):Answer {
    const refused=this.deps.authorize(instance,[]);if(refused)return refused;
    if(Object.keys(args).some(k=>k!=="id")||typeof args.id!=="string"||!ID.test(args.id))return {error:"effect_args"};
    const result=this.deps.library.deleteClaim(args.id,this.principal(instance));
    return result.ok?{deleted:args.id}:{error:result.error};
  }
  profile(instance:string,args:Answer):Answer {
    if(Object.keys(args).some(k=>k!=="id")||typeof args.id!=="string"||!ID.test(args.id)||!this.deps.library.read(args.id,this.principal(instance)).ok)return {error:"not_found"};
    return this.deps.profiles(args.id);
  }
  async preview(instance:string,args:Answer):Promise<Answer> {
    if(Object.keys(args).some(k=>k!=="id")||typeof args.id!=="string"||!ID.test(args.id))return {error:"effect_args"};
    const entry=this.deps.library.read(args.id,this.principal(instance));if(!entry.ok)return {error:"not_found"};
    return this.deps.preview(instance,args.id,entry.entry.manifest.title);
  }
  handle(instance:string,tool:string,args:Answer):Answer|Promise<Answer> {
    if (!args || typeof args !== "object" || Array.isArray(args)) return {error:"effect_args"};
    switch(tool){
      case "upload_web_effect":return this.upload(instance,args);
      case "list_web_effects":return Object.keys(args).length?{error:"effect_args"}:this.list(instance);
      case "apply_web_effect":return this.apply(instance,args);
      case "remove_web_effect":return this.remove(instance,args);
      case "delete_web_effect":return this.delete(instance,args);
      case "profile_web_effect":return this.profile(instance,args);
      case "preview_web_effect":return this.preview(instance,args);
      default:return {error:"unknown_tool"};
    }
  }
  forget(instance:string):void { this.uploads.forget(instance); }
}
