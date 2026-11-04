import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Daemon } from '../src/daemon.js';
import { KiroBackend, probeKiroCliCompatibility } from '../src/backend/kiro.js';
import { KiroCompatibilityError } from '../src/backend/types.js';
import { FleetManager } from '../src/fleet-manager.js';
import { deriveNeedsYou } from '../src/needs-you.js';
import { presentationState } from '../src/interaction-observation.js';
import { InstanceLifecycle } from '../src/instance-lifecycle.js';
import * as factory from '../src/backend/factory.js';
import * as availability from '../src/backend-availability.js';
import { setLocale, t } from '../src/locale.js';
const fixture=(f:string)=>readFileSync(join(import.meta.dirname,'fixtures/kiro-3.0.0-audit',f),'utf8');
const dirs:string[]=[];const scratch=()=>{const d=mkdtempSync(join(tmpdir(),'kiro3-state-'));dirs.push(d);return d};
afterEach(()=>{dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}));vi.unstubAllEnvs();vi.restoreAllMocks();setLocale('en')});
const compat=()=>probeKiroCliCompatibility('/never-run',(_b,a)=>a[0]==='--version'?'kiro-cli 3.0.0':fixture('chat-help.txt'));
const logger:any={child:()=>logger,debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn()};
function fleet(){const f:any=Object.create(FleetManager.prototype);Object.assign(f,{kiroCompatibilityHolds:new Map(),needsYou:{poke:vi.fn()},fleetConfig:{instances:{general:{backend:'kiro-cli'}}},instanceProcessStatus:new Map(),needsCrashedAt:new Map(),needsPauseCache:new Map(),lifecycle:{isPaused:()=>false,daemons:new Map()},instancePresentation:()=>({state:null,interaction:null})});return f;}
function daemon(){const dir=scratch();vi.stubEnv('AGEND_HOME',dir);const b=new KiroBackend(dir,compat());const d:any=new Daemon('general',{backend:'kiro-cli',working_directory:dir,log_level:'silent'} as any,dir,false,b,undefined,logger);return{d,b,dir};}
describe('Kiro3 compatibility hold reaches Needs-you without a pane',()=>{
 it.each(['en','zh-TW'] as const)('real pre-spawn admission leaves pin/history and refuses all IO: %s',locale=>{
  setLocale(locale);const {d,b,dir}=daemon(),f=fleet();writeFileSync(join(dir,'pin'),'retained');
  const forbidden=vi.fn(()=>{throw Error('Forbidden process/configuration work')});
  d.buildBackendConfig=()=>({instanceName:'general',instanceDir:dir,workingDirectory:dir,kiroUi:'legacy',mcpServers:{},instructions:'do not publish'});
  d.prepareWhatsNew=forbidden;d.tmux={createWindow:forbidden,sendSpecialKey:forbidden};
  d.on('kiro_compatibility_hold',(message:string|null)=>f.setKiroCompatibilityHold('general',message));
  return expect(d.trySpawn()).rejects.toBeInstanceOf(KiroCompatibilityError).then(()=>{
   expect(forbidden).not.toHaveBeenCalled();expect(readFileSync(join(dir,'pin'),'utf8')).toBe('retained');
   const items=deriveNeedsYou({prompts:[],instances:f.needsYouInstances(),deliveries:[],ownerOf:()=>undefined});
   expect(items).toHaveLength(1);expect(items[0]).toMatchObject({instance:'general',reason:'dialog',kiroChoice:true,detail:t('kiro3.classic','3.0.0')});
   expect(items[0].detail).toContain(locale==='en'?'saved conversation':'已存的對話');
  });
 });
 it('real lifecycle registers the compatibility observer before the first attempted spawn',async()=>{
  const dir=scratch(),f=fleet();vi.stubEnv('AGEND_HOME',dir);const backend=new KiroBackend(dir,compat());
  vi.spyOn(factory,'createBackend').mockReturnValue(backend);
  vi.spyOn(availability,'resolveBackendBinary').mockResolvedValue('/never-execute');
  const ctx:any={logger,getInstanceDir:()=>dir,setKiroCompatibilityHold:(name:string,message:string|null)=>f.setKiroCompatibilityHold(name,message)};
  const lifecycle=new InstanceLifecycle(ctx);let captured:any;
  vi.spyOn(InstanceLifecycle,'startOrDispose').mockImplementation(async (raw:any)=>{
   captured=raw;raw.buildBackendConfig=()=>({instanceName:'general',instanceDir:dir,workingDirectory:dir,kiroUi:'legacy',mcpServers:{}});
   raw.prepareWhatsNew=()=>{throw Error('Must refuse before preparing startup')};
   await raw.trySpawn(); // No Daemon.start/IPC/process/window: only the real fenced admission path.
  });
  await expect(lifecycle.start('general',{backend:'kiro-cli',working_directory:dir} as any,false)).rejects.toBeInstanceOf(KiroCompatibilityError);
  expect(f.needsYouInstances()[0].kiroCompatibility?.message).toContain('Classic');
  lifecycle.invalidate('general');captured.emit('kiro_compatibility_hold',null);
  expect(f.needsYouInstances()[0].kiroCompatibility?.message).toContain('Classic'); // obsolete owner cannot clear it
  lifecycle.daemons.set('general',captured); // pause/wake can keep the same daemon while advancing its lifecycle epoch
  captured.emit('kiro_compatibility_hold',null);expect(f.needsYouInstances()[0].kiroCompatibility).toBeUndefined();
  captured.emit('kiro_compatibility_hold','current wake refusal');expect(f.needsYouInstances()[0].kiroCompatibility?.message).toBe('current wake refusal');
  lifecycle.daemons.set('general',{} as any);captured.emit('kiro_compatibility_hold',null);expect(f.needsYouInstances()[0].kiroCompatibility?.message).toBe('current wake refusal');
 });
 it('repeated refusal keeps one item and its age; resolution clears it, rather than hiding it on read',()=>{
  const f=fleet();f.setKiroCompatibilityHold('general','reason');const first=f.needsYouInstances();f.setKiroCompatibilityHold('general','reason');
  expect(f.needsYouInstances()).toEqual(first);expect(f.needsYou.poke).toHaveBeenCalledTimes(1);
  expect(deriveNeedsYou({prompts:[],instances:[{name:'general',crashedAt:1,kiroCompatibility:{message:'reason',since:2}}],deliveries:[],ownerOf:()=>undefined})).toHaveLength(1);
  f.setKiroCompatibilityHold('general',null);expect(f.needsYouInstances()[0].kiroCompatibility).toBeUndefined();
 });
 it.each(['classic-120.pane.txt','classic-80.pane.txt','v2-notice.pane.txt'])('real interaction observation of %s produces a held item, never input',name=>{
  const{d,b}=daemon(),p=fixture(name),forbidden=vi.fn(()=>{throw Error('No menu key may be sent')});
  d.tmux={capturePane:async()=>p,sendSpecialKey:forbidden,getWindowId:()=> '@private'};
  d.observeInteractionPane(p,1000,1000,b.getRuntimeDialogs(),1,false);d.observeInteractionPane(p,1600,1600,b.getRuntimeDialogs(),2,false);
  const interaction=d.getInteractionSnapshot();expect(interaction).toMatchObject({phase:'waiting',kind:'kiro_choice'});
  const items=deriveNeedsYou({prompts:[],instances:[{name:'general',state:presentationState('working',interaction)!,interaction,interactionSummary:t('kiro3.running')}],deliveries:[],ownerOf:()=>undefined});
  expect(items).toHaveLength(1);expect(items[0]).toMatchObject({reason:'dialog',kiroChoice:true,detail:t('kiro3.running')});expect(forbidden).not.toHaveBeenCalled();
 });
});
