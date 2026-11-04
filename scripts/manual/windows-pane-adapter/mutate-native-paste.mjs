/** Semantic checks for exact positive-ACK paste retry; own worktree only, no CLI/account calls. */
import{readFileSync,writeFileSync,mkdirSync}from'node:fs';import{spawnSync}from'node:child_process';
mkdirSync('.artifacts',{recursive:true});const file='src/daemon.ts',original=readFileSync(file,'utf8'),start=original.indexOf('  private async sendDeliveryPaste('),end=original.indexOf('  private async writeMessageToPane(',start),helper=original.slice(start,end);
if(start<0||end<0)throw Error('Missing native paste helper');writeFileSync('.artifacts/native-paste-mutation-original.txt',original);
const cases=[
 ['unknown-ack',[["pane.lastInputWasNotSent?.() !== true || ",""]],'a unknown ACK'],
 ['nonzero-ack',[[" || pane.getLastPasteError?.() !== \"Pane changed after observation; input was not sent\"",""]],'a nonzero ACK'],
 ['count-bound',[["attempt < 5","attempt < 50"],["attempt >= 4","attempt >= 49"]],'five-attempt bound'],
 ['deadline',[["performance.now() + 2000","Infinity"]],'after two seconds'],
 ['after-success',[["if (sent) return true;","if (false) return true;"]],'exactly one successful paste'],
 ['dialog',[["backend?.getRuntimeDialogs?.().some(dialog => Daemon.dialogMatches(dialog, screen!))","false"]],'recognised dialog arriving'],
 ['owner',[["this.launchFenceEpoch === fence && ",""]],'changed fence owner'],
 ['uncertain',[["verdict.paneWriteStarted = true; verdict.phase = \"paste\"","verdict.phase = \"paste\""]],'actual write path'],
];const results=[];
try{for(const[name,edits,pattern]of cases){let source=name==='uncertain'?original:helper;for(const[from,to]of edits){if(!source.includes(from))throw Error('Missing mutant '+name);source=source.replace(from,to);}writeFileSync(file,name==='uncertain'?source:original.slice(0,start)+source+original.slice(end));
const r=spawnSync('npx',['vitest','run','tests/native-paste-retry-3000.test.ts','--maxWorkers=1','-t',pattern],{encoding:'utf8',timeout:25000}),out=(r.stdout??'')+(r.stderr??'');writeFileSync('.artifacts/mutation-native-paste-'+name+'.log',out);const caught=r.status!==0&&/AssertionError|expected| FAIL /.test(out)&&!/Transform failed|No test files found/.test(out);results.push({name,caught,status:r.status});writeFileSync(file,original);if(!caught)throw Error('Uncaught '+name);}}
finally{writeFileSync(file,original);writeFileSync('.artifacts/native-paste-mutations.json',JSON.stringify(results,null,2));}console.log(JSON.stringify(results));
