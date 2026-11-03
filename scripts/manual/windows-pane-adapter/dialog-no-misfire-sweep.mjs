/** Read-only fixture sweep from Fable's #2990 review, applied to ordinary and native backends. */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root=process.cwd(),compiled=resolve(process.argv[2]||'dist');
const load=file=>import(pathToFileURL(join(compiled,file)).href);
const {createNativePaneBackend}=await load('backend/native-pane.js');
const specs=[['claude','claude-code.js','ClaudeCodeBackend','claude-code'],['codex','codex.js','CodexBackend','codex']];
const files=readdirSync(join(root,'tests/fixtures')).filter(file=>file.endsWith('.txt'));
const results=[];
for(const[prefix,file,className,provider]of specs){
 const module=await load('backend/'+file),ordinary=new module[className]('/tmp/agend-no-account-fixture-sweep');
 const native=createNativePaneBackend(provider,()=>({sessionId:null,contextPercentage:null,statusLineItems:['context-remaining'],resumes:false,cwd:'C:\\scratch'}));
 for(const[kind,backend]of[['ordinary',ordinary],['native',native]]){
  const dialogs=backend.getRuntimeDialogs?.()??[];let ready=0;const misfires=[],deliveryMisfires=[],inventory=[];
  for(const file of files.filter(file=>file.startsWith(prefix))){
   const text=readFileSync(join(root,'tests/fixtures',file),'utf8');let composer=false;
   try{composer=backend.readInputRow?backend.readInputRow(text)!=null:backend.isDeliveryInputReadyPane?backend.isDeliveryInputReadyPane(text):backend.inputDraft?backend.inputDraft(text)!=null:false;}catch{}
   if(!composer)continue;ready++;inventory.push(file);
   const hit=dialogs.find(dialog=>{dialog.pattern.lastIndex=0;return kind==='native'?dialog.pattern.test(text)&&(!dialog.isActive||dialog.isActive(text)):dialog.isActive?dialog.isActive(text):dialog.pattern.test(text);});
   if(hit)misfires.push({file,dialog:hit.description});
   if(kind==='native'){
    const deliveryHit=dialogs.find(dialog=>{dialog.pattern.lastIndex=0;return dialog.isActive?dialog.isActive(text):dialog.pattern.test(text);});
    if(deliveryHit)deliveryMisfires.push({file,dialog:deliveryHit.description});
   }
  }
  results.push({provider,kind,ready,misfires,deliveryMisfires,inventory});assert.equal(misfires.length,0,provider+' '+kind+' ordinary composer must not be vetoed');assert.equal(deliveryMisfires.length,0,'native delivery ordinary composer must not be vetoed');
 }
}
console.log(JSON.stringify({passed:true,results},null,2));
