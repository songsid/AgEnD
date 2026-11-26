import subprocess,json,time
busy=[]
try:
 for i in range(2):busy.append(subprocess.Popen(['python3','-c','x=0\nwhile True: x=(x+1)%1000003']))
 r=subprocess.run(['node','/proof/node-fresh.cjs'],capture_output=True,text=True,timeout=120)
 print(r.stdout,end='');print(r.stderr,end='');print(json.dumps({'code':r.returncode,'busyChildren':len(busy)}));raise SystemExit(r.returncode)
finally:
 for p in busy:p.terminate()
 for p in busy:p.wait(timeout=5)
