import {expect,it,vi}from'vitest';import{randomUUID}from'node:crypto';
import{PaneMcpSession,type PaneMcpConnection}from'../src/windows-pane-mcp.js';
import{validatePaneMcpBody,validatePaneMcpOwner,type PaneMcpBody}from'../src/runtime-pane-mcp-protocol.js';
const owner=()=>({hostBootId:randomUUID(),paneId:randomUUID(),launchId:randomUUID(),agentId:randomUUID(),instance:'agent-中文'});
const connection=():PaneMcpConnection=>({endpoint:'http://127.0.0.1:12345/agent',token:'a'.repeat(64),tools:['report_result'],owner:owner()});
const request={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'report_result',arguments:{target_instance:'leader',summary:'done'}}};
it('restarted helpers do not reuse a tool identity for JSON-RPC id 1',async()=>{
 const http=vi.fn(async(_body:PaneMcpBody)=>({result:{content:[{type:'text',text:'ok'}]},responseId:'b'.repeat(64)})),conn=connection();
 const first=new PaneMcpSession(conn,http),second=new PaneMcpSession(conn,http);await first.rpc(request);await first.rpc(request);await second.rpc(request);
 const calls=http.mock.calls.map(([body])=>{if(body.method!=="tools/call")throw Error("Expected tool call");return body;});
 expect(calls[0].callId).toBe(calls[1].callId);expect(calls[2].callId).not.toBe(calls[0].callId);
 expect(JSON.stringify(http.mock.calls)).not.toContain(conn.token);
});
it('acknowledges a result once, only when its stdio response has been written',async()=>{
 const http=vi.fn(async(_body:PaneMcpBody)=>({result:{content:[{type:'text',text:'ok'}]},responseId:'b'.repeat(64)})),session=new PaneMcpSession(connection(),http);
 const result=(await session.rpc(request))!;expect(http).toHaveBeenCalledTimes(1);await session.responseWritten(result);await session.responseWritten(result);
 expect(http).toHaveBeenCalledTimes(2);expect(http.mock.calls[1][0]).toMatchObject({method:'response-written',responseId:'b'.repeat(64),owner:expect.any(Object)});
});
it('an error or failed relay never produces an acknowledgement',async()=>{
 const http=vi.fn(async(_body:PaneMcpBody)=>{throw Error('private transport information');}),session=new PaneMcpSession(connection(),http);
 const result=(await session.rpc(request))!;expect(result).toMatchObject({error:{code:-32000}});await session.responseWritten(result);expect(http).toHaveBeenCalledTimes(1);
 expect(JSON.stringify(result)).not.toContain('private');
});
it('closed pane identities and method shapes refuse foreign or arbitrary fields',()=>{
 const body={op:'pane-mcp',method:'tools/list',owner:owner(),helperId:randomUUID(),params:{}};expect(validatePaneMcpBody(body)).toEqual(body);
 expect(()=>validatePaneMcpOwner({...owner(),machine:'arbitrary'})).toThrow();expect(()=>validatePaneMcpBody({...body,command:'whoami'})).toThrow();
 expect(()=>validatePaneMcpBody({...body,method:'response-written',callId:'x',responseId:'b'.repeat(64)})).toThrow();
});
it('helper presence starts only after initialize AND tool-list responses are written, and stops with the helper',async()=>{
 const http=vi.fn(async(_body:PaneMcpBody)=>({result:{tools:[]}})),session=new PaneMcpSession(connection(),http);
 await session.heartbeat();expect(http).not.toHaveBeenCalled();const initialized=(await session.rpc({jsonrpc:'2.0',id:9,method:'initialize',params:{protocolVersion:'2025-06-18'}}))!;
 await session.heartbeat();expect(http).not.toHaveBeenCalled();await session.responseWritten(initialized);await session.heartbeat();expect(http).not.toHaveBeenCalled();
 const list=(await session.rpc({jsonrpc:'2.0',id:10,method:'tools/list'}))!;await session.heartbeat();expect(http).toHaveBeenCalledOnce();await session.responseWritten(list);expect(http).toHaveBeenNthCalledWith(2,expect.objectContaining({method:'presence',helperId:session.helperId,params:{}}));session.close();await session.heartbeat();expect(http).toHaveBeenCalledTimes(2);
});
it('a held presence request never fans out into overlapping requests',async()=>{
 const releases:Array<(value:unknown)=>void>=[];const http=vi.fn((body:PaneMcpBody)=>body.method==='tools/list'?Promise.resolve({result:{tools:[]}}):new Promise(done=>{releases.push(done);})),session=new PaneMcpSession(connection(),http);
 const initialized=(await session.rpc({jsonrpc:'2.0',id:9,method:'initialize'}))!;await session.responseWritten(initialized);const list=(await session.rpc({jsonrpc:'2.0',id:10,method:'tools/list'}))!,pending=[session.responseWritten(list),session.heartbeat(),session.heartbeat()];
 try{expect(http.mock.calls.filter(([body])=>body.method==='presence')).toHaveLength(1);}finally{for(const release of releases)release({result:{ok:true}});await Promise.all(pending);session.close();}
});
it('a failed tool-list response does not advertise a serving helper',async()=>{
 const http=vi.fn(async()=>{throw Error('coordinator offline');}),session=new PaneMcpSession(connection(),http);
 const initialized=(await session.rpc({jsonrpc:'2.0',id:9,method:'initialize'}))!;await session.responseWritten(initialized);const failed=(await session.rpc({jsonrpc:'2.0',id:10,method:'tools/list'}))!;expect(failed).toHaveProperty('error');await session.responseWritten(failed);await session.heartbeat();expect(http).toHaveBeenCalledOnce();
});
