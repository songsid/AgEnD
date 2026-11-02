/** No native CLI or provider profile: scratch files and fixed argv only. */
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';import { join } from 'node:path';import { randomUUID } from 'node:crypto';
import { prepareNativePaneConfig } from '../src/runtime-pane-config.js';
import { persistentNativeArguments, type NativePaneOwner } from '../src/runtime-pane-native.js';
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
it('adds and removes only the owned Codex workspace marker, preserving other text and agents',()=>{
 const f=rig();const original='# User instructions\n\n<!-- AGEND-PANE:other:BEGIN -->\nother rules\n<!-- AGEND-PANE:other:END -->\n';writeFileSync(join(f.cwd,'AGENTS.md'),original);
 const config=f.prepare();expect(readFileSync(join(f.cwd,'AGENTS.md'),'utf8')).toContain(original);expect(readFileSync(join(f.cwd,'AGENTS.md'),'utf8')).toContain(f.launch.instructions);
 const args=persistentNativeArguments(f.launch,config);expect(args[0]).toBe('--no-daemon');expect(args).toContain('tui.status_line=["context-remaining"]');expect(args.join(' ')).not.toContain(f.owner.mcp!.token);expect(args).toContain(`mcp_servers.${config.mcp!.serverName}.command="C:\\\\Node\\\\node.exe"`);
 config.cleanup();expect(readFileSync(join(f.cwd,'AGENTS.md'),'utf8')).toBe(original);
});
it('a positively replaced launch updates its stable agent marker instead of retaining stale instructions',()=>{
 const f=rig();f.prepare();f.owner.launchId=randomUUID();f.owner.mcp!.owner.launchId=f.owner.launchId;f.launch.instructions='new owned rules';const config=f.prepare();
 const text=readFileSync(join(f.cwd,'AGENTS.md'),'utf8');expect(text).not.toContain('Own fleet instructions');expect(text).toContain('new owned rules');expect(text.match(/:BEGIN/g)).toHaveLength(1);config.cleanup();
});
it('refuses symlink workspace instructions, incomplete owned markers and competing writers',()=>{
 const f=rig();const file=join(f.cwd,'AGENTS.md'),target=join(f.root,'unrelated');writeFileSync(target,'do not touch');symlinkSync(target,file);expect(f.prepare).toThrow('regular');expect(readFileSync(target,'utf8')).toBe('do not touch');rmSync(file);
 writeFileSync(file,`<!-- AGEND-PANE:${f.launch.agentId}:BEGIN -->\npartial`);expect(f.prepare).toThrow('incomplete');expect(readFileSync(file,'utf8')).toContain('partial');rmSync(file);
 mkdirSync(join(f.cwd,'.agend-pane-instructions.lock'));expect(f.prepare).toThrow();expect(existsSync(file)).toBe(false);
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
