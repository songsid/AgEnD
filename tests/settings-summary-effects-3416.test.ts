import * as fleetManagerModule from "../src/fleet-manager.js";
import {afterEach,expect,it,vi} from 'vitest';
import {effectSummaryCases} from './helpers/settings-summary-effects-3416.js';
import {getLocale,setLocale} from '../src/locale.js';
const original=getLocale();afterEach(()=>{setLocale(original);vi.unstubAllEnvs();});
it.each(['en','zh-TW'] as const)('alpha held-effect producers carry copied display metadata in %s without replacing raw fallback',locale=>{
 setLocale(locale);
 for(const test of effectSummaryCases()){
  const result=test.read(),diff=result.diff!;
  if(test.name==='membership-false'){expect(diff).toBeNull();continue;}
  expect(diff,test.name).not.toBeNull();
  expect(diff.summary_i18n?.length,test.name).toBe(diff.summary.length);
  for(const [i,descriptor] of diff.summary_i18n!.entries()){
   if(descriptor!==null)expect(descriptor,test.name).toMatchObject({v:1,fallback:diff.summary[i]});
  }
  // Dispatched previews must keep their own descriptors; a generic forced-operation descriptor is stale here.
  expect(JSON.stringify(diff.summary_i18n),test.name).not.toContain('settings_confirm.summary.confirmed');
 }
});
it('pairing keeps exact Hub, binding prefix and fingerprint in both raw and projected lines',()=>{
 const cases=effectSummaryCases();
 const confirm=cases.find(c=>c.name==='pair-confirm')!.read().diff!;
 expect(confirm.summary[1]).toBe('aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa');
 expect(confirm.summary_i18n![1]).toBeNull();
 const disconnect=cases.find(c=>c.name==='pair-disconnect')!.read().diff!;
 expect(disconnect.summary[0]).toContain('https://member.example.test (owned-hub, connection bbbbbbbbbbbb)');
 expect(disconnect.summary_i18n![0]!.parts).toContainEqual({key:'hub.pairing.summary.disconnect',args:['https://member.example.test','owned-hub','bbbbbbbbbbbb']});
});
it('sharing metadata retains the chosen agent and next revision through effect dispatch',()=>{
 const diff=effectSummaryCases().find(c=>c.name==='exposure')!.read().diff!;
 expect(diff.summary).toEqual(['Share "Atlas <text>" with the Hub',"Hub questions go to this agent's own conversation, with its folder and Settings tools",'Revision: 8']);
 expect(diff.summary_i18n![0]!.parts).toContainEqual({key:'hub.exposure.summary.share',args:['Atlas <text>']});
 expect(diff.summary_i18n![2]!.parts).toContainEqual({key:'hub.exposure.summary.revision',args:[8]});
});

it.each(["host","windows"])("General's %s preview retains display descriptors through effect dispatch",async location=>{
 const {FleetManager}=fleetManagerModule,{generalBindingRevision}=await import("../src/general-binding.js"),{prepareSettingsEffect}=await import("../src/settings-effect.js");
 vi.stubEnv("AGEND_REMOTE_RUNTIME","1");
 const cfg={general_topic:true},record={active:"host",windows:[]};
 const fm:any=Object.create(FleetManager.prototype);fm.fleetConfig={instances:{general:cfg},defaults:{}};fm.generalBindings=()=>({read:()=>record});
 fm.runtimeHub={machine:()=>({id:"11111111-1111-4111-8111-111111111111",name:"Owned Windows",status:"online",inventory:{clis:[{id:"codex",runnable:true}]}}),paneTransportEpoch:()=>"current"};
 const input={name:"general",revision:generalBindingRevision(record as any,cfg as any),target:location==="host"?{location}:{location,machineId:"11111111-1111-4111-8111-111111111111",cli:"codex",model:""}};
 const preview=fm.previewGeneralLocation(input);expect(preview.summary_i18n?.[0]).toMatchObject({v:1,fallback:preview.summary[0],parts:[{key:"general_location.confirm_"+location}]});
 const diff=prepareSettingsEffect("POST","/api/settings/general-location",input,{config:fm.fleetConfig,classic:{},generalLocation:i=>fm.previewGeneralLocation(i)}).diff!;
 expect(diff.summary).toEqual(preview.summary);expect(diff.summary_i18n).toEqual(preview.summary_i18n);
 expect(diff.authority).toEqual({connections:[],primaryGeneral:true,unknown:false});
});
