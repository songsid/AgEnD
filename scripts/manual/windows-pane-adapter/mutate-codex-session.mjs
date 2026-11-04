/** Offline semantic mutations. Run only in an own worktree; restores source and saves a recovery copy before editing. No CLI/account. */
import{mkdirSync,readFileSync,writeFileSync}from'node:fs';
mkdirSync('.artifacts',{recursive:true});import{spawnSync}from'node:child_process';
const proof='src/runtime-pane-transcript.ts',manager='src/native-pane-manager.ts',store='src/windows-agents.ts',db='src/runtime-pane-codex-index.ts';
const daemon='src/daemon.ts',lifecycle='src/instance-lifecycle.ts',ui='src/ui/native-pane-recovery.js';
const cases=[
 ['fresh-no-launch-release',manager,'if(!snapshot.noLaunch&&next.launch.cli===','if(next.launch.cli===','tests/native-pane-unwritten-codex-3000.test.ts','refused fresh open'],
 ['ignore-archive',proof,'await walk(join(roots.codex,"archived_sessions"),0,true);','', 'tests/runtime-pane-codex-session-proof.test.ts','archive cannot'],
 ['no-scan-bound',proof,'entries>16384','entries>65536','tests/runtime-pane-codex-session-proof.test.ts','partial walk'],
 ['no-final-proof-recheck',proof,'return await unchanged()?"absent":"unknown";','return "absent";','tests/runtime-pane-codex-session-proof.test.ts','WAL created after'],
 ['ignore-stale-index',proof,'||entry.id.toLowerCase()===sessionId','', 'tests/runtime-pane-codex-session-proof.test.ts','stale/unsafe index'],
 ['ignore-db',proof,'if(!await codexIndexHasNoThread(dbPath,sessionId,live))return "unknown";','', 'tests/runtime-pane-codex-session-proof.test.ts','stale/unsafe row'],
 ['ignore-wal',proof,'if(wal.size)return "unknown";','', 'tests/runtime-pane-codex-session-proof.test.ts','stale/unsafe wal'],
 ['trust-filename-only',proof,'if(matches.length===1){','if(matches.length===1){return "saved";', 'tests/runtime-pane-codex-session-proof.test.ts','wrong-cwd cannot'],
 ['automatic-chain',manager,'state==="absent"&&!manifest.fresh','state==="absent"','tests/native-pane-unwritten-codex-3000.test.ts','positive absence commits'],
 ['pin-before-receipt',manager,'this.save(file,next);\n  this.options.store.pinFreshCodexSession','\n  this.options.store.pinFreshCodexSession','tests/native-pane-unwritten-codex-3000.test.ts','receipt-before-profile'],
 ['wrong-observed-launch',store,'||agent.activeId!==observed.launchId||agent.paneLaunchId!==observed.launchId','', 'tests/native-pane-unwritten-codex-3000.test.ts','fresh binding and pre-UUID'],
 ['unknown-is-absent',manager,'if(runtimeJobDigest(proof.snapshot)===runtimeJobDigest(previous))return proof.state;','if(runtimeJobDigest(proof.snapshot)===runtimeJobDigest(previous))return proof.state==="unknown"?"absent":proof.state;','tests/native-pane-unwritten-codex-3000.test.ts','unknown Codex proof'],
 ['admin-no-reproof',manager,'if(state==="saved"){','if(false){','tests/native-pane-unwritten-codex-3000.test.ts','admin re-proves'],
 ['release-foreign-launch',store,'||agent.activeId!==exit.launchId||agent.paneLaunchId!==exit.launchId','', 'tests/native-pane-unwritten-codex-3000.test.ts','fresh binding and pre-UUID'],
 ['ignore-sqlite-row',db,"row===undefined?'clear':'unknown'","'clear'",'tests/runtime-pane-codex-session-proof.test.ts','stale/unsafe row'],
 ['no-schema-guard',db,"if(schema.length>128||!schema.some(c=>c.name==='id'&&c.type.toUpperCase()==='TEXT'&&c.pk===1))throw Error('Unknown schema');",'', 'tests/runtime-pane-codex-session-proof.test.ts','stale/unsafe no-pk'],
 ['partial-is-saved',proof,'proof.state==="ready"&&proof.complete&&await unchanged()','proof.state==="ready"&&await unchanged()','tests/runtime-pane-codex-session-proof.test.ts','partial cannot'],
 ['ignore-binary-id',db,"typeof(id) <> 'text' OR ",'','tests/runtime-pane-codex-session-proof.test.ts','binary ID hidden'],
 ['ignore-id-case',db,' COLLATE NOCASE','','tests/runtime-pane-codex-session-proof.test.ts','case-ambiguous'],
 ['slot-daemon-needs-pin',daemon,'snapshot.state==="exited"\n','snapshot.state==="exited" && !!snapshot.sessionId\n','tests/native-pane-instance-lifecycle-2950.test.ts','a no-pin exited'],
 ['slot-lifecycle-needs-pin',lifecycle,'||pin!==undefined&&profilePin!==undefined&&profilePin!==pin||','||!pin||pin!==undefined&&profilePin!==undefined&&profilePin!==pin||','tests/native-pane-instance-lifecycle-2950.test.ts','a no-pin exited'],
 ['slot-prepare-skips-release',manager,'manifest=this.recordExit(file,manifest,manifest.exited);agent=this.options.store.get(id);','agent=this.options.store.get(id);','tests/native-pane-unwritten-codex-3000.test.ts','a positive first exit'],
 ['slot-unknown-exit-admitted',daemon,'actual.state==="exited" && snapshot.state==="exited"','true','tests/native-pane-instance-lifecycle-2950.test.ts','a no-pin unknown'],
 ['slot-null-target-disabled',ui,'busy || !recovery.launchId','busy || !recovery.launchId || !recovery.sessionId','tests/native-pane-session-ui-2984.test.ts','a positive no-UUID'],
];const originals=new Map([proof,manager,store,db,daemon,lifecycle,ui].map(f=>[f,readFileSync(f,'utf8')])),results=[];
writeFileSync('.artifacts/codex-mutation-originals.json',JSON.stringify(Object.fromEntries(originals)));
try{for(const[name,file,from,to,test,pattern]of cases.filter(row=>(!process.argv.includes("--slot-only")||row[0].startsWith("slot-"))&&(!process.argv.includes("--refusal-only")||row[0]==="fresh-no-launch-release"))){const src=originals.get(file);if(!src.includes(from))throw Error('Missing mutation '+name);writeFileSync(file,name==='no-scan-bound'?src.replaceAll(from,to):src.replace(from,to));const r=spawnSync('npx',['vitest','run',test,'--maxWorkers=1','-t',pattern],{encoding:'utf8',timeout:25000});const out=(r.stdout??'')+(r.stderr??'');writeFileSync('.artifacts/mutation-codex-'+name+'.log',out);const caught=r.status!==0&&/AssertionError|expected| FAIL /.test(out)&&!/Transform failed/.test(out);results.push({name,caught,status:r.status});writeFileSync(file,src);if(!caught)throw Error('Uncaught '+name);}}
finally{for(const[f,s]of originals)writeFileSync(f,s);writeFileSync(process.argv.includes('--refusal-only')?'.artifacts/codex-refusal-mutations.json':process.argv.includes('--slot-only')?'.artifacts/codex-slot-mutations.json':'.artifacts/codex-session-mutations.json',JSON.stringify(results,null,2));}console.log(JSON.stringify(results));
