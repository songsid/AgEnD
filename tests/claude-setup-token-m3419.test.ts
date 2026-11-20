import { afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { ClaudeSetupTokens, type SetupTokenOwner } from "../src/claude-setup-token.js";
import { createClaudeSetupTokenTransport } from "../src/claude-setup-token-transport.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
const secret=["sk","ant","oat01"].join("-")+"-"+"x".repeat(60);
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
function rig(){
 let current=true,alive=true,code=0,value:string|null=null,failClose=false;
 const owner:SetupTokenOwner={handle:"fixture-session",actor:{adapterId:"host",userId:"operator"},current:()=>current};
 const lock=new LoginWindowLock();
 const transport={start:vi.fn(async()=>{}),capture:vi.fn(async()=>alive?"https://claude.ai/oauth/authorize?code=true\nPaste code here if prompted >":""),status:vi.fn(async()=>({alive,exitCode:code})),write:vi.fn(async()=>{}),close:vi.fn(async()=>{if(failClose)throw Error("synthetic");}),takeToken:vi.fn(()=>{const v=value;value=null;return v;})};
 const commit=vi.fn(async(_p:any,_r:any,token:any,_a:any,_confirm:any,authorized:any,claim:any)=>{expect(authorized()).toBe(true);expect(lock.isCurrent(claim)).toBe(true);expect(token).toBe(secret);return {credential:{id:"fixture-id",revision:2,source:"managed",kind:"setup-token",updatedAt:"fixture"} as any,pending:[]};});
 const controller=new ClaudeSetupTokens({lock,metadata:()=>({revision:1}) as any,transport:()=>transport,commit});
 const start=()=>controller.operation(owner,{operation:"start",profile:null,revision:1});
 return {owner,lock,transport,commit,controller,start,set:(v:{current?:boolean;alive?:boolean;value?:string|null;code?:number;failClose?:boolean})=>{if(v.current!==undefined)current=v.current;if(v.alive!==undefined)alive=v.alive;if(v.value!==undefined)value=v.value;if(v.code!==undefined)code=v.code;if(v.failClose!==undefined)failClose=v.failClose;}};
}
it("reuses Connect-account controls, joins duplicate starts and commits once after private transport cleanup",async()=>{
 vi.useFakeTimers();const r=rig(),view=await r.start();expect(view.login.phase).toBe("code");expect(view.login.url).toContain("claude.ai");
 expect((await r.start()).login.id).toBe(view.login.id);expect(r.transport.start).toHaveBeenCalledOnce();
 await r.controller.operation(r.owner,{operation:"input",id:view.login.id,revision:view.login.revision,action:{kind:"code",value:"one-time-code"}});
 r.set({alive:false,value:secret});await vi.advanceTimersByTimeAsync(500);
 const done=await r.controller.operation(r.owner,{operation:"read",id:view.login.id});expect(done.login.phase).toBe("done");expect(done.credential?.revision).toBe(2);
 expect(JSON.stringify(done)).not.toContain(secret);expect(r.commit).toHaveBeenCalledOnce();expect(r.transport.close.mock.invocationCallOrder[0]).toBeLessThan(r.commit.mock.invocationCallOrder[0]!);expect(r.lock.isHeld).toBe(false);
 await r.controller.operation(r.owner,{operation:"read",id:view.login.id});expect(r.commit).toHaveBeenCalledOnce();
});
it.each(["cancel","revoked","expired","failed-exit","no-token","cleanup"])("%s never commits and removes private resources, retaining a lock on failed cleanup",async mode=>{
 vi.useFakeTimers();const r=rig(),v=await r.start();r.set({value:secret});
 if(mode==="cleanup")r.set({alive:false,failClose:true});
 if(mode==="failed-exit")r.set({alive:false,code:1});
 if(mode==="no-token")r.set({alive:false,value:null});
 if(mode==="revoked")r.set({current:false});
 if(mode==="cancel")await r.controller.operation(r.owner,{operation:"cancel",id:v.login.id});
 else await vi.advanceTimersByTimeAsync(mode==="expired"?600_001:500);
 expect(r.commit).not.toHaveBeenCalled();expect(r.transport.close).toHaveBeenCalled();expect(r.lock.isHeld).toBe(mode==="cleanup");
 if(mode!=="revoked")expect((await r.controller.operation(r.owner,{operation:"read",id:v.login.id})).login.phase).toBe("failed");
});
it("refuses cross-session control, stale profile revision, shared-lock collisions and stale actions",async()=>{
 const r=rig();await expect(r.controller.operation(r.owner,{operation:"start",profile:null,revision:0})).rejects.toThrow("conflict");
 const claim=r.lock.tryClaim("account","claude-code");const busy=await r.start();expect(busy.login.reason).toBe("busy");expect(r.transport.start).not.toHaveBeenCalled();r.lock.release(claim);
 const view=await r.start();await expect(r.controller.operation({...r.owner,handle:"another-session"},{operation:"cancel",id:view.login.id})).rejects.toThrow("session-changed");
 await expect(r.controller.operation(r.owner,{operation:"input",id:view.login.id,revision:view.login.revision+1,action:{kind:"code",value:"stale"}})).rejects.toThrow("conflict");await r.controller.close();
});
it("a replaced shared claim during private cleanup cannot endorse a vault write",async()=>{
 vi.useFakeTimers();const r=rig();await r.start();r.set({alive:false,value:secret});
 r.transport.close.mockImplementation(async()=>{r.lock.release(r.lock.heldFor("claude-code"));r.lock.tryClaim("web","claude-code");});
 await vi.advanceTimersByTimeAsync(500);expect(r.commit).not.toHaveBeenCalled();await r.controller.close();
});
it("private output never invokes pane capture, waits for the FIFO completion marker, consumes once and removes scratch",async()=>{
 let options:any,alive=true;
 const native:any={start:vi.fn(async(v:any)=>{options=v;}),capture:vi.fn(async()=>{throw Error("raw capture forbidden");}),paneStatus:vi.fn(async()=>({alive,exitCode:0})),sendInput:vi.fn(async()=>{}),kill:vi.fn(async()=>{})};
 const transport=createClaudeSetupTokenTransport({native,env:{PATH:"/usr/bin",HOME:"/owner",ANTHROPIC_API_KEY:"ambient",CLAUDE_CODE_OAUTH_TOKEN:"ambient",CLAUDE_CONFIG_DIR:"/owner/config"}});
 await transport.start({argv:["claude","auth","login"]},new AbortController().signal);
 expect(options.privateOutput).toBe(true);expect(options.command).toContain("env -i");expect(options.command).toContain("claude setup-token");expect(options.command).not.toContain("ambient");expect(options.command).not.toContain("/owner");
 options.onOutput(Buffer.from("https://claude.ai/oauth/authorize?code=true\nPaste code here if prompted >\n"+secret.slice(0,19)));
 expect(await transport.capture()).not.toContain(secret.slice(0,19));options.onOutput(Buffer.from(secret.slice(19)+"\n"));alive=false;
 expect((await transport.status()).alive).toBe(true);expect(transport.takeToken()).toBeNull();
 const marker=options.command.match(/agend-end-[a-f0-9]{32}/)[0];options.onOutput(Buffer.from(marker+":0\n"));
 expect((await transport.status()).alive).toBe(false);expect(await transport.capture()).toBe("");expect(transport.takeToken()).toBe(secret);expect(transport.takeToken()).toBeNull();expect(native.capture).not.toHaveBeenCalled();
 await transport.close();expect(native.kill).toHaveBeenCalledWith(options.socket);expect(existsSync(options.cwd)).toBe(false);
});
