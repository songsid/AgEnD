import{afterEach,expect,it,vi}from'vitest';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import pino from'pino';
import{Daemon}from'../src/daemon.js';import{createNativePaneBackend}from'../src/backend/native-pane.js';import type{Logger}from'../src/logger.js';
const roots:string[]=[];afterEach(()=>{vi.useRealTimers();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'agend-pane-mcp-'));roots.push(dir);const backend=createNativePaneBackend('codex',()=>({sessionId:null,contextPercentage:null,statusLineItems:null,resumes:false}));
 const daemon=new Daemon('native-agent',{working_directory:dir,log_level:'silent'}as never,dir,true,backend,undefined,pino({level:'silent'})as Logger)as Daemon&Record<string,any>;
 const broadcast=vi.fn(),send=vi.fn();daemon['ipcServer']={broadcast,send};daemon['lastChatId']='owned-chat';daemon['lastThreadId']='owned-topic';
 vi.spyOn(daemon as any,'noteMcpProofOfLife').mockImplementation(()=>{});return{daemon,broadcast,send};
}
it('native reply goes through ordinary topic routing and settles the same reply guard',async()=>{
 const f=fixture();f.daemon['markTurnStarted']({chat_id:'owned-chat'},'[user:test via web, id:person] answer me');
 const pending=f.daemon.handlePaneToolCall({tool:'reply',args:{text:'answer'},operationId:'native-operation'}, {current:()=>true,allowed:()=>true});
 const out=f.broadcast.mock.calls.at(-1)![0];expect(out.args).toMatchObject({text:'answer',chat_id:'owned-chat',thread_id:'owned-topic'});
 f.daemon['pendingIpcRequests'].get(out.fleetRequestId)({result:{messageId:'delivered'}});
 expect(await pending).toEqual({result:{messageId:'delivered'}});expect(f.daemon['turnReplyGuard'].snapshot()?.completionDelivered).toBe(true);expect(f.send).not.toHaveBeenCalled();
});
it('expired or forbidden tool lease routes nothing',async()=>{
 const f=fixture();expect((await f.daemon.handlePaneToolCall({tool:'reply',args:{text:'no'}},{current:()=>false,allowed:()=>true})).error).toContain('permission');
 expect((await f.daemon.handlePaneToolCall({tool:'reply',args:{text:'no'}},{current:()=>true,allowed:()=>false})).error).toContain('permission');expect(f.broadcast).not.toHaveBeenCalled();
});
it('relay resolution does not fabricate a native transport-written receipt',async()=>{
 const f=fixture(),written=vi.fn();f.daemon.on('mcp_tool_response_written',written);
 const pending=f.daemon.handlePaneToolCall({tool:'reply',args:{text:'answer'},operationId:'opaque-op'},{current:()=>true,allowed:()=>true});
 const out=f.broadcast.mock.calls.at(-1)![0];f.daemon['pendingIpcRequests'].get(out.fleetRequestId)({result:{messageId:'delivered'}});await pending;expect(written).not.toHaveBeenCalled();
});

it('passes native Fleet/task execution through the lease-aware mutation dispatcher while retaining its guard',async()=>{
 const f=fixture(),dispatch=vi.fn(async()=>({status:"ok"})),allowed=vi.fn((tool:string,args:Record<string,unknown>)=>tool==='task'&&args.action==='list');
 expect(await f.daemon.handlePaneToolCall({tool:'task',args:{action:'list'}},{current:()=>true,allowed,dispatch})).toEqual({result:{status:'ok'}});
 expect(dispatch).toHaveBeenCalledExactlyOnceWith('task',{action:'list'});expect(f.broadcast).not.toHaveBeenCalled();expect(allowed).toHaveBeenCalledWith('task',{action:'list'});
});
