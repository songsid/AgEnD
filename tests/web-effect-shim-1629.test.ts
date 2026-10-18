import { afterEach, describe, expect, it, vi } from "vitest";
import vm from "node:vm";
import { request } from "node:http";
import type { Server } from "node:http";
import { buildEffectShim, createPreviewListener, previewEffectResponse, previewFrameResponse } from "../src/web-preview.js";
import { EFFECT_MAX_BYTES, effectWorkerSource } from "../src/web-effect-worker.js";

vi.mock("node:child_process", () => {
  const denied = () => { throw new Error("process launch forbidden in effect tests"); };
  return { spawn: denied, spawnSync: denied, exec: denied, execSync: denied, execFile: denied, execFileSync: denied };
});
const BOOT = "a".repeat(32), ORIGINS = ["http://127.0.0.1:19280", "https://dashboard.example"];
const render = () => ({v:1,type:"render",ch:"0123456789abcdef",code:"agend.ready()",params:{},instance:"fixture",width:64,height:64,dpr:1,assets:[] as unknown[]});
function documentHarness(options: { sameListener?: boolean; unsupported?: boolean; noOffscreen?:boolean; bitmap?: () => Promise<unknown> } = {}) {
  const body = buildEffectShim(BOOT,ORIGINS,options.sameListener), script=body.slice(body.indexOf("<script>")+8,body.lastIndexOf("</script>"));
  class DataEvent { constructor(readonly value: unknown) {} get data() {return this.value;} }
  const listeners=new Map<string,Set<(e:any)=>unknown>>(), timers=new Map<number,()=>void>(), delays=new Map<number,number>(), channels:any[]=[], workers:any[]=[], urls:any[]=[], revoked:string[]=[];
  const bitmap={width:1,height:1,close:vi.fn()}, canvas={width:0,height:0,transferControlToOffscreen:vi.fn(()=>({offscreen:true}))};
  function port() {const callbacks:Array<(e:any)=>unknown>=[];return {postMessage:vi.fn(),start:vi.fn(),close:vi.fn(),addEventListener:vi.fn((_t:string,fn:(e:any)=>unknown)=>callbacks.push(fn)),callbacks};}
  class Channel {port1=port();port2=port();constructor(){channels.push(this);}}
  class Worker {postMessage=vi.fn();terminate=vi.fn();callbacks=new Map();constructor(readonly url:string){workers.push(this);}addEventListener(t:string,fn:()=>void){this.callbacks.set(t,fn);}}
  const parent={postMessage:vi.fn()}, host=port(), doc={querySelector:vi.fn(()=>canvas),createElement:vi.fn(()=>{throw Error("no DOM effect nodes allowed");})};
  let timer=0,clock=0;
  const win:any={parent,document:doc,MessageEvent:DataEvent,TextEncoder,Blob,Uint8Array,performance:{now:()=>clock},HTMLCanvasElement:class{},OffscreenCanvas:options.noOffscreen?undefined:class{},Worker:options.unsupported?undefined:Worker,MessageChannel:Channel,
    location:{href:ORIGINS[0]+"/effect-bootstrap"},
    URL:Object.assign(URL.bind(null),{createObjectURL:(b:Blob)=>{urls.push(b);return "blob:fixture/"+urls.length;},revokeObjectURL:(s:string)=>revoked.push(s)}),
    createImageBitmap:options.bitmap??(async()=>bitmap),
    setTimeout:(fn:()=>void,ms:number)=>{timers.set(++timer,fn);delays.set(timer,ms);return timer;},clearTimeout:(id:number)=>{timers.delete(id);delays.delete(id);},
    addEventListener:(t:string,fn:(e:any)=>unknown)=>{if(!listeners.has(t))listeners.set(t,new Set());listeners.get(t)!.add(fn);},removeEventListener:(t:string,fn:(e:any)=>unknown)=>listeners.get(t)?.delete(fn)};
  win.HTMLCanvasElement.prototype.transferControlToOffscreen=()=>{};win.window=win;
  const context=vm.createContext(win);vm.runInContext(script,context);
  const value=(d:unknown)=>vm.runInContext(`(${JSON.stringify(d)})`,context);
  const send=async(d:unknown=render(),opts:{source?:unknown;origin?:string;ports?:unknown[];transform?:(d:any,copy:(value:unknown)=>any)=>void}={})=>{
    const payload=value(d);opts.transform?.(payload,value);for(const a of payload.assets??[])if(a&&Array.isArray(a.bytes))a.bytes=new Uint8Array(a.bytes);
    const event=new DataEvent(payload) as any;event.source="source" in opts?opts.source:parent;event.origin=opts.origin??ORIGINS[0];event.ports=opts.ports??[host];
    for(const fn of [...listeners.get("message")??[]])await fn(event);
  };
  const emit=(p:ReturnType<typeof port>,d:unknown)=>{for(const fn of p.callbacks)fn(new DataEvent(value(d)));};
  return {body,win,context,parent,host,canvas,doc,channels,workers,urls,revoked,bitmap,timers,delays,send,emit,value,
    tick:(ms:number)=>{clock+=ms;},stop:()=>{for(const fn of listeners.get("pagehide")??[])fn({});}};
}

describe("#1629 Canvas Worker document boundary",()=>{
  it("#2118 same-listener mode binds its actual URL origin, not the legacy origin array",async()=>{
    const h=documentHarness({sameListener:true});
    await h.send(render(),{origin:ORIGINS[1]}); await h.send(render(),{origin:"null"}); await h.send(render(),{source:{}});
    expect(h.workers).toHaveLength(0);
    await h.send(); expect(h.workers).toHaveLength(1); expect(h.host.start).toHaveBeenCalledOnce();
  });
  it("announces one exact boot ready and contains only trusted script + canvas",()=>{
    const h=documentHarness();expect(h.parent.postMessage.mock.calls).toEqual([[{v:1,type:"ready",ch:null,boot:BOOT},"*"]]);
    expect(h.body.match(/<canvas/g)).toHaveLength(1);expect(h.body).not.toContain("DOMParser");expect(h.body).not.toContain("document.write");expect(h.win.agend).toBeUndefined();
  });
  it.each([
    ["other window",{source:{}}],["opaque parent",{origin:"null"}],["other origin",{origin:"https://evil.example"}],["suffix origin",{origin:ORIGINS[1]+".evil"}],["no port",{ports:[]}],["two ports",{ports:[{},{}]}],
  ])("refuses %s without Worker or DOM effects",async(_n,opts)=>{
    const h=documentHarness();await h.send(render(),opts);expect(h.workers).toHaveLength(0);expect(h.doc.createElement).not.toHaveBeenCalled();expect(h.host.start).not.toHaveBeenCalled();
  });
  it.each([
    ["HTML",{v:1,type:"render",ch:"0123456789abcdef",html:"<input autofocus>"}],
    ["extra field",{...render(),html:"x"}],["version",{...render(),v:2}],["channel",{...render(),ch:"bad"}],
    ["oversize code",{...render(),code:"x".repeat(EFFECT_MAX_BYTES+1)}],["multibyte",{...render(),code:"界".repeat(350000)}],
    ["oversize geometry",{...render(),width:4096,height:4096}],["NaN-like geometry",{...render(),height:null}],
    ["params object",{...render(),params:{x:{bad:true}}}],["params key",{...render(),params:{Constructor:true}}],
    ["too many params",{...render(),params:Object.fromEntries(Array.from({length:17},(_,i)=>["p"+i,true]))}],
    ["asset path",{...render(),assets:[{name:"../x.png",mime:"image/png",bytes:[1]}]}],["CW1 asset name",{...render(),assets:[{name:"assets/X.png",mime:"image/png",bytes:[1]}]}],
    ["asset MIME",{...render(),assets:[{name:"assets/x.png",mime:"image/svg+xml",bytes:[1]}]}],
    ["duplicate asset",{...render(),assets:Array(2).fill({name:"assets/x.png",mime:"image/png",bytes:[1]})}],
  ])("refuses invalid %s without consuming a later valid render",async(_n,data)=>{
    const h=documentHarness();await h.send(data);expect(h.workers).toHaveLength(0);await h.send();expect(h.workers).toHaveLength(1);
  });
  it("refuses structured-clone BigInt params before serialization, without an uncaught rejection",async()=>{
    const h=documentHarness();await expect(h.send(render(),{transform:d=>{d.params.x=1n;}})).resolves.toBeUndefined();expect(h.workers).toHaveLength(0);await h.send();expect(h.workers).toHaveLength(1);
  });
  it("transfers canvas/bitmaps and resolved params only to Worker, never document JS",async()=>{
    const h=documentHarness();await h.send({...render(),params:{density:3},assets:[{name:"assets/x.png",mime:"image/png",bytes:[137,80]}]});
    expect(h.workers).toHaveLength(1);expect(h.doc.createElement).not.toHaveBeenCalled();expect(h.canvas.width).toBe(64);
    const [init,transfer]=h.workers[0].postMessage.mock.calls[0];expect(init.params).toEqual({density:3});expect(init.assets).toEqual([{name:"assets/x.png",bitmap:h.bitmap}]);expect(transfer).toHaveLength(3);
    expect(await h.urls[0].text()).toBe(render().code);expect(await h.urls[1].text()).toBe(effectWorkerSource());expect(init).not.toHaveProperty("html");
    await h.send({...render(),code:"evil()"});expect(h.workers).toHaveLength(1);
  });
  it("the host sees exactly one ready; all other inbound messages have zero effects",async()=>{
    const h=documentHarness();await h.send();const link=h.channels[0].port1;
    const ignored=[null,{},[],{type:"focus"},{type:"ready",extra:true},{type:"frame-time",ms:0},{type:"pong"},{type:"resize",height:9}];
    for(const d of ignored)h.emit(link,d);expect(h.host.postMessage).not.toHaveBeenCalled();expect(h.workers[0].terminate).not.toHaveBeenCalled();expect(h.timers.size).toBe(1);
    h.emit(link,{type:"ready"});h.emit(link,{type:"ready"});for(const d of ignored)h.emit(link,d);
    expect(h.host.postMessage.mock.calls).toEqual([[{type:"ready"}]]);expect(h.timers.size).toBe(0);expect(h.workers[0].callbacks.has("message")).toBe(false);
  });
  it("filters content-bearing and sibling signals on the trusted send path",async()=>{
    const h=documentHarness();await h.send();const link=h.channels[0].port1;
    h.emit(h.host,{v:1,type:"state",ts:1,instance:"fixture",state:"working"});
    for(const d of [{v:1,type:"state",ts:1,instance:"other",state:"working"},{v:1,type:"reply",ts:1,text:"secret"},{v:1,type:"fleet",ts:1,counts:{}}])h.emit(h.host,d);
    expect(link.postMessage.mock.calls).toEqual([[{v:1,type:"state",ts:1,instance:"fixture",state:"working"}]]);
  });
  it.each(["deadline","pagehide","error","messageerror"])("%s tears down the Worker, port and blob URLs",async(reason)=>{
    const h=documentHarness();await h.send();if(reason==="deadline")for(const fn of [...h.timers.values()])fn();else if(reason==="pagehide")h.stop();else h.workers[0].callbacks.get(reason)();
    expect(h.workers[0].terminate).toHaveBeenCalledOnce();expect(h.host.close).toHaveBeenCalledOnce();expect(h.channels[0].port1.close).toHaveBeenCalledOnce();expect(h.revoked).toHaveLength(2);
    h.emit(h.channels[0].port1,{type:"ready"});expect(h.host.postMessage).not.toHaveBeenCalled();h.stop();expect(h.workers[0].terminate).toHaveBeenCalledOnce();
  });
  it("unsupported Worker fails closed without evaluating source",async()=>{
    const h=documentHarness({unsupported:true});await h.send();expect(h.workers).toHaveLength(0);expect(h.host.close).toHaveBeenCalledOnce();expect(h.doc.createElement).not.toHaveBeenCalled();
  });
  it.each([[0,1],[4097,1],[1,4097],[4096,4096]])("refuses a decoded bitmap outside the size bound (%s × %s)",async(width,height)=>{
    const h=documentHarness();Object.assign(h.bitmap,{width,height});await h.send({...render(),assets:[{name:"assets/x.png",mime:"image/png",bytes:[1]}]});
    expect(h.workers).toHaveLength(0);expect(h.bitmap.close).toHaveBeenCalledOnce();expect(h.host.close).toHaveBeenCalledOnce();
  });
  it("decoder failure never falls back to document code",async()=>{
    const h=documentHarness({bitmap:async()=>{throw Error("bad image");}});await h.send({...render(),assets:[{name:"assets/x.png",mime:"image/png",bytes:[1]}]});expect(h.workers).toHaveLength(0);expect(h.host.close).toHaveBeenCalledOnce();expect(h.doc.createElement).not.toHaveBeenCalled();
  });
  it("late bitmap decode after disposal never creates a Worker",async()=>{
    let finish!:(value:unknown)=>void;const pending=new Promise(resolve=>finish=resolve);const h=documentHarness({bitmap:()=>pending});
    const sent=h.send({...render(),assets:[{name:"assets/x.png",mime:"image/png",bytes:[1]}]});await Promise.resolve();h.stop();finish(h.bitmap);await sent;
    expect(h.bitmap.close).toHaveBeenCalledOnce();expect(h.workers).toHaveLength(0);
  });
  it("late decode cannot beat an overdue but undelivered startup timer",async()=>{
    let finish!:(value:unknown)=>void;const pending=new Promise(resolve=>finish=resolve);const h=documentHarness({bitmap:()=>pending});
    const sent=h.send({...render(),assets:[{name:"assets/x.png",mime:"image/png",bytes:[1]}]});await Promise.resolve();h.tick(10001);finish(h.bitmap);await sent;
    expect(h.bitmap.close).toHaveBeenCalledOnce();expect(h.workers).toHaveLength(0);expect(h.host.close).toHaveBeenCalledOnce();
  });
  it("overdue ready cannot beat the startup timer",async()=>{
    const h=documentHarness();await h.send();h.tick(10001);h.emit(h.channels[0].port1,{type:"ready"});
    expect(h.host.postMessage).not.toHaveBeenCalled();expect(h.workers[0].terminate).toHaveBeenCalledOnce();
  });
  it("escapes boot/origin source delimiters",()=>{
    const html=buildEffectShim("</script><script>evil()</script>",["https://example/</script>"]);
    expect(html.match(/<script>/g)).toHaveLength(1);expect(html.match(/<\/script>/g)).toHaveLength(1);
  });
});

function workerHarness() {
  class DataEvent {constructor(readonly value:unknown){}get data(){return this.value;}}
  const listeners=new Set<(e:unknown)=>void>(), tasks:Array<()=>void>=[], callbacks:Array<(e:unknown)=>void>=[], post=vi.fn(), close=vi.fn();
  const port={postMessage:post,start:vi.fn(),addEventListener:(_t:string,fn:(e:unknown)=>void)=>callbacks.push(fn)};
  const win:any={performance:{now:()=>0},MessageEvent:DataEvent,Worker:function(){},SharedWorker:function(){},setTimeout:(fn:()=>void)=>{tasks.push(fn);return tasks.length;},importScripts:vi.fn(),close,addEventListener:(_t:string,fn:(e:unknown)=>void)=>listeners.add(fn),removeEventListener:(_t:string,fn:(e:unknown)=>void)=>listeners.delete(fn)};
  win.self=win;const load=win.importScripts;const context=vm.createContext(win);vm.runInContext(effectWorkerSource(),context);
  const value=(d:unknown)=>vm.runInContext(`(${JSON.stringify(d)})`,context);
  const d={port,canvas:{kind:"offscreen"},codeUrl:"blob:code",assets:[],params:value({density:2}),instance:"fixture"};
  for(const fn of [...listeners])fn(new DataEvent(d));
  const flush=()=>{while(tasks.length)tasks.shift()!();};
  return {win,context,post,close,load,tasks,flush,callbacks,event:(d:unknown)=>callbacks.forEach(fn=>fn(new DataEvent(value(d))))};
}
describe("#1629 trusted Worker bootstrap",()=>{
  it("exposes a frozen Canvas facade, no port, and imports source only in a later task",()=>{
    const h=workerHarness();expect(h.load).not.toHaveBeenCalled();expect(Object.keys(h.win.agend).sort()).toEqual(["asset","canvas","frame","on","params","ready"]);expect(Object.isFrozen(h.win.agend)).toBe(true);expect(Object.isFrozen(h.win.agend.params)).toBe(true);expect(h.win.agend.asset("__proto__")).toBeUndefined();
    expect(h.win.importScripts).toBeUndefined();expect(Object.getOwnPropertyDescriptor(h.win,"agend")).toMatchObject({writable:false,configurable:false});expect(h.win.document).toBeUndefined();expect(h.win.Worker).toBeUndefined();expect(h.win.SharedWorker).toBeUndefined();h.flush();expect(h.load.mock.calls).toEqual([["blob:code"]]);
    h.win.agend.ready();h.win.agend.ready();expect(h.post.mock.calls).toEqual([[{type:"ready"}]]);
  });
  it("native getter and scheduler are captured before effect code; callbacks run outside the port event",()=>{
    const h=workerHarness();h.flush();h.win.calls=0;h.win.received=[];
    vm.runInContext(`Object.defineProperty(MessageEvent.prototype,'data',{get(){calls++;return {v:1,type:'reply',ts:1,text:'secret'}}});self.setTimeout=function(fn){fn()};agend.on('reply',e=>received.push(e));`,h.context);
    h.event({v:1,type:"reply",ts:1,instance:"fixture"});expect(h.win.received).toHaveLength(0);h.flush();expect(h.win.received).toEqual([{v:1,type:"reply",ts:1,instance:"fixture"}]);expect(h.win.calls).toBe(0);
    h.event({v:1,type:"reply",ts:1,text:"secret"});h.flush();expect(h.win.received).toHaveLength(1);
  });
  it("failed user script closes the Worker with no extra host protocol",()=>{
    const h=workerHarness();h.load.mockImplementation(()=>{h.win.close=()=>{};throw Error("bad script");});h.flush();expect(h.close).toHaveBeenCalledOnce();expect(h.post).not.toHaveBeenCalled();
  });
});
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("scratch HTTP server did not bind");
  return address.port;
}
function get(port: number, path: string, host = `127.0.0.1:${port}`, method = "GET") {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { Host: host, Cookie: "do-not-use=secret", "X-Forwarded-Host": "attacker.example" } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); req.end();
  });
}

describe("#1629 local-only /effect route", () => {
  it("changes only the blob Worker/script directives; keeps all other preview headers", () => {
    const effect = previewEffectResponse(BOOT, ORIGINS), frame = previewFrameResponse(BOOT, ORIGINS);
    expect({ ...effect.headers, "Content-Length": "ignored", "Content-Security-Policy": "checked below" }).toEqual({ ...frame.headers, "Content-Length": "ignored", "Content-Security-Policy": "checked below" });
    expect(effect.headers["Content-Security-Policy"]).toBe(frame.headers["Content-Security-Policy"]!.replace("script-src 'unsafe-inline'", "script-src 'unsafe-inline' blob:").replace("worker-src 'none'", "worker-src blob:"));
    const directives=String(effect.headers["Content-Security-Policy"]).split(";").map(value=>value.trim());
    expect(directives).toContain("worker-src blob:");expect(directives).toContain("script-src 'unsafe-inline' blob:");expect(directives).not.toContain("worker-src 'none'");
    expect(Number(effect.headers["Content-Length"])).toBe(effect.body.length);
    expect(effect.headers["Content-Security-Policy"]).toContain("sandbox allow-scripts");
    expect(effect.headers["Content-Security-Policy"]).not.toContain("allow-same-origin");
    for (const directive of ["connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'"]) expect(effect.headers["Content-Security-Policy"]).toContain(directive);
  });

  it("serves exact GET only after Host admission; public extraOrigins widen /frame alone", async () => {
    let publicOrigin = "https://public.example";
    const listener = createPreviewListener({ settings: { enabled: true, port: 0, origin: null }, healthPort: 19280, config: {}, bootId: BOOT, extraOrigins: () => [publicOrigin] });
    const port = await listen(listener.server);
    const effect = await get(port, "/effect");
    expect(effect.status).toBe(200);
    expect(effect.body).toContain("<title>Effect</title>");
    expect(effect.headers["set-cookie"]).toBeUndefined();
    expect(effect.body).not.toContain("secret");
    expect(effect.body).not.toContain(publicOrigin);
    expect(effect.headers["content-security-policy"]).not.toContain(publicOrigin);
    expect((await get(port, "/frame")).headers["content-security-policy"]).toContain(publicOrigin);
    publicOrigin = "https://next-public.example";
    expect((await get(port, "/frame")).headers["content-security-policy"]).toContain(publicOrigin);
    expect((await get(port, "/effect")).headers["content-security-policy"]).not.toContain(publicOrigin);
    expect((await get(port, "/effect", "attacker.example")).status).toBe(403);
    for (const path of ["/effect?x=1", "/effect/", "/%65ffect"]) expect((await get(port, path)).status).toBe(404);
    for (const method of ["POST", "HEAD", "OPTIONS"]) expect((await get(port, "/effect", undefined, method)).status).toBe(404);
  });

  it("keeps the public-preview gateway /frame-only", async () => {
    const { createPublicPreviewGateway } = await import("../src/public-preview.js");
    const gateway = createPublicPreviewGateway({ exposureId: "private-test", dashboardOrigin: () => "https://dashboard.trycloudflare.com", isCurrent: () => true, bootId: BOOT });
    gateway.setHost("preview.trycloudflare.com");
    const port = await listen(gateway.server);
    expect((await get(port, "/effect", "preview.trycloudflare.com")).status).toBe(404);
    expect((await get(port, "/frame", "preview.trycloudflare.com")).status).toBe(200);
  });
});


const badSignals=[
 {v:1,type:"state",ts:1,state:"private-secret"},{v:1,type:"theme",ts:1,mode:"private-secret"},
 {v:1,type:"pointer",ts:1,kind:"private-secret",x:1,y:1,buttons:0},
 {v:1,type:"env",ts:1,width:64,height:64,dpr:1,quality:"private-secret"},
 {v:1,type:"reply",ts:-1},
 {v:1,type:"pointer",ts:1,kind:"move",x:1,y:1,buttons:0,dx:10001},
];
describe("#1892 r2 signal and resource controls",()=>{
 it.each(badSignals)("rejects invalid content-free signal %j in both realms",async data=>{
  const h=documentHarness();await h.send();h.emit(h.host,data);expect(h.channels[0].port1.postMessage).not.toHaveBeenCalled();
  h.emit(h.host,{v:1,type:"reply",ts:0});expect(h.channels[0].port1.postMessage).toHaveBeenCalledOnce();
  const w=workerHarness();w.flush();const received=vi.fn();for(const kind of ["state","theme","pointer","env","reply"])w.win.agend.on(kind,received);
  w.event(data);w.flush();expect(received).not.toHaveBeenCalled();w.event({v:1,type:"reply",ts:0});w.flush();expect(received).toHaveBeenCalledOnce();
 });
 it("arms exactly the ten-second startup timeout",async()=>{const h=documentHarness();await h.send();expect([...h.delays.values()]).toEqual([10000]);});
 it("requires one actual port, not two otherwise valid ports",async()=>{const h=documentHarness();await h.send(render(),{ports:[h.host,h.host]});expect(h.workers).toHaveLength(0);await h.send();expect(h.workers).toHaveLength(1);});
 it("bounds combined code and asset bytes",async()=>{const h=documentHarness();const d={...render(),code:"x".repeat(600000),assets:[{name:"assets/x.png",mime:"image/png",bytes:new Array(600000).fill(0)}]};await h.send(d);expect(h.workers).toHaveLength(0);});
 it.each([null,7,"", "x".repeat(129)])("refuses invalid instance %j except the owner-level null",async instance=>{const h=documentHarness();await h.send({...render(),instance});expect(h.workers).toHaveLength(instance===null?1:0);});
 it("refuses oversize strings, nonfinite params and too many assets",async()=>{
  for(const transform of [(d:any)=>{d.params.x="x".repeat(129);},(d:any)=>{d.params.x=Infinity;},(d:any,copy:(value:unknown)=>any)=>{d.assets=copy(Array.from({length:17},(_,i)=>({name:`assets/p${i}.png`,mime:"image/png",bytes:[]})));}]){const h=documentHarness();await h.send(render(),{transform});expect(h.workers).toHaveLength(0);await h.send();expect(h.workers).toHaveLength(1);}
 });
 it("refuses sparse arrays, extra asset fields and non-byte payloads",async()=>{
  for(const transform of [(d:any,copy:(value:unknown)=>any)=>{d.assets=copy([null]);delete d.assets[0];},(d:any,copy:(value:unknown)=>any)=>{d.assets=copy([{name:"assets/x.png",mime:"image/png",bytes:[],extra:1}]);},(d:any,copy:(value:unknown)=>any)=>{d.assets=copy([{name:"assets/x.png",mime:"image/png",bytes:{0:1,length:1}}]);}]){const h=documentHarness();await h.send(render(),{transform});expect(h.workers).toHaveLength(0);await h.send();expect(h.workers).toHaveLength(1);}
 });
 it("fails closed without OffscreenCanvas",async()=>{const h=documentHarness({noOffscreen:true});await h.send();expect(h.workers).toHaveLength(0);expect(h.host.close).toHaveBeenCalledOnce();});
 it("caps callbacks at thirty-two per event kind",()=>{const h=workerHarness();h.flush();const call=vi.fn();for(let i=0;i<33;i++)h.win.agend.on("reply",call);h.event({v:1,type:"reply",ts:0});h.flush();expect(call).toHaveBeenCalledTimes(32);});
 it("bounds total decoded bitmap pixels, with an exact-limit positive control",async()=>{
  for(const [count,expected] of [[2,1],[3,0]]){const bitmaps:any[]=[];const h=documentHarness({bitmap:async()=>{const bitmap={width:2048,height:2048,close:vi.fn()};bitmaps.push(bitmap);return bitmap;}});await h.send({...render(),assets:Array.from({length:count},(_,i)=>({name:`assets/p${i}.png`,mime:"image/png",bytes:[1]}))});expect(h.workers).toHaveLength(expected);if(expected===0)expect(bitmaps.every(b=>b.close.mock.calls.length===1)).toBe(true);}
 });
});
