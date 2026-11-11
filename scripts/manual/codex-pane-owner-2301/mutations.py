import pathlib,subprocess,json,os
repo=pathlib.Path(os.environ['REPO']).resolve();out=pathlib.Path(os.environ['OUT']).resolve();out.mkdir(parents=True,exist_ok=False)
paths=['src/codex-pane-ownership.ts','src/daemon.ts','src/transcript-delta-reader.ts','src/backend/codex.ts'];saved={p:(repo/p).read_text() for p in paths}
def replace(p,a,b):
 assert a in saved[p],(p,a)
 return saved[p].replace(a,b)
def scope(a,b):
 s=saved['src/daemon.ts'];i=s.index('  private async bindCodexRawPaste(');j=s.index('\n  /** The CLI this daemon',i);return s[:i]+s[i:j].replace(a,b)+s[j:]
mutants=[
 ('M1-meta-id','src/codex-pane-ownership.ts',replace(paths[0],'          meta.payload?.id !== sessionId ||\n','')),
 ('M2-meta-cwd','src/codex-pane-ownership.ts',replace(paths[0],'          typeof meta.payload.cwd !== "string" ||\n          (await realpath(meta.payload.cwd)) !== expectedCwd','          typeof meta.payload.cwd !== "string"')),
 ('M3-child-parent','src/codex-pane-ownership.ts',replace(paths[0],'          meta.payload.parent_thread_id ||\n','')),
 ('M4-file-no-revival','src/codex-pane-ownership.ts',replace(paths[0],'        if (retired) return false;','')),
 ('M5-opened-descriptor','src/transcript-delta-reader.ts',replace(paths[2],'opened.dev !== this.identity.dev || opened.ino !== this.identity.ino || ',' ')),
 ('M6-current-session','src/daemon.ts',scope('first.sessionId !== before.sessionId || ','').replace('last.sessionId !== before.sessionId || ','')),
 ('M7-attempt-owner','src/daemon.ts',scope('sameInteractionOwner(owner, this.interactionOwner()) && ','')),
 ('M8-prewrite-offset','src/codex-pane-ownership.ts',replace(paths[0],'      offset: first.offset,','      offset: 0,')),
 ('M9-partial-prewrite','src/codex-pane-ownership.ts',replace(paths[0],'const first = await inspect(true);','const first = await inspect();')),
 ('M10-proof-wiring','src/daemon.ts',replace(paths[1],'!rawPaste || codexCheckpoint || RAW_TEXT_TRANSCRIPT_BACKENDS','!rawPaste || RAW_TEXT_TRANSCRIPT_BACKENDS')),
 ('M11-owner-no-revival','src/daemon.ts',scope('retired = true;','retired = false;')),
]
rows=[]
try:
 for name,p,changed in mutants:
  assert changed!=saved[p];(repo/p).write_text(changed)
  types=subprocess.run(['node','node_modules/@typescript/native/bin/tsc','--noEmit'],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True);(out/(name+'-types.log')).write_text(types.stdout)
  if types.returncode:raise RuntimeError(name+' did not compile')
  test=subprocess.run(['node','node_modules/vitest/vitest.mjs','run','tests/codex-pane-ownership-2301.test.ts','tests/codex-pane-file-2301.test.ts','tests/codex-pane-read-race-2301.test.ts','--maxWorkers=2'],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True);(out/(name+'.log')).write_text(test.stdout)
  semantic=test.returncode!=0 and 'AssertionError' in test.stdout and 'timed out' not in test.stdout
  rows.append({'name':name,'compiled':True,'caughtByAssertion':semantic,'exit':test.returncode});print(rows[-1],flush=True)
  (repo/p).write_text(saved[p])
  if not semantic:raise RuntimeError(name+' survived or did not fail semantically')
finally:
 for p,s in saved.items():(repo/p).write_text(s)
 (out/'receipt.json').write_text(json.dumps(rows,indent=2)+'\n')
