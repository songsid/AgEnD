import { IpcServer } from "../src/channel/ipc-bridge.js";
import{afterEach,expect,it,vi}from'vitest';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import pino from'pino';
import{Daemon}from'../src/daemon.js';import{createNativePaneBackend}from'../src/backend/native-pane.js';import type{Logger}from'../src/logger.js';
const roots:string[]=[];afterEach(()=>{vi.useRealTimers();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'agend-pane-mcp-'));roots.push(dir);const backend=createNativePaneBackend('codex',()=>({sessionId:null,contextPercentage:null,statusLineItems:null,resumes:false}));
 const daemon=new Daemon('native-agent',{working_directory:dir,log_level:'silent'}as never,dir,true,backend,undefined,pino({level:'silent'})as Logger)as Daemon&Record<string,any>;
 const broadcast=vi.fn(),send=vi.fn(()=>false),ipc=new IpcServer(join(dir,'unused.sock'));vi.spyOn(ipc,'broadcast').mockImplementation(broadcast);vi.spyOn(ipc,'send').mockImplementation(send);daemon['ipcServer']=ipc;daemon['lastChatId']='owned-chat';daemon['lastThreadId']='owned-topic';
 vi.spyOn(daemon as any,'noteMcpProofOfLife').mockImplementation(()=>{});
 const answer=(id:string,messageId:string)=>{const respond=daemon['pendingIpcRequests'].get(id);if(!respond)throw Error('Expected pending native reply');respond({result:{messageId}});};return{daemon,broadcast,send,answer};
}
it('native reply goes through ordinary topic routing and settles the same reply guard',async()=>{
 const f=fixture();f.daemon['markTurnStarted']({chat_id:'owned-chat'},'[user:test via web, id:person] answer me');
 const pending=f.daemon.handlePaneToolCall({tool:'reply',args:{text:'answer'},operationId:'native-operation'}, {current:()=>true,allowed:()=>true});
 const out=f.broadcast.mock.calls.at(-1)![0];expect(out.args).toMatchObject({text:'answer',chat_id:'owned-chat',thread_id:'owned-topic'});
 f.answer(out.fleetRequestId,'delivered');
 expect(await pending).toEqual({result:{messageId:'delivered'}});expect(f.daemon['turnReplyGuard'].snapshot()?.completionDelivered).toBe(true);expect(f.send).not.toHaveBeenCalled();
});
it('expired or forbidden tool lease routes nothing',async()=>{
 const f=fixture();expect((await f.daemon.handlePaneToolCall({tool:'reply',args:{text:'no'}},{current:()=>false,allowed:()=>true})).error).toContain('permission');
 expect((await f.daemon.handlePaneToolCall({tool:'reply',args:{text:'no'}},{current:()=>true,allowed:()=>false})).error).toContain('permission');expect(f.broadcast).not.toHaveBeenCalled();
});
it('relay resolution does not fabricate a native transport-written receipt',async()=>{
 const f=fixture(),written=vi.fn();f.daemon.on('mcp_tool_response_written',written);
 const pending=f.daemon.handlePaneToolCall({tool:'reply',args:{text:'answer'},operationId:'opaque-op'},{current:()=>true,allowed:()=>true});
 const out=f.broadcast.mock.calls.at(-1)![0];f.answer(out.fleetRequestId,'delivered');await pending;expect(written).not.toHaveBeenCalled();
});

it('passes native Fleet/task execution through the lease-aware mutation dispatcher while retaining its guard',async()=>{
 const f=fixture(),dispatch=vi.fn(async()=>({status:"ok"})),allowed=vi.fn((tool:string,args:Record<string,unknown>)=>tool==='task'&&args.action==='list');
 expect(await f.daemon.handlePaneToolCall({tool:'task',args:{action:'list'}},{current:()=>true,allowed,dispatch})).toEqual({result:{status:'ok'}});
 expect(dispatch).toHaveBeenCalledExactlyOnceWith('task',{action:'list'});expect(f.broadcast).not.toHaveBeenCalled();expect(allowed).toHaveBeenCalledWith('task',{action:'list'});
});
it('accepts a written ACK only while its exact daemon lease is current',()=>{
 const f=fixture(),written=vi.fn();f.daemon.on('mcp_tool_response_written',written);const operationId='12345678-1234-4234-8234-123456789abc';
 f.daemon.paneToolResponseWritten(operationId,()=>false);f.daemon.paneToolResponseWritten('invalid',()=>true);expect(written).not.toHaveBeenCalled();
 f.daemon.paneToolResponseWritten(operationId,()=>true);expect(written).toHaveBeenCalledExactlyOnceWith({operationId,daemonBootId:f.daemon.bootId});
 f.daemon['deliveryWritesStopping']=true;f.daemon.paneToolResponseWritten(operationId,()=>true);expect(written).toHaveBeenCalledOnce();
});
it.each(['checkout_repo','release_repo','get_usage','download_attachment','set_web_theme_asset','preview_web_appearance','preview_emojis','preview_stickers','office_pack_check','office_pack_upload'])('native %s refuses before local or Fleet dispatch',async tool=>{
 const f=fixture(),dispatch=vi.fn(),checkout=vi.spyOn(f.daemon as any,'handleCheckoutRepo'),release=vi.spyOn(f.daemon as any,'handleReleaseRepo');
 const answer=await f.daemon.handlePaneToolCall({tool,args:{source:'/must-not-be-read',force:true}},{current:()=>true,allowed:()=>true,dispatch});expect(answer.error).toContain('unavailable');expect(dispatch).not.toHaveBeenCalled();expect(checkout).not.toHaveBeenCalled();expect(release).not.toHaveBeenCalled();expect(f.broadcast).not.toHaveBeenCalled();
});

it('native replies cannot send coordinator-local files but text-only replies remain routable',async()=>{
 const f=fixture();const answer=await f.daemon.handlePaneToolCall({tool:'reply',args:{text:'file',files:['/coordinator/secret']}},{current:()=>true,allowed:()=>true});expect(answer.error).toContain('file transfer');expect(f.broadcast).not.toHaveBeenCalled();
 const pending=f.daemon.handlePaneToolCall({tool:'reply',args:{text:'text only',files:[]}},{current:()=>true,allowed:()=>true});const out=f.broadcast.mock.calls.at(-1)![0];f.answer(out.fleetRequestId,'posted');expect((await pending).error).toBeUndefined();
});
