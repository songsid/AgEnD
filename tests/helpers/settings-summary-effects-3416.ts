/** Pure held-effect cases: no native runtime, files, process or credential work. */
import {createPrivateKey,createPublicKey} from 'node:crypto';
import {signCompanyDescriptor} from '../../src/hub/join/descriptor.js';
import { prepareSettingsEffect } from '../../src/settings-effect.js';
import { pairingSummary } from '../../src/hub-pairing-summary.js';
import { createHubMemberExposureApi } from '../../src/hub/member/exposure-api.js';
export const effectSummaryMessages: Array<[string, Array<string | number>]> = [
 ['host_cli.install_confirm',['codex']], ['host_cli.update',['codex','1.2.3']], ['host_cli.update_latest',['antigravity']],
 ['runtime_cli.install',['codex','1.2.3','aabbccdd']], ['runtime_cli.update_latest',['antigravity','aabbccdd']],
 ['hub.browserCertificate.replace',[]], ['hub.browserCertificate.fingerprint',['AA:BB:CC:DD']], ['hub.browserCertificate.expires',['2030-01-02']], ['hub.browserCertificate.selfSigned',[]],
 ['hub.retention.content',[30]], ['hub.retention.events',[90]], ['hub.retention.purge',[]], ['hub.run.start',[]], ['hub.run.stop',[]],
 ['hub.preview.on',['18443']], ['hub.preview.off',[]], ['hub.membership.enable',[]], ['hub.membership.disable',[]],
 ['hub.companyJoin.confirm',['https://hub.example.test']], ['hub.companyJoin.repair',['https://next.example.test']],
 ['general_location.confirm_host',[]], ['general_location.confirm_windows',['Owned Windows']], ['general_location.history',[]],
];
export function effectSummaryCases(producers = {prepareSettingsEffect,pairingSummary,createHubMemberExposureApi}) {
 const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,7)]),format:'der',type:'pkcs8'});
 const identity={hubId:'11111111-1111-4111-8111-111111111111',webOrigin:'https://hub.example.test',memberOrigin:'https://member.example.test',spkiSha256:'a'.repeat(64),issuerPublicKey:createPublicKey(key).export({format:'pem',type:'spki'}).toString()};
 const repairLink=identity.webOrigin+'/join-info#hub='+Buffer.from(JSON.stringify(signCompanyDescriptor(identity,key))).toString('base64url');
 const config:any={defaults:{},instances:{}}, context={config,classic:{}};
 const effect=(method:string,path:string,body:unknown,extra:Record<string,unknown>={})=>producers.prepareSettingsEffect(method,path,body,{...context,...extra},'owned-session');
 const exposure=producers.createHubMemberExposureApi({store:{} as any,agents:()=>[{name:'atlas',display:'Atlas <text>'}],afterCommit:async()=>{throw Error('display only')}});
 const bound={hubId:'owned-hub',binding:'b'.repeat(64)}, fingerprint={digest:'a'.repeat(64)};
 return [
  {name:'host-install',read:()=>effect('POST','/ui/host-install',{backend:'codex'})},
  {name:'host-update',read:()=>effect('POST','/ui/host-update',{backend:'codex'})},
  {name:'runtime-install',read:()=>effect('POST','/ui/runtimes/machines/11111111-1111-4111-8111-111111111111/cli-install',{cli:'codex'})},
  {name:'certificate',read:()=>effect('POST','/api/settings/hub/browser-certificate/apply',{reference:'11111111-1111-4111-8111-111111111111',revision:'a'.repeat(64)},{hubBrowserCertificate:()=>({certificate:{fingerprint256:'AA:BB:CC:DD',validTo:'2030-01-02',selfSigned:true}})})},
  {name:'retention',read:()=>effect('PUT','/api/settings/hub/retention',{contentDays:30,eventDays:90,revision:1})},
  ...[true,false].flatMap(enabled=>[
   {name:'run-'+enabled,read:()=>effect('PUT','/api/settings/hub/run',{enabled})},
   {name:'preview-'+enabled,read:()=>effect('PUT','/api/settings/hub/preview',{enabled,...(enabled?{port:18443}:{})})},
   {name:'membership-'+enabled,read:()=>effect('PUT','/api/settings/hub/membership',{enabled},{hubMembership:()=>({enabled:!enabled})})},
  ]),
  {name:'company-start',read:()=>effect('POST','/api/hub/member/company-join/start',{address:'https://hub.example.test',label:'Owned Fleet'})},
  {name:'company-resume',read:()=>effect('POST','/api/hub/member/company-join/resume',{operationId:'11111111-1111-4111-8111-111111111111'})},
  {name:'company-repair',read:()=>effect('POST','/api/hub/member/company-join/repair-trust',{address:repairLink})},
  {name:'exposure',read:()=>effect('POST','/api/hub/member/exposures',{agent:'atlas',dataViewId:'agent',tools:[],expectedRevision:7},{hubExposure:(input:unknown)=>exposure.preview(input)})},
  {name:'pair-connect',read:()=>effect('POST','/api/hub/member/pairing/connect',{address:'https://hub.example.test'},{hubPairing:(action:any,input:unknown)=>producers.pairingSummary(action,input,{state:'unpaired'} as any)})},
  {name:'pair-confirm',read:()=>effect('POST','/api/hub/member/pairing/confirm',{digest:fingerprint.digest},{hubPairing:(action:any,input:unknown)=>producers.pairingSummary(action,input,{state:'pending',memberOrigin:'https://member.example.test',fingerprint} as any)})},
  {name:'pair-disconnect',read:()=>effect('POST','/api/hub/member/pairing/disconnect',bound,{hubPairing:(action:any,input:unknown)=>producers.pairingSummary(action,input,{state:'paired',hub:{memberOrigin:'https://member.example.test'}} as any,bound)})},
 ];
}
