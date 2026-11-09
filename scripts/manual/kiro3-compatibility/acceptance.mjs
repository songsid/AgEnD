/** Core pre-launch replay against a real offline3.0 binary. All pane/lifecycle IO is forbidden. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const out=process.env.PROOF_ROOT;assert(out&&process.env.KIRO_BINARY&&process.env.AGEND_HOME===join(out,'agend')&&process.env.HOME===join(out,'home'));
assert.equal(typeof process.getuid==='function'?process.getuid():0,1000,'Use the documented unprivileged isolated container');
const load=name=>import(pathToFileURL(resolve('dist',name+'.js')).href);
const [{KiroBackend,probeKiroCliCompatibility,planKiroLaunch,kiro3ChoiceActive},{Daemon},{FleetManager},{deriveNeedsYou},{presentationState},{KiroCompatibilityError},{setLocale,t}]=await Promise.all(['backend/kiro','daemon','fleet-manager','needs-you','interaction-observation','backend/types','locale'].map(load));
const binary=process.env.KIRO_BINARY,c=probeKiroCliCompatibility(binary);assert.match(c.version,/3\.0\.0/);assert(c.supportsLegacyUi&&c.agentEngines.includes('v1'));
await writeFile(join(out,'chat-help.txt'),execFileSync(binary,['chat','--help'],{encoding:'utf8',env:{...process.env,KIRO_NO_AUTO_UPDATE:'1'}}));
const logger={child:()=>logger,debug:()=>{},info:()=>{},warn:()=>{},error:()=>{}},dir=join(process.env.AGEND_HOME,'instances','proof');await mkdir(dir,{recursive:true});
const pin=join(dir,'pin'),history=join(dir,'history');await writeFile(pin,'retained-session-id');await writeFile(history,'retained-conversation-bytes');
const f=Object.create(FleetManager.prototype);Object.assign(f,{kiroCompatibilityHolds:new Map(),needsYou:{poke(){}},fleetConfig:{instances:{general:{backend:'kiro-cli'}}},instanceProcessStatus:new Map(),needsCrashedAt:new Map(),needsPauseCache:new Map(),lifecycle:{isPaused:()=>false,daemons:new Map()},instancePresentation:()=>({state:null,interaction:null})});
let forbiddenCalls=0;const forbidden=()=>{forbiddenCalls++;throw Error('Forbidden launch/pane write');};const config={instanceName:'general',instanceDir:dir,workingDirectory:join(out,'work'),kiroUi:'legacy',mcpServers:{},instructions:'never publish'};
for(const locale of ['en','zh-TW']){
 setLocale(locale);const b=new KiroBackend(dir,c),d=new Daemon('general',{backend:'kiro-cli',working_directory:config.workingDirectory,log_level:'silent'},dir,false,b,undefined,logger);
 d.buildBackendConfig=()=>config;d.prepareWhatsNew=forbidden;d.tmux={createWindow:forbidden,sendSpecialKey:forbidden};d.on('kiro_compatibility_hold',message=>f.setKiroCompatibilityHold('general',message));
 await assert.rejects(d.trySpawn(),KiroCompatibilityError);await assert.rejects(b.prepareLaunch(config),KiroCompatibilityError);assert.throws(()=>b.writeConfig(config),KiroCompatibilityError);assert.throws(()=>b.buildCommand(config),KiroCompatibilityError);
 const needs=deriveNeedsYou({prompts:[],instances:f.needsYouInstances(),deliveries:[],ownerOf:()=>undefined});assert.equal(needs.length,1);assert.equal(needs[0].kiroChoice,true);assert.equal(needs[0].detail,t('kiro3.classic','3.0.0'));await writeFile(join(out,'needs-'+locale+'.json'),JSON.stringify(needs,null,2));
}
assert.equal(await readFile(pin,'utf8'),'retained-session-id');assert.equal(await readFile(history,'utf8'),'retained-conversation-bytes');assert.equal(forbiddenCalls,0);
const menuResults=[];setLocale('en');for(const name of ['classic-120','classic-80','v2-notice']){
 const pane=await readFile(join(out,name+'.pane.txt'),'utf8'),b=new KiroBackend(dir,c),d=new Daemon('general',{backend:'kiro-cli',working_directory:config.workingDirectory,log_level:'silent'},dir,false,b,undefined,logger);
 d.tmux={capturePane:async()=>pane,sendSpecialKey:forbidden,getWindowId:()=> '@private'};assert(kiro3ChoiceActive(pane));await d.dismissDialogsUntilReady(40,5);
 d.observeInteractionPane(pane,1000,1000,b.getRuntimeDialogs(),1,false);d.observeInteractionPane(pane,1600,1600,b.getRuntimeDialogs(),2,false);const interaction=d.getInteractionSnapshot();assert.equal(interaction.kind,'kiro_choice');
 const needs=deriveNeedsYou({prompts:[],instances:[{name:'general',state:presentationState('working',interaction),interaction,interactionSummary:t('kiro3.running')}],deliveries:[],ownerOf:()=>undefined});assert.equal(needs.length,1);assert(needs[0].kiroChoice);menuResults.push({name,waiting:interaction.phase==='waiting',needsYou:true});
}
assert.equal(forbiddenCalls,0);assert.equal(planKiroLaunch('tui',c).kind,'launch');assert(!kiro3ChoiceActive(await readFile(join(out,'tui-explicit-saved-v2.pane.txt'),'utf8')));
await writeFile(join(out,'acceptance-receipt.json'),JSON.stringify({sourceHead:process.env.PROOF_SOURCE_HEAD,realBinary:c.version,helpAdvertisesRetiredV1:true,prelaunchRefusal:true,forbiddenCalls,pinAndHistoryUnchanged:true,needsYouLocales:['en','zh-TW'],menuResults,explicitTuiAllowed:true,noRealAccount:true,fullFleetStarted:false,passed:true},null,2));
