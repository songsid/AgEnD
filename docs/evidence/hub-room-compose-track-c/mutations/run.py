from pathlib import Path
import hashlib, json, os, subprocess
root=Path.cwd(); out=root/".artifacts/room-compose-track-c/mutations"
compose=Path("src/hub/compose/member.ts"); fleet=Path("src/fleet-manager.ts")
originals={p:p.read_bytes() for p in (compose,fleet)}
cases=[
("C1-uncomposed-off",compose, '...(options.representative.readState ? { capabilities: [...HUB_OPTIONAL_CAPABILITIES, HUB_ROOM_ASK_CAPABILITY] } : {}),', 'capabilities: [...HUB_OPTIONAL_CAPABILITIES, HUB_ROOM_ASK_CAPABILITY],', "tests/hub-room-compose-track-c.test.ts", "uncomposed host"),
("C2-ack",compose, 'room.acknowledge(frame.payload, roomLink(l));', 'void frame.payload;', "tests/hub-room-compose-track-c.test.ts", "composes negotiated"),
("C3-consent-token",compose, ' || options.representative.agentToken(local.agent) !== consent.token', '', "tests/hub-room-compose-track-c.test.ts", "local consent becomes replace"),
("C4-pre-adoption",compose, 'if (meta.binding === null) verifyRoomAskJournal(db, { bindingKey: roomBinding, encryptionKey: roomKey });', 'void meta;', "tests/hub-room-compose-track-c.test.ts", "holds corrupt room history"),
("C5-delayed-failure",compose, 'room.deliveryFailed(cid, agent); service.deliveryFailed(cid, agent);', 'service.deliveryFailed(cid, agent);', "tests/hub-room-compose-track-c.test.ts", "routes delayed IPC"),
("C6-explicit-offer",compose, '...(options.representative.readState ? { capabilities: [...HUB_OPTIONAL_CAPABILITIES, HUB_ROOM_ASK_CAPABILITY] } : {}),', '', "tests/hub-room-compose-track-c.test.ts", "composes negotiated"),
("C7-fresh-approval",fleet, '!interaction.stale && !interaction.suspected', '!interaction.suspected', "tests/hub-fleet-hooks.test.ts", "only a fresh positive"),
]
results=[]
try:
 for name,path,before,after,suite,selected in cases:
  if os.getloadavg()[0]>10: raise RuntimeError("load gate above10")
  text=originals[path].decode(); assert text.count(before)==1,(name,text.count(before)); path.write_text(text.replace(before,after))
  try:
   with (out/(name+"-types.log")).open("w") as log:
    types=subprocess.run(["node_modules/@typescript/typescript-linux-x64/lib/tsc","--noEmit","--pretty","false"],stdout=log,stderr=subprocess.STDOUT).returncode
   with (out/(name+".log")).open("w") as log:
    test=subprocess.run(["node_modules/.bin/vitest","run",suite,"--no-file-parallelism","--reporter=dot","-t",selected],stdout=log,stderr=subprocess.STDOUT).returncode
   semantic="AssertionError" in (out/(name+".log")).read_text()
   result={"name":name,"path":str(path),"mutantSha256":hashlib.sha256(path.read_bytes()).hexdigest(),"types":types,"testExit":test,"assertionRed":semantic}
   results.append(result); (out/"summary.json").write_text(json.dumps(results,indent=2)+"\n")
   print(json.dumps(result),flush=True)
   assert types==0 and test!=0 and semantic,name
  finally: path.write_bytes(originals[path])
finally:
 for path,raw in originals.items(): path.write_bytes(raw)
 assert all(path.read_bytes()==raw for path,raw in originals.items())
 (out/"restored.json").write_text(json.dumps({"restored":True,"sources":{str(p):hashlib.sha256(raw).hexdigest() for p,raw in originals.items()}},indent=2)+"\n")
