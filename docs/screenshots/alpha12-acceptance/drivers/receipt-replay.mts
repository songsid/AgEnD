// Owned acceptance derivative: only scratch prefix changed to satisfy unchanged process guard.
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join}from 'node:path';
const repo=process.env.REPO!,out=process.env.OUT!;
const {Daemon}=await import(repo+'/src/daemon.ts');const {CodexBackend}=await import(repo+'/src/backend/codex.ts');const {TmuxControlClient}=await import(repo+'/src/tmux-control.ts');
const root=mkdtempSync(join(tmpdir(),'agend-replay-3578-'));const sock=join(root,'s');const T=(...a:string[])=>execFileSync('/usr/bin/tmux',['-f','/dev/null','-S',sock,...a],{encoding:'utf8'});
const fixture=join(repo,'tests/fixtures/codex-receipt-3578');const trace:any[]=[];let start=performance.now();
try{
 writeFileSync(join(root,'render.py'),`from pathlib import Path\nimport sys,time\nr=Path(sys.argv[1]);f=Path(sys.argv[2])\ndef paint(n):\n sys.stdout.write('\\033[H\\033[2J'+(f/n).read_text());sys.stdout.flush()\npaint('enter-retained.pane.txt')\n(r/'ready').touch()\nwhile not(r/'go').exists():time.sleep(.005)\ntime.sleep(.25)\npaint('submitted-busy.pane.txt')\n(r/'busy').touch()\ntime.sleep(45)\n`);
 T('new-session','-d','-s','owned','-x','150','-y','42','python3',join(root,'render.py'),root,fixture);
 const {existsSync}=await import('node:fs');while(!existsSync(join(root,'ready')))await new Promise(r=>setTimeout(r,10));
 const log:any={debug(){},info(){},warn(){},error(){},child(){return this}};
 const d:any=new Daemon('replay',{working_directory:root,backend:'codex',log_level:'silent',restart_policy:{max_retries:0,backoff:'linear',reset_after:0},context_guardian:{grace_period_ms:600000,max_age_hours:0}},root,false,new CodexBackend(root),undefined,log);
 let captures=0,enters=0;
 d.tmux={getWindowId:()=> '@owned',capturePane:async()=>{const p=T('capture-pane','-p','-t','owned');captures++;if(captures===1)writeFileSync(join(root,'go'),'');return p;}};
 const control:any={stopped:false,isIdle:()=>false,logger:log};control.waitUntilIdle=(...a:any[])=>(TmuxControlClient.prototype.waitUntilIdle as any).apply(control,a);d.controlClient=control;
 d.sendDeliveryEnter=async()=>{enters++;return false};
 const signature={value:'agend-human-id:hmsg-00000000-0000-4000-8000-000000003578',unique:true};const baseline=d.paneEvidence(readFileSync(join(fixture,'idle.pane.txt'),'utf8'),signature);
 const actualJudge=d.judgeSubmission.bind(d);d.judgeSubmission=(...a:any[])=>{const v=actualJudge(...a);trace.push({atMs:Math.round(performance.now()-start),verdict:v});return v};
 start=performance.now();const immediate=await d.confirmAfterEnter('@owned',Date.now(),signature,baseline,'replay-no-retry');const late=immediate?null:await d.lateCodexSubmissionProof(signature,baseline,false);
 const elapsedMs=Math.round(performance.now()-start);const result={source:execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),mode:process.env.MODE,scope:'offline recorded-stream replay in private tmux; real production judge/readiness timers; no CLI/model/network',trace,elapsedMs,confirmation:immediate,lateProof:late,captures,recoveryEnters:enters};
 writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 if(process.env.MODE==='before'&&!(elapsedMs>=29000&&!immediate&&late==='submitted'&&enters===0))throw Error('baseline mechanism not reproduced');
 if(process.env.MODE==='after'&&!(elapsedMs<2500&&immediate&&enters===0))throw Error('prompt confirmation failed');
}finally{try{T('kill-server')}catch{}rmSync(root,{recursive:true,force:true});}
