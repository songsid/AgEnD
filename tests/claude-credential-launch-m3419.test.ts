import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync, readdirSync, symlinkSync } from "node:fs";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { ClaudeCredentialVault } from "../src/claude-credential-vault.js";
import { managedClaudeBinding, managedClaudeEnv, managedClaudeAuthInputs, prepareManagedClaudeLaunch, readManagedClaudeSpec, writeClaudeCredentialPipe, competingClaudeEnv } from "../src/claude-credential-launch.js";
import { CLASSIC_RESTRICTED_TOOLS } from "../src/contact-auth-types.js";
import { Daemon } from "../src/daemon.js";
import pino from "pino";
import type { Logger } from "../src/logger.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import type { CliBackendConfig } from "../src/backend/types.js";
vi.mock("node:fs",async importOriginal=>{const actual=await importOriginal<typeof import("node:fs")>();return {...actual,lstatSync:vi.fn(actual.lstatSync),existsSync:vi.fn(actual.existsSync)};});
beforeEach(async()=>{const actual=await vi.importActual<typeof import("node:fs")>("node:fs");vi.mocked(fs.lstatSync).mockImplementation(actual.lstatSync);vi.mocked(fs.existsSync).mockImplementation(actual.existsSync);});
const dirs:string[]=[],vaults:ClaudeCredentialVault[]=[],actor={adapterId:"test",userId:"admin"};
const value="synthetic-"+"x".repeat(48),ambient="synthetic-"+"y".repeat(48);
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const v of vaults.splice(0))v.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(kind:"api-key"|"setup-token"="api-key",profile:string|null="spare"){
 const root=mkdtempSync(join(tmpdir(),"claude-launch-"));dirs.push(root);const home=join(root,"state"),cwd=join(root,"work"),instance=join(root,"instance"),config=join(root,"profile");
 for(const p of [home,cwd,instance,config])mkdirSync(p,{mode:0o700});
 for(const key of Object.keys(process.env))if(competingClaudeEnv(key))vi.stubEnv(key,undefined);
 vi.stubEnv('HOME',root);vi.stubEnv('AGEND_HOME',home);vi.stubEnv('CLAUDE_CONFIG_DIR',config);
 const vault=new ClaudeCredentialVault(home);vaults.push(vault);vault.write(profile,0,{kind,value},actor);
 const binding=managedClaudeBinding(home,profile)!,binary=join(root,"fake-claude");
 writeFileSync(binary,`#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto');
const a=process.argv.slice(2);if(a.includes('--help')){console.log('--effort (low, medium, high)');process.exit(0);}
const settings=JSON.parse(fs.readFileSync(a[a.indexOf('--settings')+1],'utf8'));
if(a.includes('auth')&&a.includes('status')){if(process.env.FAKE_VAULT_DB){const D=require(process.env.FAKE_SQLITE_MODULE),db=new D(process.env.FAKE_VAULT_DB);db.exec("UPDATE credentials SET revision=revision+1");db.close();}if(process.env.FAKE_CHANGED_SETTINGS)fs.writeFileSync(process.env.FAKE_CHANGED_SETTINGS,JSON.stringify({model:'other-model'}));console.log(JSON.stringify(process.env.FAKE_WRONG_SOURCE?{loggedIn:true,authMethod:'api_key',apiProvider:'firstParty'}:{loggedIn:true,authMethod:process.env.CLAUDE_CODE_OAUTH_TOKEN?'oauth_token':'api_key_helper',apiProvider:'firstParty',apiKeySource:'apiKeyHelper'}));process.exit(0);}
const raw=process.env.CLAUDE_CODE_OAUTH_TOKEN?Buffer.from(process.env.CLAUDE_CODE_OAUTH_TOKEN):cp.execSync(settings.apiKeyHelper,{env:process.env,stdio:['ignore','pipe','pipe']});
const digest=crypto.createHash('sha256').update(raw).digest('hex');raw.fill(0);
console.log(JSON.stringify({digest,api:!!process.env.ANTHROPIC_API_KEY,base:!!process.env.ANTHROPIC_BASE_URL,cloud:!!process.env.CLAUDE_CODE_USE_BEDROCK,cwd:process.cwd(),args:a}));
`,{mode:0o700});
 return {root,home,cwd,instance,config,vault,binding,binary};
}
function stage(f:ReturnType<typeof fixture>){
 const launch=prepareManagedClaudeLaunch(f.binding,f.instance,f.cwd,f.config,{policyPaths:[join(f.root,"policy.json")],settingsPaths:[join(f.config,"settings.json"),join(f.cwd,".claude/settings.json"),join(f.cwd,".claude/settings.local.json")]});
 const settings=join(f.instance,"settings.json");writeFileSync(settings,JSON.stringify(f.binding.kind==="api-key"?{apiKeyHelper:launch.helper}:{}),{mode:0o600});
 const command=launch.command(["--settings",settings],{CLAUDE_CONFIG_DIR:f.config},f.binary);
 return {launch,settings,command};
}
function run(command:string,f:ReturnType<typeof fixture>,extra:NodeJS.ProcessEnv={}){
 return spawnSync('/bin/sh',['-c',command],{cwd:f.cwd,env:{PATH:process.env.PATH,HOME:f.root,CLAUDE_CONFIG_DIR:f.config,ANTHROPIC_API_KEY:ambient,ANTHROPIC_BASE_URL:'https://example.invalid',CLAUDE_CODE_USE_BEDROCK:'1',CLAUDE_CODE_OAUTH_TOKEN:ambient,...extra},encoding:'utf8',timeout:10000});
}
it.each(["api-key","setup-token"] as const)("%s uses the child source and private helper pipe without changing parent env or writing plaintext",kind=>{
 const f=fixture(kind),s=stage(f),r=run(s.command,f);expect(r.status).toBe(0);
 const out=JSON.parse(r.stdout);expect(out).toMatchObject({digest:createHash('sha256').update(value).digest('hex'),api:false,base:false,cloud:false,cwd:f.cwd});
 expect(s.command).not.toContain(value);expect(s.command).not.toContain(ambient);
 expect(readFileSync(s.launch.path,'utf8')).not.toContain(value);expect(readFileSync(s.settings,'utf8')).not.toContain(value);
 expect(r.stderr).not.toContain(value);expect(r.stdout).not.toContain(value);expect(readManagedClaudeSpec(s.launch.path).binding.kind).toBe(kind);
});
it("a stale helper/launcher refuses after replace or removal, never returning a newer credential",()=>{
 const f=fixture(),s=stage(f);f.vault.write('spare',1,{kind:'api-key',value:ambient},actor);
 for(const command of [s.command,s.launch.helper]){const r=run(command,f);expect(r.status).not.toBe(0);expect(r.stdout).toBe('');expect(r.stderr).not.toContain(value);expect(r.stderr).not.toContain(ambient);}
 f.vault.write('spare',2,null,actor);expect(()=>managedClaudeBinding(f.home,'spare')).toThrow('unavailable');
});
it("wrong CLI source, competing settings, changed helper and policy indirection refuse before the real run",()=>{
 const f=fixture(),s=stage(f);expect(run(s.command,f,{FAKE_WRONG_SOURCE:'1'}).status).not.toBe(0);
 writeFileSync(join(f.config,'settings.json'),JSON.stringify({env:{ANTHROPIC_API_KEY:ambient}}));expect(run(s.command,f).status).not.toBe(0);rmSync(join(f.config,'settings.json'));
 mkdirSync(join(f.cwd,'.claude'));writeFileSync(join(f.cwd,'.claude/settings.local.json'),JSON.stringify({apiKeyHelper:'unselected-command'}));expect(run(s.command,f).status).not.toBe(0);rmSync(join(f.cwd,'.claude'),{recursive:true});
 expect(run(s.command,f,{CLAUDE_CODE_MANAGED_SETTINGS_PATH:join(f.root,'other')}).status).not.toBe(0);
 writeFileSync(s.settings,JSON.stringify({apiKeyHelper:'unselected-command'}));expect(()=>managedClaudeAuthInputs(readManagedClaudeSpec(s.launch.path))).toThrow('unavailable');expect(run(s.command,f).status).not.toBe(0);
});
it("auth inputs change on a new settings file, and private launch specs reject loose permissions",()=>{
 const f=fixture(),s=stage(f),spec=readManagedClaudeSpec(s.launch.path),before=managedClaudeAuthInputs(spec);
 writeFileSync(join(f.config,'settings.json'),JSON.stringify({model:'safe-model'}));expect(managedClaudeAuthInputs(spec)).not.toBe(before);
 chmodSync(s.launch.path,0o644);expect(()=>readManagedClaudeSpec(s.launch.path)).toThrow('unavailable');
});
it("clears all competing sources without mutating the parent or accepting them from a launch override",()=>{
 const parent={ANTHROPIC_API_KEY:ambient,ANTHROPIC_AUTH_TOKEN:ambient,CLAUDE_CODE_OAUTH_TOKEN:ambient,CLAUDE_CODE_OAUTH_TOKEN_FD:'3',CLAUDE_CODE_USE_VERTEX:'1',KEEP:'yes'};
 const result=managedClaudeEnv(parent,{},value);expect(result).toEqual({KEEP:'yes',CLAUDE_CODE_OAUTH_TOKEN:value});expect(parent.ANTHROPIC_API_KEY).toBe(ambient);
 expect(()=>managedClaudeEnv(parent,{ANTHROPIC_API_KEY:ambient})).toThrow('unavailable');
});
it("production backend writes only the opaque helper and bypasses ambient key approval; resume/model flags survive",()=>{
 const f=fixture('api-key',null),settings=join(f.instance,'claude-settings.json'),backend=new ClaudeCodeBackend(f.instance,{policyPaths:[join(f.root,"policy.json")],settingsPaths:[join(f.config,"settings.json"),join(f.cwd,".claude/settings.json"),join(f.cwd,".claude/settings.local.json")]});backend.refreshLaunchBinary(f.binary);
 const oldKey=process.env.ANTHROPIC_API_KEY,oldBase=process.env.ANTHROPIC_BASE_URL,oldConfig=process.env.CLAUDE_CONFIG_DIR;
 try{process.env.ANTHROPIC_API_KEY=ambient;process.env.ANTHROPIC_BASE_URL='https://example.invalid';process.env.CLAUDE_CONFIG_DIR=f.config;
 const config:CliBackendConfig={instanceDir:f.instance,workingDirectory:f.cwd,instanceName:'helper',mcpServers:{},managedClaudeCredential:f.binding,skipPermissions:true,model:'claude-sonnet-4-6',resumeSessionId:'11111111-1111-4111-8111-111111111111'};
 backend.writeConfig(config);const command=backend.buildCommand(config),r=run(command,f);expect(r.status).toBe(0);
 expect(JSON.parse(r.stdout).args).toEqual(expect.arrayContaining(['--model','claude-sonnet-4-6','--resume','11111111-1111-4111-8111-111111111111']));
 const text=readFileSync(settings,'utf8');expect(text).toContain('apiKeyHelper');expect(text+command).not.toContain(value);expect(text+command).not.toContain(ambient);expect(()=>readFileSync(join(f.config,'.claude.json'))).toThrow();
 }finally{for(const [key,old] of [['ANTHROPIC_API_KEY',oldKey],['ANTHROPIC_BASE_URL',oldBase],['CLAUDE_CONFIG_DIR',oldConfig]]){if(old===undefined)delete process.env[key!];else process.env[key!]=old;}}
});

it("retains the private-pipe buffer until acceptance and erases it on success or error",async()=>{
 const raw=Buffer.from(value);let accept!:(error?:Error|null)=>void;
 const done=writeClaudeCredentialPipe(raw,{write:(b,callback)=>{expect(b).toBe(raw);accept=callback;return false;}});
 expect(raw.toString()).toBe(value);accept();await done;expect(raw.equals(Buffer.alloc(raw.length))).toBe(true);
 const bad=Buffer.from(value),failed=writeClaudeCredentialPipe(bad,{write:(_b,callback)=>callback(Error('synthetic failure'))});await expect(failed).rejects.toThrow('pipe unavailable');expect(bad.equals(Buffer.alloc(bad.length))).toBe(true);
});

it("a revision or settings change during the CLI source probe refuses the setup-token launch",()=>{
 const f=fixture('setup-token'),s=stage(f);
 const changed=run(s.command,f,{FAKE_CHANGED_SETTINGS:join(f.config,'settings.json')});expect(changed.status).not.toBe(0);expect(changed.stdout).toBe('');rmSync(join(f.config,'settings.json'));
 const revised=run(s.command,f,{FAKE_VAULT_DB:join(f.home,'credential-vault/claude.sqlite'),FAKE_SQLITE_MODULE:createRequire(import.meta.url).resolve('better-sqlite3')});
 expect(revised.status).not.toBe(0);expect(revised.stdout).toBe('');
});

it("daemon binds only the server-owned state/profile at launch and cleanup works after removal",async()=>{
 const f=fixture(),instance=join(f.home,'instances','helper');mkdirSync(instance,{recursive:true});vi.stubEnv('AGEND_HOME',f.home);
 const backend=new ClaudeCodeBackend(instance),cleanup=vi.spyOn(backend,'cleanup');
 const daemon=new Daemon('helper',{backend:'claude-code',working_directory:f.cwd,backend_options:{'claude-code':{credential_profile:'spare'}},log_level:'info'} as any,instance,false,backend,undefined,pino({level:'silent'}) as Logger) as any;
 expect(daemon.buildBackendConfig(true).managedClaudeCredential).toMatchObject(f.binding);
 f.vault.write('spare',1,null,actor);expect(()=>daemon.buildBackendConfig(true)).toThrow('unavailable');
 expect(daemon.buildBackendConfig(false).managedClaudeCredential).toBeUndefined();daemon.tmux=null;await expect(daemon.stop()).resolves.toBeUndefined();expect(cleanup).toHaveBeenCalledOnce();
});

it("preserves a covered Classic guard alongside the managed helper without fabricating its receipt",()=>{
 const f=fixture('api-key',null);vi.stubEnv('CLAUDE_CONFIG_DIR',f.config);
 const backend=new ClaudeCodeBackend(f.instance,{policyPaths:[join(f.root,'policy.json')],settingsPaths:[]}) as any;backend.refreshLaunchBinary(f.binary);
 backend.classicVersion='2.1.327';backend.classicPreparedBinaryStamp=backend.classicBinaryStamp();
 const plan={roomKey:'helper',policyRevision:1,publicRead:true,allowedAgendTools:CLASSIC_RESTRICTED_TOOLS,allowedMcpTools:[]};
 const config:CliBackendConfig={instanceDir:f.instance,workingDirectory:f.cwd,instanceName:'helper',mcpServers:{agend:{command:process.execPath,args:['synthetic-server.js'],env:{}}},managedClaudeCredential:f.binding,classicRestriction:plan};
 backend.writeConfig(config);const command=backend.buildCommand(config),ref=readManagedClaudeSpec(backend.managedLaunch.path),settings=JSON.parse(readFileSync(ref.args[ref.args.indexOf('--settings')+1]!,'utf8'));
 expect(settings.apiKeyHelper).toBe(ref.helperCommand);expect(settings.hooks.SessionStart).toBeDefined();expect(ref.args).toEqual(expect.arrayContaining(['--strict-mcp-config','--setting-sources','','--tools','WebSearch,WebFetch']));
 expect(backend.classicNativeGuard(plan).state).not.toBe('ready');const path=backend.managedLaunch.path;backend.cleanup(config);expect(()=>readFileSync(path)).toThrow();
});

it("refuses auth policy fragments, policy programs and opaque remote policy caches",()=>{
 const f=fixture(),s=stage(f),spec=readManagedClaudeSpec(s.launch.path),directory=join(f.root,'managed-settings.d');mkdirSync(directory);
 const fragment=join(directory,'10-auth.json');writeFileSync(fragment,JSON.stringify({env:{ANTHROPIC_PROFILE:'other-profile'}}));expect(()=>managedClaudeAuthInputs(spec)).toThrow('unavailable');
 writeFileSync(fragment,JSON.stringify({policyHelper:'unselected-program'}));expect(()=>managedClaudeAuthInputs(spec)).toThrow('unavailable');rmSync(directory,{recursive:true});
 writeFileSync(join(f.config,'remote-settings.json'),JSON.stringify({apiKeyHelper:'unselected-program'}));expect(()=>managedClaudeAuthInputs(spec)).toThrow('unavailable');
});

it("rejects a mismatched profile before file effects and a changed launch reference before typing",()=>{
 const f=fixture(),backend=new ClaudeCodeBackend(f.instance,{policyPaths:[],settingsPaths:[]});backend.refreshLaunchBinary(f.binary);
 const config:CliBackendConfig={instanceDir:f.instance,workingDirectory:f.cwd,instanceName:'helper',mcpServers:{},managedClaudeCredential:f.binding};
 expect(()=>backend.writeConfig(config)).toThrow('profile');expect(readdirSync(f.instance)).toEqual([]);
 config.backendOptions={credential_profile:'spare'};backend.writeConfig(config);
 expect(()=>backend.buildCommand({...config,managedClaudeCredential:{...f.binding,revision:2}})).toThrow('stale');
});

it("fresh selection refuses missing managed DB and dangling artifacts instead of ambient fallback",()=>{
 const f=fixture();f.vault.close();vaults.splice(vaults.indexOf(f.vault),1);
 rmSync(join(f.home,"credential-vault","claude.sqlite"));
 expect(()=>managedClaudeBinding(f.home,"spare")).toThrow("unavailable");
 rmSync(join(f.home,"credential-vault"),{recursive:true});
 expect(()=>managedClaudeBinding(f.home,"spare")).toThrow("unavailable");
 rmSync(join(f.home,"credential-keys"),{recursive:true});
 expect(managedClaudeBinding(f.home,"spare")).toBeNull();
 symlinkSync(join(f.root,"absent"),join(f.home,"credential-vault"));
 expect(()=>managedClaudeBinding(f.home,"spare")).toThrow("unavailable");
 rmSync(join(f.home,"credential-vault"));mkdirSync(join(f.home,"credential-vault"));
 symlinkSync(join(f.root,"absent"),join(f.home,"credential-vault","claude.sqlite"));
 expect(()=>managedClaudeBinding(f.home,"spare")).toThrow("unavailable");
});
it("selection refuses inaccessible state checks while a truly absent legacy vault stays legacy",()=>{
 const f=fixture();expect(managedClaudeBinding(f.home,"unused")).toBeNull();
 const exists=fs.existsSync;vi.spyOn(fs,"existsSync").mockImplementation(path=>String(path)===join(f.home,"credential-vault","claude.sqlite")?false:exists(path));
 const original=fs.lstatSync;
 vi.spyOn(fs,"lstatSync").mockImplementation(((path:fs.PathLike,...args:unknown[])=>{
  if(String(path)===join(f.home,"credential-vault","claude.sqlite"))throw Object.assign(new Error("synthetic inaccessible state"),{code:"EACCES"});
  return (original as Function)(path,...args);
 }) as typeof fs.lstatSync);
 expect(()=>managedClaudeBinding(f.home,"spare")).toThrow("unavailable");
});
it("fresh launch uses subscription only after explicit selection, not removal",()=>{
 const f=fixture();f.vault.write("spare",1,null,actor);
 expect(()=>managedClaudeBinding(f.home,"spare")).toThrow("unavailable");
 f.vault.write("spare",2,"subscription",actor);expect(managedClaudeBinding(f.home,"spare")).toBeNull();
 f.vault.write("spare",3,{kind:"api-key",value},actor);
 expect(managedClaudeBinding(f.home,"spare")).toMatchObject({id:f.binding.id,revision:4,kind:"api-key"});
});
