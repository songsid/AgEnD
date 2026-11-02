import {expect,it,vi}from'vitest';import{randomUUID}from'node:crypto';
import{PaneMcpSession,type PaneMcpConnection}from'../src/windows-pane-mcp.js';
import{validatePaneMcpBody,validatePaneMcpOwner,type PaneMcpBody}from'../src/runtime-pane-mcp-protocol.js';
const owner=()=>({hostBootId:randomUUID(),paneId:randomUUID(),launchId:randomUUID(),agentId:randomUUID(),instance:'agent-中文'});
const connection=():PaneMcpConnection=>({endpoint:'http://127.0.0.1:12345/agent',token:'a'.repeat(64),tools:['report_result'],owner:owner()});
const request={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'report_result',arguments:{target_instance:'leader',summary:'done'}}};
it('restarted helpers do not reuse a tool identity for JSON-RPC id 1',async()=>{
 const http=vi.fn(async(_body:PaneMcpBody)=>({result:{content:[{type:'text',text:'ok'}]},responseId:'b'.repeat(64)})),conn=connection();
 const first=new PaneMcpSession(conn,http),second=new PaneMcpSession(conn,http);await first.rpc(request);await first.rpc(request);await second.rpc(request);
 expect(http.mock.calls[0][0].callId).toBe(http.mock.calls[1][0].callId);expect(http.mock.calls[2][0].callId).not.toBe(http.mock.calls[0][0].callId);
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
