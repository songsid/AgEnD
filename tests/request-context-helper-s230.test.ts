/** Inert launch protocol plus private local sockets only; never starts a Fleet or CLI. */
import {afterEach,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {tmpdir} from "node:os";
import {once} from "node:events";
import {createConnection} from "node:net";
import {RequestContextHelperAdmission} from "../src/request-context-helper.js";
import {IpcServer} from "../src/channel/ipc-bridge.js";
import {Daemon} from "../src/daemon.js";
const cleanup:Array<()=>void|Promise<void>>=[];afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();vi.restoreAllMocks();});
it("a helper must present its own confirmed launch, before any tool frame",()=>{
 const gate=new RequestContextHelperAdmission(),socket={},token=gate.begin();expect(gate.ready()).toBe(false);
 expect(gate.admit({type:"tool_call"},socket)).toBe(false);expect(gate.admit({type:"mcp_ready",launchToken:token},socket)).toBe(false);
 gate.confirm(token);expect(gate.ready()).toBe(false);const hello={type:"mcp_ready",launchToken:token};expect(gate.admit(hello,socket)).toBe(true);expect(hello).not.toHaveProperty("launchToken");expect(gate.ready()).toBe(true);
 expect(gate.admit({type:"tool_call"},socket)).toBe(true);expect(gate.admit({type:"pong"},{})).toBe(false);expect(gate.admit({type:"fleet_inbound"},{})).toBe(true);
});
it("an old helper reconnecting to the fixed path never acquires a new launch or reaches C",()=>{
 const gate=new RequestContextHelperAdmission(),oldSocket={},old=gate.begin();gate.confirm(old);gate.admit({type:"mcp_ready",launchToken:old},oldSocket);
 const next=gate.begin();expect(next).not.toBe(old);expect(()=>gate.confirm(old)).toThrow(/changed/);gate.confirm(next);
 expect(gate.admit({type:"tool_call"},oldSocket)).toBe(false);expect(gate.admit({type:"mcp_ready",launchToken:old},{})).toBe(false);
 expect(gate.admit({type:"mcp_ready"},{})).toBe(false);expect(gate.ready()).toBe(false);
 const socket={destroyed:false};expect(gate.admit({type:"mcp_ready",launchToken:next},socket)).toBe(true);expect(gate.ready()).toBe(true);socket.destroyed=true;expect(gate.ready()).toBe(false);
 gate.revoke();expect(gate.admit({type:"tool_call"},socket)).toBe(false);
});
it("admission rejects before every IPC listener, including extra frames in the same read",async()=>{
 const home=mkdtempSync(join(tmpdir(),"helper-admission-"));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const path=join(home,"channel.sock"),server=new IpcServer(path),gate=new RequestContextHelperAdmission(),token=gate.begin();gate.confirm(token);
 const capture=vi.fn();server.setMessageAdmission((message,socket)=>gate.admit(message,socket));server.on("message",capture);await server.listen();cleanup.push(()=>server.close());
 const stale=createConnection(path);stale.on("error",()=>{});await once(stale,"connect");const gone=once(stale,"close");
 stale.write(JSON.stringify({type:"mcp_ready",launchToken:"0".repeat(64)})+"\n"+JSON.stringify({type:"tool_call"})+"\n"+JSON.stringify({type:"fleet_outbound"})+"\n");await gone;expect(capture).not.toHaveBeenCalled();
 const fresh=createConnection(path);fresh.on("error",()=>{});cleanup.push(()=>{fresh.destroy();});await once(fresh,"connect");fresh.write(JSON.stringify({type:"mcp_ready",launchToken:token})+"\n"+JSON.stringify({type:"tool_call"})+"\n");
 await vi.waitFor(()=>expect(capture).toHaveBeenCalledTimes(2));expect(capture.mock.calls[0]![0]).not.toHaveProperty("launchToken");
 const next=gate.begin();gate.confirm(next);const closed=once(fresh,"close");fresh.write(JSON.stringify({type:"tool_call"})+"\n");await closed;expect(capture).toHaveBeenCalledTimes(2);
});
it("legacy IPC has no launch admission requirement",async()=>{
 const home=mkdtempSync(join(tmpdir(),"legacy-helper-"));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));const server=new IpcServer(join(home,"channel.sock"));await server.listen();cleanup.push(()=>server.close());
 const capture=vi.fn();server.on("message",capture);const client=createConnection(join(home,"channel.sock"));cleanup.push(()=>{client.destroy();});await once(client,"connect");client.write(JSON.stringify({type:"tool_call"})+"\n");await vi.waitFor(()=>expect(capture).toHaveBeenCalledOnce());
});
it("the daemon exposes a launch token only for an installed local C owner and revokes it on stop",()=>{
 const root=mkdtempSync(join(tmpdir(),"helper-env-"));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));const logger:any={info(){},warn(){},error(){},debug(){},child(){return this;}};
 const daemon:any=new Daemon("worker",{working_directory:root,backend:"claude-code"} as any,root,true,undefined,undefined,logger);
 expect(daemon.requestContextHelperReadiness()).toBeNull();expect(daemon.buildBackendConfig().mcpServers.agend.env).not.toHaveProperty("AGEND_LAUNCH_TOKEN");
 // The actual pre-start C setter owns construction; no model/env input can install this gate.
 const turns:any={registrationGate:null};daemon.setRequestContextLocalLifecycle(turns,()=>({incarnation:"inc",workGeneration:"work"}));const token=daemon.requestContextHelper.begin();
 expect(daemon.buildBackendConfig().mcpServers.agend.env.AGEND_LAUNCH_TOKEN).toBe(token);expect(daemon.requestContextHelperReadiness()).toMatchObject({version:1,ready:false});
});

it("the bundled MCP helper presents its immutable launch bearer on the first IPC frame",async()=>{
 const home=mkdtempSync(join(tmpdir(),"helper-wire-"));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const path=join(home,"channel.sock"),server=new IpcServer(path),gate=new RequestContextHelperAdmission(),token=gate.begin();gate.confirm(token);
 server.setMessageAdmission((message,socket)=>gate.admit(message,socket));await server.listen();cleanup.push(()=>server.close());
 const messages:any[]=[];server.on("message",(message,socket)=>{messages.push(message);if(message.type==="tool_call")socket.write(JSON.stringify({requestId:message.requestId,result:{sent:true}})+"\n");});
 const client=new Client({name:"private-helper-fixture",version:"1"});cleanup.push(()=>client.close());
 await client.connect(new StdioClientTransport({command:process.execPath,args:["--import","tsx",resolve("src/channel/mcp-server.ts")],env:{...process.env as Record<string,string>,AGEND_HOME:home,AGEND_FLEET_DATA_DIR:home,AGEND_FLEET_CONFIG_PATH:join(home,"fleet.yaml"),AGEND_SOCKET_PATH:path,AGEND_INSTANCE_NAME:"fixture",AGEND_TOOL_SET:"worker",AGEND_LAUNCH_TOKEN:token},stderr:"pipe"}));
 await vi.waitFor(()=>expect(gate.ready()).toBe(true));expect(messages[0]).toMatchObject({type:"mcp_ready",sessionName:"fixture"});expect(messages[0]).not.toHaveProperty("launchToken");
 const result:any=await client.callTool({name:"reply",arguments:{text:"Fixture only"}},undefined,{timeout:2000});expect(JSON.parse(result.content[0].text)).toEqual({sent:true});
});
