/** Actual Fleet IPC dispatcher on an owned local socket; no daemon/CLI/Fleet service starts. */
import { expect,it,vi } from "vitest";
import { mkdtempSync,mkdirSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FleetManager } from "../src/fleet-manager.js";
import { IpcServer } from "../src/channel/ipc-bridge.js";
it("routes actual input receipts only from the current instance IPC connection",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"agend-room-ipc-")),fm:any=new FleetManager(dir),agent="worker";
  const instance=fm.getInstanceDir(agent);mkdirSync(instance,{recursive:true});
  const server=new IpcServer(join(instance,"channel.sock")),input=vi.fn();fm.hubRoomInput=input;
  vi.spyOn(fm.statuslineWatcher,"watch").mockImplementation(()=>{});
  await server.listen();
  try{
    await fm.connectIpcToInstance(agent);const first=fm.instanceIpcClients.get(agent);
    const late=first.listeners("message")[0] as (v:unknown)=>void;
    const msg={type:"hub_room_input",correlationId:`hub-room-${randomUUID()}`,generation:randomUUID()};
    server.broadcast(msg);await vi.waitFor(()=>expect(input).toHaveBeenCalledWith(msg.correlationId,agent,msg.generation));
    input.mockClear();await fm.connectIpcToInstance(agent);late(msg);expect(input).not.toHaveBeenCalled();
    server.broadcast({...msg,generation:null});await new Promise(resolve=>setTimeout(resolve,10));expect(input).not.toHaveBeenCalled();
    server.broadcast(msg);await vi.waitFor(()=>expect(input).toHaveBeenCalledTimes(1));
  }finally{
    fm.ipcStoppingInstances.add(agent);await fm.instanceIpcClients.get(agent)?.close();await server.close();
    fm.stormWindow.shutdown();vi.restoreAllMocks();rmSync(dir,{recursive:true,force:true});
  }
});
