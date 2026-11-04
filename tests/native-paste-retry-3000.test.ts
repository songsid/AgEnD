/** Daemon-level native paste policy. No CLI, account, live fleet or process is started. */
import {afterEach,expect,it,vi} from "vitest";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Daemon} from "../src/daemon.js";
import {ClaudeCodeBackend} from "../src/backend/claude-code.js";
import {deriveNeedsYou} from "../src/needs-you.js";
const roots:string[]=[];afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const idle=readFileSync(join(__dirname,"fixtures/claude-2.1.293-idle-empty.pane.txt"),"utf8"),card=readFileSync(join(__dirname,"fixtures/claude-2.1.316-bash-permission-prompt.pane.txt"),"utf8");
function fixture(native=true){
 const root=mkdtempSync(join(tmpdir(),"native-paste-retry-"));roots.push(root);const backend=new ClaudeCodeBackend(root),logger={info(){},warn(){},error(){},debug(){},child(){return this;}};
 const daemon:any=new Daemon("private-paste",{working_directory:root,backend:"claude-code",log_level:"silent"}as never,root,true,backend,undefined,logger as never);
 const pane={getWindowId:()=>"@owned",capturePane:vi.fn(async()=>idle),pasteBuffer:vi.fn(async(_text:string,_opts?:unknown)=>true),lastInputWasNotSent:()=>true,getLastPasteError:()=>"Pane changed after observation; input was not sent"};daemon.tmux=pane;if(native)daemon.nativePaneLifecycle={};return{daemon,pane,backend};
}
it("a positive zero-input paste ACK re-observes then stops at exactly one successful paste",async()=>{
 const f=fixture();f.pane.pasteBuffer.mockResolvedValueOnce(false);expect(await f.daemon.sendDeliveryPaste("unique" )).toBe(true);expect(f.pane.pasteBuffer).toHaveBeenCalledTimes(2);expect(f.pane.capturePane).toHaveBeenCalledTimes(2);
 for(const call of f.pane.pasteBuffer.mock.calls)expect(call[1]).toMatchObject({guard:expect.any(Function),proof:{kind:"composer",screen:idle}});
 expect(f.pane.pasteBuffer.mock.results.filter(r=>r.type==="return")).toHaveLength(2);
});
it.each(["unknown","lost","nonzero","partial"])("a %s ACK never authorizes another paste and surfaces in Needs-you",async kind=>{
 const f=fixture();f.pane.pasteBuffer.mockResolvedValue(false);
 if(kind==="unknown"||kind==="lost")f.pane.lastInputWasNotSent=()=>false;
 if(kind==="lost")f.pane.getLastPasteError=()=>"Pane input outcome is unconfirmed; reconnect and inspect before retrying";
 if(kind==="nonzero")f.pane.getLastPasteError=()=>"A different refusal";
 if(kind==="partial")f.pane.pasteBuffer.mockRejectedValue(Error("partial write"));
 expect(await f.daemon.sendDeliveryPaste("unique")).toBe(false);expect(f.pane.pasteBuffer).toHaveBeenCalledOnce();
 expect(deriveNeedsYou({prompts:[],deliveries:[],instances:[{name:"private-paste",nativeDeliveryHold:f.daemon.nativeDeliveryHold()}],ownerOf:()=>undefined})).toContainEqual(expect.objectContaining({reason:"delivery_uncertain",instance:"private-paste"}));
});
it("positive paste refusals have a five-attempt bound",async()=>{const f=fixture();f.pane.pasteBuffer.mockResolvedValue(false);expect(await f.daemon.sendDeliveryPaste("unique")).toBe(false);expect(f.pane.pasteBuffer).toHaveBeenCalledTimes(5);expect(f.pane.capturePane).toHaveBeenCalledTimes(5);expect(f.daemon.nativeDeliveryHold()).not.toBeNull();});
it("a retry observation after two seconds cannot authorize a paste",async()=>{
 const f=fixture();let offset=0;const now=performance.now.bind(performance);vi.spyOn(performance,"now").mockImplementation(()=>now()+offset);f.pane.pasteBuffer.mockResolvedValueOnce(false);f.pane.capturePane.mockResolvedValueOnce(idle).mockImplementationOnce(async()=>{offset=2500;return idle;});
 expect(await f.daemon.sendDeliveryPaste("unique")).toBe(false);expect(f.pane.pasteBuffer).toHaveBeenCalledOnce();
});
it("a recognised dialog arriving after a positive refusal vetoes the next paste",async()=>{const f=fixture();f.pane.pasteBuffer.mockImplementationOnce(async()=>{f.pane.capturePane.mockResolvedValue(card);return false;});expect(await f.daemon.sendDeliveryPaste("unique")).toBe(false);expect(f.pane.pasteBuffer).toHaveBeenCalledOnce();expect(f.daemon.nativeDeliveryHold()).not.toBeNull();});
it.each(["pane","native","window","spawn","fence","backend","stop","caller"])("a changed %s owner cannot receive a retry",async kind=>{
 const f=fixture();let permitted=true;f.pane.pasteBuffer.mockImplementationOnce(async()=>{if(kind==="pane")f.daemon.tmux={...f.pane};else if(kind==="native")f.daemon.nativePaneLifecycle={};else if(kind==="window")f.pane.getWindowId=()=>"@other";else if(kind==="spawn")f.daemon.spawnGeneration++;else if(kind==="fence")f.daemon.launchFenceEpoch++;else if(kind==="backend")f.daemon.backend={};else if(kind==="stop")f.daemon.deliveryWritesStopping=true;else permitted=false;return false;});
 expect(await f.daemon.sendDeliveryPaste("unique",()=>permitted)).toBe(false);expect(f.pane.pasteBuffer).toHaveBeenCalledOnce();
});
it("refused captures only retry reads, before any paste mutation",async()=>{const f=fixture();f.pane.capturePane.mockRejectedValueOnce(Error("repaint")).mockRejectedValueOnce(Error("repaint"));expect(await f.daemon.sendDeliveryPaste("unique")).toBe(true);expect(f.pane.capturePane).toHaveBeenCalledTimes(3);expect(f.pane.pasteBuffer).toHaveBeenCalledOnce();});
it("the non-native path keeps its original single paste without a native capture",async()=>{const f=fixture(false);f.pane.capturePane.mockRejectedValue(Error("must not read"));expect(await f.daemon.sendDeliveryPaste("unique")).toBe(true);expect(f.pane.pasteBuffer).toHaveBeenCalledExactlyOnceWith("unique");expect(f.pane.capturePane).not.toHaveBeenCalled();});
it("the actual write path retains a native paste refusal as uncertain without legacy window recovery",async()=>{
 const f=fixture();f.pane.pasteBuffer.mockResolvedValue(false);f.pane.lastInputWasNotSent=()=>false;
 vi.spyOn(f.daemon,"capturePaneEvidence").mockResolvedValue(null);vi.spyOn(f.daemon,"paneInTmuxMode").mockResolvedValue(false);const fail=vi.spyOn(f.daemon,"failDelivery"),recover=vi.spyOn(f.daemon,"recoverWindow");const verdict={reached:false};
 expect(await f.daemon.writeMessageToPane("unique","@owned",false,undefined,undefined,verdict)).toBe(false);expect(verdict).toMatchObject({reached:false,paneWriteStarted:true,phase:"paste",proof:"native-paste-held"});expect(fail).not.toHaveBeenCalled();expect(recover).not.toHaveBeenCalled();expect(f.pane.pasteBuffer).toHaveBeenCalledOnce();
});
it('paste exhaustion logs the final operation and retry count once, without the pasted text',async()=>{
 const f=fixture(),warn=vi.spyOn(f.daemon.logger,'warn'),details={expectedSeq:41,observedSeq:42,operationId:'private-operation',commandSequence:13,action:'input',retryCount:4};
 Object.assign(f.pane,{getLastInputDiagnostic:()=>details});f.pane.pasteBuffer.mockResolvedValue(false);
 expect(await f.daemon.sendDeliveryPaste('PRIVATE_PASTE_DIAGNOSTIC_CANARY')).toBe(false);
 expect(warn).toHaveBeenCalledExactlyOnceWith({...details,reason:'output_changed'},'Native delivery paste held by its safety check');
 expect(f.pane.pasteBuffer.mock.calls.map(call=>(call[1]as any).proof.retryCount)).toEqual([0,1,2,3,4]);expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_PASTE_DIAGNOSTIC_CANARY');
});
