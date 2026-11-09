from pathlib import Path
import json,sys,time
r=Path(__file__).resolve().parent/'main';cmd=Path(sys.argv[1]);f=r/'command.mjs';assert not f.exists(),'one command at a time';before=len(json.loads((r/'receipt.json').read_text()).get('commands',[]))if(r/'receipt.json').exists()else 0
(r/'command.tmp').write_text(cmd.read_text());(r/'command.tmp').rename(f)
for _ in range(2400):
 try:
  d=json.loads((r/'receipt.json').read_text());cs=d.get('commands',[])
  matches=[x for x in cs if x['n']>before and (r/f"command-{x['n']}.mjs").read_text()==cmd.read_text()]
  if matches:print(json.dumps(matches[-1],ensure_ascii=False));break
 except(FileNotFoundError,json.JSONDecodeError):pass
 time.sleep(.1)
else:raise RuntimeError('command still pending; inspect receipt/log before any resend')
