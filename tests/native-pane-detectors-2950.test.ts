import {describe,expect,it,vi}from'vitest';
import{readFileSync}from'node:fs';
import{createNativePaneBackend}from'../src/backend/native-pane.js';
import{ClaudeCodeBackend,ClaudePaneDetectors}from'../src/backend/claude-code.js';
import{CodexBackend,CodexPaneDetectors}from'../src/backend/codex.js';
const {io}=vi.hoisted(()=>({io:[] as string[]}));
vi.mock('node:fs',async original=>{
 const actual=await original<typeof import('node:fs')>();const wrapped:Record<string,unknown>={...actual};
 for(const key of ['readFileSync','writeFileSync','mkdirSync','existsSync','realpathSync','readdirSync','statSync','lstatSync','renameSync','symlinkSync']) {
  const fn=actual[key as keyof typeof actual] as (...args:unknown[])=>unknown;wrapped[key]=(...args:unknown[])=>{io.push(key);return fn(...args);};
 }
 return wrapped;
});
vi.mock('../src/backend/types.js',async original=>({...await original<typeof import('../src/backend/types.js')>(),resolveBinary:()=>{io.push('resolveBinary');return 'inert-cli';}}));
const state=()=>({sessionId:'11111111-1111-4111-8111-111111111111',contextPercentage:23,statusLineItems:['context-window-remaining'],resumes:true});
const claudeFixtures=['claude-2.1.306-trust-dialog.pane.txt','claude-2.1.314-trust-keys-dropped.pane.txt','claude-2.1.306-busy-queued.pane.txt','claude-2.1.294-ready-statusline.pane.txt'];
const codexFixtures=['codex-0160-busy.pane.txt','codex-audit-0162/v0162/idle.pane.txt','codex-audit-0162/v0162/trust-prompt-git.pane.txt'];
function verdict(detectors:ClaudePaneDetectors|CodexPaneDetectors,pane:string){return{
 ready:detectors.getReadyPattern().test(pane),busy:detectors.getBusyPattern().test(pane),
 startup:detectors.getStartupDialogs().map(d=>({description:d.description,active:d.pattern.test(pane)&&(!d.isActive||d.isActive(pane)),keys:d.keys})),
 runtime:detectors.getRuntimeDialogs().map(d=>({description:d.description,active:d.pattern.test(pane)&&(!d.isActive||d.isActive(pane)),keys:d.keys})),
 errors:detectors.getErrorPatterns().map(d=>({type:d.type,active:d.pattern.test(pane)}))};}
describe('native detector extraction preserves local pane behavior',()=>{
 it('native Codex permits only its exact trailing shortcut hint after a proved footer; local behavior stays unchanged',()=>{
  const base='› Ask Codex to do anything\n\n  Context 100% left\n',pane=base+'  ? for shortcuts\n',context={statusLineItems:()=>['context-remaining'],launchMayResume:()=>false};
  const local=new CodexPaneDetectors(context),native=new CodexPaneDetectors({...context,windowsConpty:true});
  expect(local.isDeliveryInputReadyPane(pane)).toBe(false);expect(local.getReadyPattern().test(pane)).toBe(false);expect(native.isDeliveryInputReadyPane(pane)).toBe(true);expect(native.getReadyPattern().test(pane)).toBe(true);
  for(const invalid of ['› 1. Update now\n\n  Context 100% left\n  ? for shortcuts\n',base+'  arbitrary transcript footer\n  ? for shortcuts\n',base+'  ? for shortcuts\n  unknown\n','› Ask Codex to do anything\n  ? for shortcuts\n']){
   expect(native.isDeliveryInputReadyPane(invalid)).toBe(false);expect(native.getReadyPattern().test(invalid)).toBe(false);
  }
 });
 it.each(claudeFixtures)('Claude parity on %s',file=>{
  const pane=readFileSync('tests/fixtures/'+file,'utf8'),local=Object.create(ClaudeCodeBackend.prototype) as ClaudeCodeBackend;
  expect(verdict(new ClaudePaneDetectors(),pane)).toEqual(verdict(local,pane));
 });
 it.each(codexFixtures)('Codex parity on %s',file=>{
  const pane=readFileSync('tests/fixtures/'+file,'utf8'),local=Object.create(CodexBackend.prototype) as CodexBackend;
  Object.assign(local,{configuredStatusLineItems:['context-window-remaining'],configuredStatusLinePattern:undefined});
  expect(verdict(new CodexPaneDetectors({statusLineItems:()=>['context-window-remaining'],launchMayResume:()=>true}),pane)).toEqual(verdict(local,pane));
 });
 it.each(['codex','claude-code'] as const)('%s detector facade performs no binary lookup or provider filesystem operation',provider=>{
  const pane=readFileSync('tests/fixtures/codex-audit-0162/v0162/trust-prompt-git.pane.txt','utf8');io.length=0;
  const backend=createNativePaneBackend(provider,state);backend.getReadyPattern();backend.getBusyPattern?.();backend.getErrorPatterns?.();backend.getRuntimeDialogs?.();
  for(const dialog of backend.getStartupDialogs?.()??[]){dialog.isActive?.(pane);dialog.heldReason?.(pane);dialog.answerDetail?.(pane);}
  backend.getSessionId();backend.getContextUsage();expect(io).toEqual([]);
 });
 it('native facade has no local launch/config escape and reads only verified runtime snapshots',()=>{
  const current=state(),backend=createNativePaneBackend('codex',()=>current);
  expect(backend.getSessionId()).toBe(current.sessionId);expect(backend.getContextUsage()).toBe(23);
  expect(()=>backend.buildCommand({} as never)).toThrow('owned Windows');expect(()=>backend.writeConfig({} as never)).toThrow('owned Windows');
  expect(backend.preTrust).toBeUndefined();expect(backend.resolveWorkingDirectory).toBeUndefined();expect(backend.cleanup).toBeUndefined();
 });
 it('a pinned Claude resume holds its generic session picker rather than creating a fresh conversation',()=>{
  const backend=createNativePaneBackend('claude-code',state),dialog=backend.getStartupDialogs!().find(d=>d.description==='Claude resume session picker — start fresh')!;
  expect(dialog.keys).toEqual([]);expect(dialog.holdOnly).toBe(true);expect(dialog.blocksDelivery).toBe(true);
 });
});

it.each(['startup','runtime'] as const)('native Claude %s trust keys require the one exact configured Windows cwd',phase=>{
 const cwd='C:\\Users\\changhansung\\agend-adapter-proto\\child',backend=createNativePaneBackend('claude-code',()=>({...state(),cwd}));
 const fixture=readFileSync('tests/fixtures/claude-2.1.314-trust-dialog.pane.txt','utf8');
 const pane=fixture.replace('/home/han/.cache/cc314-audit/w/k314',cwd);
 const dialogs=phase==='startup'?backend.getStartupDialogs!():backend.getRuntimeDialogs!();
 const active=(screen:string)=>dialogs.filter(dialog=>dialog.pattern.test(screen)&&(!dialog.isActive||dialog.isActive(screen)));
 expect(active(pane).some(dialog=>!dialog.holdOnly&&dialog.keys.includes('Down'))).toBe(true);
 for(const wrong of [pane.replace(cwd,'C:\\another-workspace'),pane.replace(cwd,''),pane.replace(cwd,cwd+'\nC:\\ambiguous'),pane.replace(cwd,'C:\\Users\\changhansung\\\nagend-adapter-proto\\child')]){
  expect(active(wrong).some(dialog=>dialog.keys.length>0)).toBe(false);expect(active(wrong).some(dialog=>dialog.holdOnly)).toBe(true);
 }
 expect(active(pane.replace(cwd,cwd.replaceAll('\\','/').toUpperCase())).some(dialog=>!dialog.holdOnly&&dialog.keys.includes('Down'))).toBe(true);
});

it('Windows Claude shell choices are held and exposed verbatim, never automatically answered',()=>{
 const backend=createNativePaneBackend('claude-code',state),screen='PowerShell command\nnode -e "scratch sentinel"\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, allow this command\n  3. No\nEsc to cancel · Tab to amend\n';
 const dialog=backend.getRuntimeDialogs!().find(row=>row.description.startsWith('Claude Windows shell permission'))!;
 expect(dialog.isActive?.(screen)).toBe(true);expect(dialog.isActive?.(screen.replace('3. No','3. Type here to tell Claude what to do differently'))).toBe(true);expect(dialog.remoteCard?.(screen.replace('3. No','3. Nostale scratch fragment'))?.options[2].title).toBe('Nostale scratch fragment');expect(dialog.keys).toEqual([]);expect(dialog.holdOnly&&dialog.blocksDelivery&&dialog.inputBlocked).toBe(true);expect(dialog.remoteCard?.(screen)).toMatchObject({kind:'question',options:[{n:1,title:'Yes'},{n:2,title:'Yes, allow this command'},{n:3,title:'No'}]});
 for(const text of [screen+'\n'+'─'.repeat(40)+'\n❯ \n'+'─'.repeat(40),screen.replace('PowerShell command','ordinary quoted text'),screen.replace('❯ 1.','  1.'),screen.replace('Esc to cancel · Tab to amend','unrecognised footer')])expect(dialog.isActive?.(text)).toBe(false);
});
