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
