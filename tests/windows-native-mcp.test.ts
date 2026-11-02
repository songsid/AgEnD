import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { nativeMcpRpc, readNativeMcpConnection, type NativeMcpRequest } from "../src/windows-native-mcp.js";
import { validateNativeMcpConnection, type NativeMcpConnection } from "../src/windows-cli-providers.js";

const connection:NativeMcpConnection={endpoint:"http://127.0.0.1:19280/agent",token:"a".repeat(64),tools:["query_task","delegate_task"]};
const directories:string[]=[];
afterEach(()=>{for(const path of directories.splice(0)){if(!resolve(path).startsWith(resolve(tmpdir())+sep))throw Error("Unsafe scratch directory");rmSync(path,{recursive:true,force:true});}});
const rpc=(method:string,params:Record<string,unknown>={},id:string|number=1)=>({jsonrpc:"2.0",id,method,params});

describe("native MCP connection boundary",()=>{
  it("accepts only scoped loopback /agent connections, bounded tool names and opaque turn tokens",()=>{
    expect(validateNativeMcpConnection({...connection,tools:["query_task","query_task"]})).toEqual({...connection,tools:["query_task"]});
    for(const patch of [
      {endpoint:"https://127.0.0.1:19280/agent"},{endpoint:"http://example.com:19280/agent"},{endpoint:"http://127.0.0.1:19280/agent?token=x"},
      {endpoint:"http://user:pass@127.0.0.1:19280/agent"},{endpoint:"http://127.0.0.1:19280/ui/send"},{endpoint:"http://127.0.0.1/agent"},
      {token:"admin-token"},{tools:["query_task;whoami"]},{tools:[]},{instance:"other"},
    ])expect(()=>validateNativeMcpConnection({...connection,...patch})).toThrow(/native MCP/i);
  });
  it("reads a regular private connection file and rejects corrupt, oversized and non-file inputs",()=>{
    const dir=mkdtempSync(join(tmpdir(),"agend-native-mcp-"));directories.push(dir);
    const path=join(dir,"connection.json");writeFileSync(path,JSON.stringify(connection));
    expect(readNativeMcpConnection(path)).toEqual(connection);
    writeFileSync(path,"not JSON");expect(()=>readNativeMcpConnection(path)).toThrow();
    writeFileSync(path,"x".repeat(32_001));expect(()=>readNativeMcpConnection(path)).toThrow(/connection file/);
    const folder=join(dir,"folder");mkdirSync(folder);expect(()=>readNativeMcpConnection(folder)).toThrow(/connection file/);
  });
});

describe("built-ins-only native MCP protocol",()=>{
  it("initializes and pings locally without needing dashboard or admin credentials",async()=>{
    const transport=vi.fn();
    expect(await nativeMcpRpc(rpc("initialize",{protocolVersion:"2025-06-18"}),connection,transport)).toMatchObject({jsonrpc:"2.0",id:1,result:{protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"agend-native"}}});
    expect(await nativeMcpRpc(rpc("ping"),connection,transport)).toEqual({jsonrpc:"2.0",id:1,result:{}});
    expect(transport).not.toHaveBeenCalled();
  });
  it("lists only the tools in this execution's capability even if the coordinator returns more",async()=>{
    const transport=vi.fn(async()=>({tools:[{name:"query_task",inputSchema:{type:"object"}},{name:"update_instance_config"}]}));
    const response=await nativeMcpRpc(rpc("tools/list"),connection,transport);
    expect(transport).toHaveBeenCalledWith({op:"native-mcp",method:"tools/list",params:{}});
    expect(response).toEqual({jsonrpc:"2.0",id:1,result:{tools:[{name:"query_task",inputSchema:{type:"object"}}]}});
  });
  it("forwards literal tool arguments with a stable call identity and returns the MCP result",async()=>{
    const result={content:[{type:"text",text:'{"accepted":true,"operation_id":"op-1"}'}]};
    const transport=vi.fn(async(_body:NativeMcpRequest)=>result), request=rpc("tools/call",{name:"delegate_task",arguments:{instance:"worker",message:'$(whoami) & "quoted"\nnext'}},"call-1");
    expect(await nativeMcpRpc(request,connection,transport)).toEqual({jsonrpc:"2.0",id:"call-1",result});
    await nativeMcpRpc(request,connection,transport);
    const first=transport.mock.calls[0][0] as any,again=transport.mock.calls[1][0] as any;
    expect(first).toMatchObject({op:"native-mcp",method:"tools/call",params:request.params});
    expect(first.callId).toMatch(/^[a-f0-9]{64}$/);expect(again.callId).toBe(first.callId);
    expect(JSON.stringify(first)).not.toContain(connection.token);
  });
  it("never calls a tool for notifications, unauthorized names, invalid arguments or unknown methods",async()=>{
    const transport=vi.fn();
    expect(await nativeMcpRpc({jsonrpc:"2.0",method:"tools/call",params:{name:"delegate_task"}},connection,transport)).toBeNull();
    expect(await nativeMcpRpc(rpc("tools/call",{name:"update_instance_config",arguments:{}}),connection,transport)).toMatchObject({error:{code:-32602}});
    expect(await nativeMcpRpc(rpc("tools/call",{name:"query_task",arguments:[]}),connection,transport)).toMatchObject({error:{code:-32602}});
    expect(await nativeMcpRpc(rpc("resources/read"),connection,transport)).toMatchObject({error:{code:-32601}});
    expect(await nativeMcpRpc({jsonrpc:"2.0",id:null,method:"tools/call"},connection,transport)).toMatchObject({error:{code:-32600}});
    expect(transport).not.toHaveBeenCalled();
  });
  it("does not expose connection credentials or raw transport errors in a tool error",async()=>{
    const transport=vi.fn(async()=>{throw Error(`${connection.token} arbitrary transport failure`);});
    const response=await nativeMcpRpc(rpc("tools/call",{name:"query_task",arguments:{}}),connection,transport);
    expect(response).toMatchObject({error:{code:-32000}});
    expect(JSON.stringify(response)).not.toContain(connection.token);
  });
});
