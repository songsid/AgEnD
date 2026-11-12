/** Supervisor. Even importing this entry requires an owned container AND a later explicit-GO plan. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, chmodSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { requireWindow, phases } from './guard.mjs';
if (process.env.SAFE_RUN !== '1' || process.env.AGEND_OWNED_CONTAINER !== 'hub-enrolment-code-campaign' || !existsSync('/.dockerenv')) throw Error('Owned campaign container required');
const source = process.env.CAMPAIGN_SHA!, plan = JSON.parse(readFileSync('/control/plan.json', 'utf8'));
requireWindow(plan, source, Date.now(), existsSync('/control/STOP'));
const receipt: any = { source, goReference: plan.goReference, window: { from: plan.from, until: plan.until }, sourceVersionStamp: plan.version, startedAt: Date.now(), phases: [], samples: [], ready: false,
  boundary: 'Source build, owned network-none container, synthetic verified LDAPS; five real Fleet web/settings/join/member services per mass wave with Agent lifecycle refused. Not npm/systemd or real accounts/AD/pilot/native Windows.' };
mkdirSync('/tmp/home', { mode: 0o700, recursive: true }); mkdirSync('/tmp/bin'); mkdirSync('/evidence', { recursive: true });
for (const name of ['tmux','agend','claude','codex','kiro-cli','opencode']) {
  const path = '/tmp/bin/' + name; writeFileSync(path, '#!' + process.execPath + '\nprocess.exit(97)\n'); chmodSync(path, 0o755);
}
process.env.PATH = '/tmp/bin:' + dirname(process.execPath) + ':/usr/bin:/bin'; process.env.AGEND_TMUX_BIN = '/tmp/bin/tmux';
for (const name of ['.claude', '.codex', 'tmux']) mkdirSync('/tmp/home/' + name, { mode: 0o700 });
Object.assign(process.env, { CLAUDE_CONFIG_DIR: '/tmp/home/.claude', CODEX_HOME: '/tmp/home/.codex', TMUX_TMPDIR: '/tmp/home/tmux' });
let child: ReturnType<typeof spawn> | null = null, stopping = false;
const stop = (why: string) => {
  if (stopping) return; stopping = true; receipt.stopped = why;
  if (child?.pid) {
    const owned=child;try { process.kill(-owned.pid!, 'SIGTERM'); } catch {}
    const kill=setTimeout(()=>{if(child===owned&&owned.pid){try{process.kill(-owned.pid,'SIGKILL');}catch{}}},10_000);kill.unref();
  }
};
const sample = () => {
  const get = (path: string) => { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } };
  receipt.samples.push({ at: Date.now(), phase: receipt.phases.at(-1)?.name ?? 'prepare', childPid: child?.pid ?? null,
    childStatus: child?.pid ? get('/proc/' + child.pid + '/status')?.split('\n').filter(s => /^(?:VmRSS|VmHWM|Threads):/.test(s)) : null,
    containerMemoryBytes: get('/sys/fs/cgroup/memory.current'), containerPeakBytes: get('/sys/fs/cgroup/memory.peak'), memoryEvents: get('/sys/fs/cgroup/memory.events') });
};
const watch = setInterval(() => { sample(); try { requireWindow(plan, source, Date.now(), existsSync('/control/STOP')); } catch (e) { stop(String(e)); } }, 1000);
process.on('SIGTERM', () => stop('supervisor SIGTERM')); process.on('SIGINT', () => stop('supervisor SIGINT'));
async function run(name: string, command: string, args: string[], env = {}, maximumMs = 0) {
  requireWindow(plan, source, Date.now(), existsSync('/control/STOP')); if (stopping) throw Error('Campaign stopped');
  const phase: any = { name, startedAt: Date.now() }; receipt.phases.push(phase);
  const log = await import('node:fs').then(fs => fs.openSync('/evidence/' + name + '.log', 'wx', 0o600));
  const budget=maximumMs?setTimeout(()=>stop(name+' fixed budget exceeded'),maximumMs):null;
  try {
    const code = await new Promise<number | null>((done, reject) => {
      child = spawn(command, args, { cwd: '/work', env: { ...process.env, ...env }, detached: true, stdio: ['ignore', log, log] });
      child.once('error', reject); child.once('close', code => { child = null; done(code); });
    });
    phase.finishedAt = Date.now(); phase.exitCode = code; sample();
    if (code !== 0 || stopping) throw Error(name + ' did not complete successfully');
  } finally { if(budget)clearTimeout(budget);(await import('node:fs')).closeSync(log); }
}
try {
  symlinkSync('/work/node_modules', '/tmp/node_modules'); symlinkSync('/work/launcher', '/tmp/launcher');
  const pkg = JSON.parse(readFileSync('/work/package.json', 'utf8')); pkg.version = plan.version;
  writeFileSync('/tmp/package.json', JSON.stringify(pkg));
  await run('build', process.execPath, ['node_modules/@typescript/native/bin/tsc', '--outDir', '/tmp/b1-dist', '--declaration', 'false', '--sourceMap', 'false']);
  cpSync('/work/src/ui', '/tmp/b1-dist/ui', { recursive: true });
  cpSync('/work/src/plugin', '/tmp/b1-dist/plugin', { recursive: true });
  writeFileSync('/tmp/b1-dist/build-provenance.json', JSON.stringify({ format: 1, commit: source, ref: 'feat/hub-enrolment-code-ui-b2', channel: 'source', modified: false, from: 'archive' }));
  receipt.chineseFont = execFileSync('fc-match', [':lang=zh-tw', '-f', '%{family} %{lang}'], { encoding: 'utf8' }).trim();
  if (!/zh-(?:tw|cn)|WenQuanYi|CJK/i.test(receipt.chineseFont)) throw Error('Owned image lacks a CJK font; refuse tofu screenshots');
  await run(phases[0], '/work/node_modules/.bin/vitest', ['run',
    'tests/hub-enrolment-code-store-b1.test.ts','tests/hub-enrolment-code-http-b1.test.ts','tests/hub-enrolment-code-permit-b1.test.ts',
    'tests/hub-enrolment-code-audit-b1.test.ts','tests/hub-enrolment-code-upgrade-b1.test.ts','tests/hub-pairing-api-s3c.test.ts',
    'tests/hub-enrolment-code-slot-b2.test.ts','tests/hub-pairing-notices.test.ts','tests/hub-pairing-inbox.test.ts','--maxWorkers=1','--cache=false','--configLoader','runner'], { VITEST_CACHE_DIR: '/tmp/vitest-cache' });
  if(plan.mode==='diagnose-3713') {
    await run('member-fixture-preflight',process.execPath,['--import','tsx','scripts/manual/hub-enrolment-code-campaign/capacity.mts'],{CAMPAIGN_MODE:'preflight'},120_000);
    const diagnosisDeadline=Date.now()+30*60_000;
    try { await run('diagnose-3713',process.execPath,['--import','tsx','scripts/manual/hub-enrolment-code-campaign/capacity.mts'],{CAMPAIGN_MODE:'diagnose'},30*60_000); }
    catch(e){
      if(stopping)throw e;
      const file='/evidence/receipt-diagnosis.json';
      if(!existsSync(file)||JSON.parse(readFileSync(file,'utf8')).cleaned!==true)throw e;
      receipt.diagnosticError=String(e); // Retain failure; remaining legs do not convert it to a pass.
    }
    const reviewed='/control/DIAGNOSIS_REVIEWED';
    while(!existsSync(reviewed)){
      requireWindow(plan,source,Date.now(),existsSync('/control/STOP'));
      if(stopping||Date.now()>=diagnosisDeadline)throw Error('Fixed diagnostic review budget exceeded');
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    const reviewText=readFileSync(reviewed,'utf8');if(reviewText.length>4096)throw Error('Diagnostic review marker too large');
    const review=JSON.parse(reviewText);
    if(review.source!==source||!['backend','harness','inconclusive'].includes(review.classification))throw Error('Diagnostic review not bound to source');
    receipt.diagnosisReview=review;
    try { await run('remaining-acceptance',process.execPath,['--import','tsx','scripts/manual/hub-enrolment-code-campaign/capacity.mts'],{CAMPAIGN_MODE:'remainder'}); }
    catch(e){
      if(stopping)throw e;
      const file='/evidence/receipt-remainder.json';
      if(!existsSync(file)||JSON.parse(readFileSync(file,'utf8')).cleaned!==true)throw e;
      receipt.remainingError=String(e); // Independent style/rollback still run; readiness remains false.
    }
  } else {
    await run(phases[1], process.execPath, ['--import','tsx','scripts/manual/hub-enrolment-code-campaign/capacity.mts']);
  }
  for(const [name,script] of [['hub-ui-style','smoke-hub-ui-gate.mts'],['hub-shell-style','smoke-hub-shell-gate.mts']]) {
    try { await run(name,process.execPath,['--import','tsx','scripts/manual/smoke/'+script],{PW_DIR:'/pw',OUT:'/evidence/style',MATRIX:'quick'}); }
    catch(e){if(stopping)throw e;receipt.styleErrors??=[];receipt.styleErrors.push(String(e));}
  }
  await run(phases[2], process.execPath, ['--import','tsx','scripts/manual/hub-enrolment-code-b1/rollback.mts'], { AGEND_OWNED_CONTAINER: 'hub-enrolment-code-b1' });
  requireWindow(plan, source, Date.now(), existsSync('/control/STOP'));
  if(receipt.phases.some((phase:any)=>phase.exitCode!==0))throw Error('One or more retained phases failed');
  for(const file of (plan.mode==='diagnose-3713'?['receipt-diagnosis.json','receipt-remainder.json','rollback-receipt.json']:['receipt-runtime.json','rollback-receipt.json'])) {
    if(!existsSync('/evidence/'+file))throw Error('Missing phase receipt: '+file);
    const phase=JSON.parse(readFileSync('/evidence/'+file,'utf8'));
    if(phase.ready!==true||phase.cleaned!==true)throw Error('Phase did not verify cleanup/readiness: '+file);
    if(file!=='rollback-receipt.json'&&phase.source!==source)throw Error('Runtime phase used another source');
  }
  receipt.ready = true;
} catch (e) { receipt.error = String(e); process.exitCode = 1; }
finally {
  clearInterval(watch); sample(); receipt.finishedAt = Date.now();
  for (const [key,file] of [['runtime','receipt-runtime.json'],['diagnosis','receipt-diagnosis.json'],['remainder','receipt-remainder.json'],['rollback','rollback-receipt.json']] as const) {
    if (existsSync('/evidence/' + file)) receipt[key] = JSON.parse(readFileSync('/evidence/' + file, 'utf8'));
  }
  writeFileSync(join('/evidence','receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
}
process.exit(receipt.ready ? 0 : 1);
