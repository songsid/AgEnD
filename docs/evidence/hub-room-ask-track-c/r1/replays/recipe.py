import hashlib, json, os, pathlib, subprocess
root=pathlib.Path.cwd(); source=root/'src/hub/member/room-ask.ts'; original=source.read_bytes(); current=original.decode()
old_sha='985e2753b6dd8e3880b1cc67e9697a0f3d06f159'
old=subprocess.check_output(['git','show',f'{old_sha}:src/hub/member/room-ask.ts'],text=True)
folder=root/'.artifacts/room-ask-track-c/review-replays'; folder.mkdir(parents=True,exist_ok=True)
records=[]
def part(text,start,end): return text[text.index(start):text.index(end,text.index(start))]
try:
    for name,start,end,test in [
        ('old-presence','export function agentPresence','\nexport interface RoomStateLink','exports stable viewer-translated reason codes'),
        ('old-prompt','export function formatRoomAskPrompt','\nexport function agentPresence','frames member content as JSON data'),
    ]:
        if os.getloadavg()[0]>10: raise RuntimeError('load above10; stop before next replay')
        prior=part(old,start,end); baseline=part(current,start,end); mutated=current.replace(baseline,prior)
        source.write_text(mutated)
        with (folder/f'{name}-types.log').open('w') as out:
            typed=subprocess.run(['nice','-n','10','node_modules/@typescript/typescript-linux-x64/lib/tsc','--noEmit'],stdout=out,stderr=subprocess.STDOUT)
        with (folder/f'{name}-test.log').open('w') as out:
            tested=subprocess.run(['nice','-n','10','node_modules/.bin/vitest','run','--no-file-parallelism','tests/hub-room-ask-track-c.test.ts','-t',test],stdout=out,stderr=subprocess.STDOUT)
        log=(folder/f'{name}-test.log').read_text()
        row=dict(name=name,originalHead=old_sha,oldFunctionSha256=hashlib.sha256(prior.encode()).hexdigest(),replayedSourceSha256=hashlib.sha256(mutated.encode()).hexdigest(),compileExit=typed.returncode,testExit=tested.returncode,assertionRed='AssertionError:' in log)
        records.append(row); print(json.dumps(row),flush=True); source.write_bytes(original)
        if typed.returncode or not tested.returncode or not row['assertionRed']: raise RuntimeError('not a compiling assertion red')
finally:
    source.write_bytes(original)
    (folder/'summary.json').write_text(json.dumps(dict(baselineSourceSha256=hashlib.sha256(original).hexdigest(),testSha256=hashlib.sha256((root/'tests/hub-room-ask-track-c.test.ts').read_bytes()).hexdigest(),records=records,restored=source.read_bytes()==original),indent=2)+'\n')
