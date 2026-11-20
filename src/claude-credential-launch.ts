/** Host-owned managed credential launch. Specs/settings contain references only, never credential values. */
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, opendirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { z } from "zod";
import { ClaudeCredentialVault, type ClaudeCredentialKind } from "./claude-credential-vault.js";
import { shellQuote, UnsupportedCliError } from "./backend/types.js";
export interface ManagedClaudeBinding { home: string; profile: string | null; id: string; revision: number; kind: ClaudeCredentialKind; }
const bindingSchema = z.strictObject({ home:z.string().max(4096).refine(isAbsolute), profile:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).nullable(),
 id:z.string().uuid(), revision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER), kind:z.enum(["api-key","setup-token"]) });
const specSchema = z.strictObject({ binding:bindingSchema, cwd:z.string().max(4096).refine(isAbsolute), configDir:z.string().max(4096).refine(isAbsolute),
 helperCommand:z.string().max(16384), settingsPaths:z.array(z.string().max(4096).refine(isAbsolute)).max(140), policyPaths:z.array(z.string().max(4096).refine(isAbsolute)).max(8), ready:z.boolean(), binary:z.string().max(4096), args:z.array(z.string().max(16384)).max(256), env:z.record(z.string(),z.string().max(8192)) });
export type ManagedClaudeSpec = z.infer<typeof specSchema>;
const unavailable = () => new UnsupportedCliError("Managed Claude credential is unavailable or its source changed. Open Accounts on the local dashboard.");
export function managedClaudeBinding(home: string, profile: string | null): ManagedClaudeBinding | null {
 if (!existsSync(join(home,"credential-vault","claude.sqlite"))) return null;
 let vault:ClaudeCredentialVault|undefined;
 try {vault=new ClaudeCredentialVault(home);const m=vault.metadata(profile);if(!m)return null;if(!m.kind)throw unavailable();return {home:resolve(home),profile,id:m.id,revision:m.revision,kind:m.kind};}
 catch{throw unavailable();}finally{vault?.close();}
}
export function currentManagedClaude(binding: ManagedClaudeBinding): boolean {
 const v=new ClaudeCredentialVault(binding.home);try{const m=v.metadata(binding.profile);return !!m&&m.id===binding.id&&m.revision===binding.revision&&m.kind===binding.kind;}finally{v.close();}
}
export function competingClaudeEnv(key: string): boolean {
 return /^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL|CUSTOM_HEADERS|LOG|PROFILE|CONFIG_DIR)|CLAUDE_CODE_(?:OAUTH_.*|SESSION_ACCESS_TOKEN.*|API_KEY_HELPER.*|USE_(?:BEDROCK|VERTEX|FOUNDRY|GATEWAY|CLAUDE_GATEWAY))|NODE_OPTIONS|NODE_PATH|DEBUG|CLAUDE_CODE_DEBUG)$/.test(key);
}
export function managedClaudeEnv(base: NodeJS.ProcessEnv, extra: Record<string,string>, token?: string): NodeJS.ProcessEnv {
 if(Object.keys(base).some(key=>/^CLAUDE_CODE_.*SETTINGS.*$/.test(key)&&base[key]))throw unavailable();
 const env={...base};for(const key of Object.keys(env))if(competingClaudeEnv(key))delete env[key];
 for(const [key,value] of Object.entries(extra)) { if(competingClaudeEnv(key)&&value)throw unavailable();env[key]=value; }
 if(token!==undefined)env.CLAUDE_CODE_OAUTH_TOKEN=token;return env;
}
function boundedFile(path: string, max: number): Buffer {
 let fd:number|undefined;
 try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);const s=fstatSync(fd);if(!s.isFile()||s.size>max)throw unavailable();
  const bytes=Buffer.alloc(max+1);let count=0,n=0;do{n=readSync(fd,bytes,count,bytes.length-count,null);count+=n;}while(n>0&&count<bytes.length);
  if(count>max)throw unavailable();return bytes.subarray(0,count);}
 finally{if(fd!==undefined)closeSync(fd);}
}
export function readManagedClaudeSpec(path:string):ManagedClaudeSpec {
 try{const s=lstatSync(path);if(s.isSymbolicLink()||s.nlink!==1||(process.getuid&&s.uid!==process.getuid())||(process.platform!=="win32"&&(s.mode&0o077)))throw unavailable();
  const parsed=specSchema.parse(JSON.parse(boundedFile(path,65536).toString("utf8")));if(!parsed.ready)throw unavailable();return parsed;
 }catch{throw unavailable();}
}
/** Fingerprints of auth-source inputs, not their values. Policy changes during source probing refuse the launch. */
export function managedClaudeAuthInputs(spec:ManagedClaudeSpec):string {
 const paths=new Set<string>();
 const sourceIndex=spec.args.indexOf("--setting-sources"), isolated=sourceIndex>=0&&spec.args[sourceIndex+1]==="";
 if(!isolated)for(const path of spec.settingsPaths)paths.add(path);
 // Managed policy is loaded even when ordinary user/project settings sources are disabled.
 for(const path of spec.policyPaths){
  paths.add(path);const directory=join(dirname(path),"managed-settings.d");
  if(existsSync(directory)){
   if(lstatSync(directory).isSymbolicLink())throw unavailable();const entries:string[]=[];const dir=opendirSync(directory);let count=0;
   try{let entry;while((entry=dir.readSync())){if(++count>256)throw unavailable();if(!entry.name.startsWith(".")&&entry.name.endsWith(".json")){if(entries.length>=64)throw unavailable();entries.push(join(directory,entry.name));}}}finally{dir.closeSync();}
   for(const entry of entries)paths.add(entry);
  }
 }
 const remoteCache=join(spec.configDir,"remote-settings.json");
 if(existsSync(remoteCache)){
  let cache:unknown;try{cache=JSON.parse(boundedFile(remoteCache,1_048_576).toString("utf8"));}catch{throw unavailable();}
  // A dynamically supplied policy cannot be proven from auth status's source-class field.
  if(!cache||typeof cache!=="object"||Array.isArray(cache)||Object.keys(cache).length)throw unavailable();paths.add(remoteCache);
 }
 if(spec.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH)throw unavailable();
 const settingsIndex=spec.args.indexOf("--settings"),settingsPath=spec.args[settingsIndex+1];
 if(settingsIndex<0||!settingsPath)throw unavailable();
 const ownRaw=boundedFile(settingsPath,1_048_576);let own:Record<string,unknown>;
 try{own=JSON.parse(ownRaw.toString("utf8"));}catch{throw unavailable();}
 if(!own||typeof own!=="object"||Array.isArray(own)||(spec.binding.kind==="api-key"?own.apiKeyHelper!==spec.helperCommand:own.apiKeyHelper!==undefined))throw unavailable();
 if(own.env&&typeof own.env==="object"&&Object.keys(own.env).some(key=>competingClaudeEnv(key)&&!(key==="NODE_OPTIONS"||key==="NODE_PATH")))throw unavailable();
 let total=ownRaw.length;
 const hashes:string[]=[createHash("sha256").update(ownRaw).digest("hex")];
 for(const path of [...paths].sort()){
  if(!existsSync(path)){hashes.push(path+":absent");continue;}
  let data:unknown;const raw=boundedFile(path,1_048_576);total+=raw.length;if(total>4_194_304)throw unavailable();try{data=JSON.parse(raw.toString("utf8"));}catch{throw unavailable();}
  if(!data||typeof data!=="object"||Array.isArray(data))throw unavailable();const r=data as Record<string,unknown>;
  if(["apiKeyHelper","awsAuthRefresh","awsCredentialExport","forceLoginMethod","forceLoginOrgUUID","forceLoginGatewayUrl","policyHelper","wslInheritsWindowsSettings"].some(key=>r[key]!==undefined))throw unavailable();
  if(r.env!==undefined){if(!r.env||typeof r.env!=="object"||Array.isArray(r.env))throw unavailable();if(Object.keys(r.env).some(competingClaudeEnv))throw unavailable();}
  hashes.push(path+":"+createHash("sha256").update(raw).digest("hex"));
 }
 return createHash("sha256").update(JSON.stringify(hashes)).digest("hex");
}
export interface ManagedClaudeRuntime { runner?:string; nodeArgs?:string[]; policyPaths?:string[]; settingsPaths?:string[]; }
export interface ManagedClaudeLaunch { binding:Readonly<ManagedClaudeBinding>; path:string; helper:string; command(args:string[], env:Record<string,string>, binary:string):string; }
export function prepareManagedClaudeLaunch(binding:ManagedClaudeBinding, instanceDir:string, cwd:string, configDir:string,
 runtime?:ManagedClaudeRuntime):ManagedClaudeLaunch {
 const adjacent=fileURLToPath(new URL("./claude-credential-runner.js",import.meta.url));
 const nodeArgs=runtime?.nodeArgs??[],runner=runtime?.runner??(existsSync(adjacent)?adjacent:join(dirname(adjacent),"..","dist","claude-credential-runner.js"));
 const policyPaths=runtime?.policyPaths??[process.platform==="darwin"?"/Library/Application Support/ClaudeCode/managed-settings.json":process.platform==="win32"?join(process.env.ProgramFiles||"C:\\Program Files","ClaudeCode","managed-settings.json"):"/etc/claude-code/managed-settings.json"];
 const settingsPaths=runtime?.settingsPaths??(()=>{
  const paths=[join(configDir,"settings.json")];let at=resolve(cwd),count=0;
  while(count++<64){
   // A named config directory replaces user settings; do not mistake the owner's default home for a project.
   if(at===resolve(homedir())&&at!==resolve(cwd))return paths;
   paths.push(join(at,".claude","settings.json"),join(at,".claude","settings.local.json"));
   const parent=dirname(at);if(existsSync(join(at,".git"))||parent===at)return paths;at=parent;
  }
  throw unavailable();
 })();
 if(!existsSync(runner))throw unavailable();
 const path=join(instanceDir,`claude-credential-${randomUUID()}.json`),prefix=[process.execPath,...nodeArgs,runner];
 const helper=[...prefix,"helper",path].map(shellQuote).join(" ");
 const frozenBinding=Object.freeze(bindingSchema.parse(binding));
 const ref:ManagedClaudeSpec={settingsPaths,policyPaths,helperCommand:helper,binding:frozenBinding,cwd:resolve(cwd),configDir:resolve(configDir),ready:false,binary:"",args:[],env:{}};
 const write=(spec:ManagedClaudeSpec)=>{const temp=path+".tmp";try{writeFileSync(temp,JSON.stringify(spec),{mode:0o600,flag:"wx"});renameSync(temp,path);}finally{try{unlinkSync(temp);}catch{}}};
 write(ref);
 return {binding:frozenBinding,path,helper,command(args,env,binary){
  if(!isAbsolute(binary))throw unavailable();
  const spec=specSchema.parse({...ref,ready:true,binary,args,env:{...env,CLAUDE_CONFIG_DIR:resolve(configDir)}});
  if(!currentManagedClaude(frozenBinding))throw unavailable();managedClaudeEnv(process.env,spec.env);managedClaudeAuthInputs(spec);write(spec);
  return [...prefix,"launch",path].map(shellQuote).join(" ");
 }};
}
/** No network/provider validation: this asks the CLI only which local source it selected. */
export function probeManagedClaudeSource(spec:ManagedClaudeSpec,env:NodeJS.ProcessEnv):boolean {
 const index=spec.args.indexOf("--settings"),settings=index>=0?spec.args[index+1]:null;if(!settings)return false;
 const isolated=spec.args.indexOf("--setting-sources");
 const args=["--settings",settings,...(isolated>=0?["--setting-sources",spec.args[isolated+1]!]:[]),"auth","status","--json"];
 const r=spawnSync(spec.binary,args,{cwd:spec.cwd,env,encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:5000,maxBuffer:32768});
 try{const data=JSON.parse(r.stdout||"{}");return r.status===0&&data.loggedIn===true&&data.apiProvider==="firstParty"&&
  (spec.binding.kind==="setup-token"?data.authMethod==="oauth_token":data.authMethod==="api_key_helper"&&data.apiKeySource==="apiKeyHelper");}
 catch{return false;}
}

/** Keep the Buffer alive until the private pipe has accepted it, then erase our copy. */
export async function writeClaudeCredentialPipe(value:Buffer, output:{write:(value:Buffer,callback:(error?:Error|null)=>void)=>unknown}):Promise<void>{
 try{await new Promise<void>((resolve,reject)=>output.write(value,error=>error?reject(Error("credential pipe unavailable")):resolve()));}
 finally{value.fill(0);}
}
