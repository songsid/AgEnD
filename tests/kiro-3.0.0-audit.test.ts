import { readFileSync, mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { KiroBackend, probeKiroCliCompatibility, planKiroLaunch } from '../src/backend/kiro.js';
import { LOGIN_FLOWS } from '../src/login-flows.js';
const fixture=(name:string)=>readFileSync(join(import.meta.dirname,'fixtures/kiro-3.0.0-audit',name),'utf8');
const compat=()=>probeKiroCliCompatibility('/never-run',(_b,args)=>args[0]==='--version'?'kiro-cli 3.0.0':fixture('chat-help.txt'));
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});vi.unstubAllEnvs()});
const scratch=()=>{const d=mkdtempSync(join(tmpdir(),'kiro3-'));dirs.push(d);return d};
describe('real3.0 help advertises a retired engine',()=>{
 it.each(['3.0.0','3.1.0','4.0.0'])('Classic on %s refuses despite advertised V1',version=>{
  const c={...compat(),version:`kiro-cli ${version}`};expect(c.supportsLegacyUi).toBe(true);expect(c.agentEngines).toContain('v1');expect(planKiroLaunch('legacy',c).kind).toBe('refuse');
 });
 it('refuses before writing MCP, identity or history',async()=>{
  const d=scratch();vi.stubEnv('AGEND_HOME',d);vi.stubEnv('XDG_DATA_HOME',join(d,'xdg'));const b=new KiroBackend(d,compat());
  writeFileSync(join(d,'old-pin'),'unchanged');const before=readdirSync(d);
  const config={instanceName:'kiro-test',instanceDir:d,workingDirectory:d,kiroUi:'legacy' as const,mcpServers:{audit:{command:'never-run',args:[],env:{}}}};
  await expect(b.prepareLaunch(config)).rejects.toThrow(/Classic/);
  expect(()=>b.writeConfig(config)).toThrow(/Classic/);expect(readdirSync(d)).toEqual(before);expect(readFileSync(join(d,'old-pin'),'utf8')).toBe('unchanged');
  expect(()=>b.buildCommand(config)).toThrow(/Classic/);
 });
 it.each(['classic-120.pane.txt','classic-80.pane.txt','v2-notice.pane.txt'])('%s is held, never answered',name=>{
  const b=new KiroBackend(scratch(),compat()),p=fixture(name);
  for(const table of [b.getStartupDialogs(),b.getRuntimeDialogs()]){
   const hit=table.filter(d=>d.isActive?d.isActive(p):d.pattern.test(p));expect(hit.length).toBeGreaterThan(0);
   expect(hit.every(d=>d.holdOnly&&d.inputBlocked&&d.blocksDelivery&&d.keys.length===0)).toBe(true);
  }
 });
 it('recognises the3.0 missing-login menu before readiness',()=>{expect(LOGIN_FLOWS['kiro-cli'].loginScreenPattern?.test(fixture('login-required.pane.txt'))).toBe(true)});
 it('allows the real saved-V2 explicit TUI control without a retirement hold',()=>{
  const b=new KiroBackend(scratch(),compat()),p=fixture('tui-explicit-saved-v2.pane.txt');
  expect(()=>b.assertLaunchSupported({kiroUi:'tui'} as any)).not.toThrow();
  expect(p).toContain('Kiro CLI V3 is here.');
  expect(p).toContain('No, exit');
  expect(b.getRuntimeDialogs().some(d=>d.interactionKind==='kiro_choice'&&(d.isActive?d.isActive(p):d.pattern.test(p)))).toBe(false);
  expect(b.getStartupDialogs().some(d=>d.isActive?d.isActive(p):d.pattern.test(p))).toBe(true);
 });
 it('keeps explicit TUI/V2 and V3 launch plans',()=>{expect(planKiroLaunch('tui',compat()).kind).toBe('launch');expect(planKiroLaunch('v3',compat()).kind).toBe('launch')});
});

describe('Kiro3 menu hold stays structural and preserves2.x',()=>{
 it.each(['classic-120.pane.txt','v2-notice.pane.txt'])('a quoted %s above a real composer is not a dialog',name=>{
  const p=fixture(name).trimEnd()+'\n› Ask a question\n',b=new KiroBackend(scratch(),compat());
  expect(b.getRuntimeDialogs().some(d=>d.isActive?.(p))).toBe(false);
 });
 it.each(['2.34.0','2.36.0','2.99.0'])('keeps Classic available on %s',version=>{
  const c={...compat(),version:'kiro-cli '+version};expect(planKiroLaunch('legacy',c)).toMatchObject({kind:'launch',flags:['--legacy-ui','--agent-engine=v1']});
 });
 it('retains old and current login successes without accepting generic success prose',()=>{
  const success=LOGIN_FLOWS['kiro-cli'].successPattern;
  for(const text of ['Logged in successfully','Logged in with Google','Logged in with External IdP','Authenticated with API key'])expect(success.test(text)).toBe(true);
  expect(success.test('This operation completed successfully')).toBe(false);
 });
});
