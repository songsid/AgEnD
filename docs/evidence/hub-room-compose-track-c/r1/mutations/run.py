from pathlib import Path
import hashlib,json,os,subprocess
out=Path(".artifacts/room-compose-track-c/r1-mutations"); path=Path("src/hub/compose/member.ts"); raw=path.read_bytes(); text=raw.decode()
start=text.index('          if (frame.type === "room.ask") {', text.index('        receive: (frame, l) => {'))
end=text.index('          if (frame.type === "room.answer-ack")',start)
block=text[start:end]
key='const roomKey = Buffer.from(hkdfSync("sha256", readKey(home, set.keys[1]!), Buffer.alloc(0),\n        Buffer.from(JSON.stringify(["agend-hub-room-journal-key-v1", roomBinding])), 32));'
cases=[
 ("R8-refusal-link",block,'          if (frame.type === "room.ask") { room.accept(frame.payload, roomLink(l)); return Promise.resolve(); }\n',"without dropping"),
 ("R9-room-subkey",key,'const roomKey = readKey(home, set.keys[1]!);',"derived room key"),
 ("R10-backpressure",' || error.code === "backpressure"','',"for backpressure"),
]
results=[]
try:
 for name,before,after,selected in cases:
  if os.getloadavg()[0]>10: raise RuntimeError("load gate above10")
  assert text.count(before)==1,(name,text.count(before)); path.write_text(text.replace(before,after))
  try:
   with (out/(name+"-types.log")).open("w") as log: types=subprocess.run(["node_modules/@typescript/typescript-linux-x64/lib/tsc","--noEmit","--pretty","false"],stdout=log,stderr=subprocess.STDOUT).returncode
   with (out/(name+".log")).open("w") as log: test=subprocess.run(["node_modules/.bin/vitest","run","tests/hub-room-compose-track-c.test.ts","--no-file-parallelism","--reporter=dot","-t",selected],stdout=log,stderr=subprocess.STDOUT).returncode
   semantic="AssertionError" in (out/(name+".log")).read_text()
   r={"name":name,"mutantSha256":hashlib.sha256(path.read_bytes()).hexdigest(),"types":types,"testExit":test,"assertionRed":semantic};results.append(r);(out/"summary.json").write_text(json.dumps(results,indent=2)+"\n");print(json.dumps(r),flush=True)
   assert types==0 and test!=0 and semantic,name
  finally: path.write_bytes(raw)
finally:
 path.write_bytes(raw);assert path.read_bytes()==raw
 (out/"restored.json").write_text(json.dumps({"restored":True,"sourceSha256":hashlib.sha256(raw).hexdigest()},indent=2)+"\n")
