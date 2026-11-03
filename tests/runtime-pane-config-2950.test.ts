/** No native CLI or provider profile: scratch files and fixed argv only. */
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';import { join } from 'node:path';import { randomUUID } from 'node:crypto';
import { prepareNativePaneConfig } from '../src/runtime-pane-config.js';
import { assertAuditedNativePaneVersion, persistentNativeArguments, nativeDeveloperInstructions, nativePaneCommandLineLength, assertNativePaneCommandLine, type NativePaneOwner } from '../src/runtime-pane-native.js';
import { parse } from 'smol-toml'; import { createRequire } from 'node:module';
import { validateRuntimePaneLaunch, type RuntimePaneLaunch } from '../src/runtime-pane-protocol.js';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function rig(cli:'codex'|'claude-code'='codex'){
 const root=mkdtempSync(join(tmpdir(),'agend-pane-config-'));roots.push(root);const cwd=join(root,'workspace-中文');mkdirSync(cwd);
 const launch:RuntimePaneLaunch={paneId:randomUUID(),agentId:randomUUID(),instance:'agent-中文',cli,cwd,sandbox:'read-only',columns:80,rows:24,mcpTools:['reply'],instructions:'Own fleet instructions 中文'};
 const owner:NativePaneOwner={directory:root,launchId:randomUUID()};owner.mcp={endpoint:'http://127.0.0.1:12345/agent',token:'a'.repeat(64),tools:['reply'],owner:{hostBootId:randomUUID(),paneId:launch.paneId,agentId:launch.agentId,instance:launch.instance,launchId:owner.launchId}};
 const prepare=()=>prepareNativePaneConfig(launch,owner,'C:\\Node\\node.exe','C:\\Program Files\\AgEnD\\windows-pane-mcp.js');return{root,cwd,launch,owner,prepare};
}
it('keeps account credentials and host tokens out of argv; scopes the helper to the exact owner',()=>{
 const f=rig('claude-code'),config=f.prepare(),args=persistentNativeArguments(f.launch,config);expect(args).not.toContain(f.owner.mcp!.token);expect(args).toContain('--strict-mcp-config');expect(args).toContain('--append-system-prompt-file');expect(args).toContain('--permission-mode');expect(args).not.toContain('--dangerously-skip-permissions');
 expect(JSON.parse(readFileSync(config.mcp!.connectionPath,'utf8'))).toMatchObject({owner:f.owner.mcp!.owner,token:f.owner.mcp!.token});expect(readFileSync(config.instructionsFile!,'utf8')).toBe(f.launch.instructions);
 const files=[config.mcp!.connectionPath,config.mcp!.configPath,config.instructionsFile!];config.cleanup();expect(files.every(path=>!existsSync(path))).toBe(true);
});
it('pins a fresh Claude conversation before the first turn and resumes only the explicit saved id',()=>{
 const f=rig('claude-code'),config=f.prepare();expect(config.sessionId).toBe(f.owner.launchId);
 const args=persistentNativeArguments(f.launch,config);expect(args.slice(-2)).toEqual(['--session-id',f.owner.launchId]);expect(args).not.toContain('--resume');
 const saved=randomUUID();expect(persistentNativeArguments({...f.launch,sessionId:saved},config).slice(-2)).toEqual(['--resume',saved]);config.cleanup();
});
it('keeps Codex role instructions launch-local and leaves the workspace AGENTS file untouched',()=>{
 const f=rig(),file=join(f.cwd,'AGENTS.md'),original='# User instructions\n';writeFileSync(file,original);
 const config=f.prepare(),args=persistentNativeArguments(f.launch,config);expect(readFileSync(file,'utf8')).toBe(original);
 expect(args[0]).toBe('--no-daemon');expect(args).toContain('tui.status_line=["context-remaining"]');expect(args.join(' ')).not.toContain(f.owner.mcp!.token);
 const role=args.find(arg=>arg.startsWith('developer_instructions='))!;expect(role).toBeTypeOf('string');expect(parse(role).developer_instructions).toBe(f.launch.instructions);expect(args).not.toContain('--model-instructions-file');
 config.cleanup();expect(readFileSync(file,'utf8')).toBe(original);expect(existsSync(join(f.cwd,'.agend-pane-instructions.lock'))).toBe(false);
});
it('two same-cwd Codex launches have separate role slots and exact helper identities',()=>{
 const f=rig(),first=f.prepare(),secondLaunch={...f.launch,agentId:randomUUID(),instructions:'Second agent role only'},secondOwner=structuredClone(f.owner);secondOwner.launchId=randomUUID();Object.assign(secondOwner.mcp!.owner,{launchId:secondOwner.launchId,agentId:secondLaunch.agentId});
 const second=prepareNativePaneConfig(secondLaunch,secondOwner,'C:\\Node\\node.exe','C:\\program\\helper.js');
 const role=(launch:RuntimePaneLaunch,config:typeof first)=>parse(persistentNativeArguments(launch,config).find(arg=>arg.startsWith('developer_instructions='))!).developer_instructions;
 expect(role(f.launch,first)).toBe(f.launch.instructions);expect(role(secondLaunch,second)).toBe(secondLaunch.instructions);expect(first.mcp!.serverName).not.toBe(second.mcp!.serverName);expect(existsSync(join(f.cwd,'AGENTS.md'))).toBe(false);
 first.cleanup();second.cleanup();
});
it('never follows or rewrites a user workspace instruction link, marker or lock',()=>{
 const f=rig(),file=join(f.cwd,'AGENTS.md'),target=join(f.root,'unrelated');writeFileSync(target,'do not touch');symlinkSync(target,file);const config=f.prepare();expect(readFileSync(target,'utf8')).toBe('do not touch');config.cleanup();rmSync(file);
 const original=`<!-- AGEND-PANE:${f.launch.agentId}:BEGIN -->\nuser text`;writeFileSync(file,original);mkdirSync(join(f.cwd,'.agend-pane-instructions.lock'));
 f.owner.launchId=randomUUID();f.owner.mcp!.owner.launchId=f.owner.launchId;const next=f.prepare();next.cleanup();expect(readFileSync(file,'utf8')).toBe(original);
});
it('encodes the whole developer instruction as one TOML string, without shell interpretation or Unicode loss',()=>{
 const text=Array.from({length:128},(_,n)=>String.fromCharCode(n)).join('')+' 中文 😀 \" $() ` ;';expect(parse(nativeDeveloperInstructions(text)).developer_instructions).toBe(text);
 expect(()=>nativeDeveloperInstructions('bad\ud800')).toThrow('invalid Unicode');expect(()=>nativeDeveloperInstructions('bad\udc00')).toThrow('invalid Unicode');
});
it('counts the reviewed node-pty escaping and rejects an oversized Windows command before spawn',()=>{
 const {argsToCommandLine}=createRequire(import.meta.url)('node-pty/lib/windowsPtyAgent.js');
 const file='C:\\Program Files\\Node\\node.exe';let checked=0;
 for(const args of [[],[''],['plain','two words','中文 😀'],['path with space\\','a\\\"b','\"enclosed argument\"'],[nativeDeveloperInstructions('one\n中文 \\ \"quoted\"')]]){expect(nativePaneCommandLineLength(file,args)).toBe(argsToCommandLine(file,args).length);checked++;}expect(checked).toBe(5);
 expect(()=>assertNativePaneCommandLine(file,['x'.repeat(40000)])).toThrow('command-line limit');expect(()=>assertNativePaneCommandLine(file,['small'])).not.toThrow();
});
it('a mismatched MCP agent or tool scope fails before any workspace instructions are written',()=>{
 const f=rig();f.owner.mcp!.owner.agentId=randomUUID();expect(f.prepare).toThrow('scope differs');expect(existsSync(join(f.cwd,'AGENTS.md'))).toBe(false);
 f.owner.mcp!.owner.agentId=f.launch.agentId;f.owner.mcp!.tools=['task'];expect(f.prepare).toThrow('scope differs');expect(existsSync(join(f.cwd,'AGENTS.md'))).toBe(false);
});
it('cleanup preserves an unrelated file added to its private launch directory',()=>{
 const f=rig('claude-code'),config=f.prepare(),path=join(f.root,'launches',f.owner.launchId,'unowned.txt');writeFileSync(path,'keep');config.cleanup();expect(readFileSync(path,'utf8')).toBe('keep');
});
it('only bounded declarative instructions/tools/launch ids cross the pane protocol',()=>{
 const f=rig(),base={...f.launch,cwd:'C:\\scratch',launchId:randomUUID()};expect(validateRuntimePaneLaunch(base)).toEqual(base);
 for(const extra of [{instructions:'x'.repeat(65537)},{instructions:'NUL\0'},{mcpTools:['reply','reply']},{mcpTools:['reply;whoami']},{mcp:{token:'secret'}},{launchId:'not-an-id'}])expect(()=>validateRuntimePaneLaunch({...base,...extra})).toThrow();
});
it('Codex trusts only its exact configured AgEnD helper menu while preserving shell approval and sandbox policy',()=>{
 const f=rig(),config=f.prepare(),args=persistentNativeArguments(f.launch,config);
 const approved=args.filter(arg=>arg.includes('default_tools_approval_mode='));expect(approved).toEqual([`mcp_servers.${config.mcp!.serverName}.default_tools_approval_mode="approve"`]);
 expect(args.slice(args.indexOf('--ask-for-approval'),args.indexOf('--ask-for-approval')+2)).toEqual(['--ask-for-approval','on-request']);expect(args.slice(args.indexOf('--sandbox'),args.indexOf('--sandbox')+2)).toEqual(['--sandbox','read-only']);expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
 expect(persistentNativeArguments(f.launch).some(arg=>arg.includes('default_tools_approval_mode='))).toBe(false);config.cleanup();
});

it('cache and final launch version gates accept real lines and refuse stale or ambiguous releases',()=>{
 expect(()=>assertAuditedNativePaneVersion('codex','codex-cli 0.165.0')).not.toThrow();expect(()=>assertAuditedNativePaneVersion('claude-code','2.1.316 (Claude Code)')).not.toThrow();
 for(const line of ['codex-cli 0.166.0','codex-cli 0.165.0-beta','0.165.0 0.166.0','0.165.0+changed','unknown'])expect(()=>assertAuditedNativePaneVersion('codex',line)).toThrow('not passed');expect(()=>assertAuditedNativePaneVersion('kiro-cli','0.165.0')).toThrow();
});

it.each(['read-only','workspace-write'] as const)('Claude pane %s has a launch-local hard file policy without account or shell permission bypass',sandbox=>{
 const f=rig('claude-code'),config=f.prepare(),args=persistentNativeArguments({...f.launch,sandbox},config),index=args.indexOf('--settings');
 expect(index).toBeGreaterThanOrEqual(0);expect(JSON.parse(args[index+1])).toEqual({permissions:{blockWritesOutsideWorkingDirectories:true}});expect(args[args.indexOf('--setting-sources')+1]).toBe('');
 expect(args.filter(arg=>arg==='--settings')).toHaveLength(1);expect(args).not.toContain('--add-dir');expect(args).not.toContain('--dangerously-skip-permissions');
 expect(args[args.indexOf('--permission-mode')+1]).toBe(sandbox==='workspace-write'?'acceptEdits':'default');
 config.cleanup();
});
