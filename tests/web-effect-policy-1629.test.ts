import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EFFECT_SIGNAL_CHECK } from "../src/web-effect-worker.js";
const P = await import(new URL("../src/ui/shared/effect-policy.js", import.meta.url).href);
const workerSignal = new Function(EFFECT_SIGNAL_CHECK + ";return signal;")();
const now = 123;
const ctx = (patch = {}) => ({ enabled:true, show:true, previewReady:true, optIn:true, safe:false, publicLink:false, hidden:false, reducedMotion:false, saveData:false, constrained:false, openInstance:"own", modal:false, ...patch });
const descriptor = (key: string, patch = {}) => ({ key, id:"a".repeat(32), by:"agent", region:"chat", layer:"behind", instance:"own", order:0, visible:true, paused:false, ...patch });
const frame = {x:100,y:200,width:500,height:400};
const samples: Record<string,Record<string,unknown>> = {
  state:{state:"working"}, reply:{}, mention:{}, theme:{mode:"dark"},
  env:{width:300,height:200,dpr:1.5,quality:"normal"}, pointer:{kind:"move",x:12,y:15,buttons:1,dx:0,dy:4},
};
describe("#1629 effect signals", () => {
  it.each(Object.entries(samples))("builds only the exact %s fields without reading content", (type, values) => {
    const fields={...values};
    for (const k of ["text","author","sender","attachments","id","files","url"]) Object.defineProperty(fields,k,{enumerable:true,get(){throw Error("content read");}});
    const event=P.effectEvent(type,fields,"own",now);
    expect(event).toEqual({v:1,type,ts:now,...(["state","reply","mention"].includes(type)?{instance:"own"}:{}),...values});
    expect(P.validEffectEvent(event,"own")).toBe(true);
    expect(workerSignal(event,"own")).toBe(true);
    expect(P.maySendEffectEvent(event,{instance:"own",wants:[type]})).toBe(type!=="mention");
    expect(P.maySendEffectEvent({...event,text:"secret"},{instance:"own",wants:[type]})).toBe(false);
  });
  it("binds the exact current instance before sending and doesn't read message content",()=>{
    expect(P.effectEvent("state",{state:"idle",instance:"other"},"own",now)).toBeNull();
    const event=P.effectEvent("reply",{},"own",now);
    expect(P.maySendEffectEvent(event,{instance:"other",wants:["reply"]})).toBe(false);
    expect(P.maySendEffectEvent(event,{instance:"own",wants:[]})).toBe(false);
    expect(P.maySendEffectEvent(P.effectEvent("env",samples.env,null,now),{instance:null,wants:[]})).toBe(true);
    expect(P.effectEvent("reply",{},null,now)).toEqual({v:1,type:"reply",ts:now});
    const source=readFileSync(new URL("../src/ui/shared/effect-policy.js",import.meta.url),"utf8");
    expect(source).not.toMatch(/\.(?:text|sender|attachments|files)\b/);
  });
  it.each(["status","usage","fleet","keydown","constructor","__proto__","pong"])("doesn't expose %s to workers",type=>{
    expect(P.effectEvent(type,{},"own",now)).toBeNull();
    expect(P.validEffectEvent({v:1,type,ts:now},"own")).toBe(false);
    expect(P.maySendEffectEvent({v:1,type,ts:now},{instance:null,wants:[type]})).toBe(false);
  });
  it.each([
    ["state",{state:"secret"}], ["theme",{mode:"custom"}], ["env",{...samples.env,quality:"fast"}],
    ["pointer",{...samples.pointer,kind:"keypress"}], ["pointer",{...samples.pointer,buttons:32}],
    ["pointer",{...samples.pointer,x:-1}], ["pointer",{...samples.pointer,y:4097}], ["pointer",{...samples.pointer,dx:10001}],
    ["pointer",{...samples.pointer,dy:Infinity}], ["env",{...samples.env,width:4097}], ["env",{...samples.env,height:0}],
    ["env",{...samples.env,width:4096,height:4096}], ["env",{...samples.env,dpr:3.01}],
    ["env",{...samples.env,dpr:0.49}], ["env",{...samples.env,width:1.5}],
  ])("rejects invalid %s fields",(type,fields)=>{ expect(P.effectEvent(type,fields,"own",now)).toBeNull(); });
  it.each([-1,NaN,Infinity])("rejects invalid time %s",ts=>{expect(P.effectEvent("reply",{},"own",ts)).toBeNull();});
  it("doesn't accept extra keys or missing envelope fields at the final fence",()=>{
    const event=P.effectEvent("reply",{},"own",0);
    for(const patch of [{v:2},{ts:NaN},{ts:-1},{type:"constructor"},{instance:"other"},{command:"run"}]) expect(P.validEffectEvent({...event,...patch},"own")).toBe(false);
    expect(P.validEffectEvent({type:"reply",ts:0},"own")).toBe(false);
    expect(P.effectEvent("reply",{},"",now)).toBeNull();
    expect(P.effectEvent("reply",{},"x".repeat(129),now)).toBeNull();
  });
});
describe("#1629 global frame allocation",()=>{
  it("loads three and queues the fourth without reserving a frame",()=>{
    const rows=P.allocateEffectFrames([0,1,2,3].map(n=>descriptor(String(n),{order:n})),ctx());
    expect(rows.map((r: {verdict:string})=>r.verdict)).toEqual(["active","active","active","queued"]);
    expect(rows[3]).toMatchObject({reason:"frame_limit",queuePos:1});
    const freed=P.allocateEffectFrames([0,1,2,3].map(n=>descriptor(String(n),{order:n,paused:n===0})),ctx());
    expect(freed.map((r:{verdict:string})=>r.verdict)).toEqual(["off","active","active","active"]);
  });
  it("enforces the independent front subcap without wasting a behind slot",()=>{
    const rows=P.allocateEffectFrames([descriptor("a",{layer:"front"}),descriptor("b",{layer:"front"}),descriptor("c",{layer:"front"}),descriptor("d")],ctx());
    expect(rows.map((r:{verdict:string})=>r.verdict)).toEqual(["active","active","queued","active"]);
    expect(rows[2].reason).toBe("front_limit");
    expect(P.allocateEffectFrames([descriptor("a"),descriptor("b")],ctx({constrained:true})).map((r:{verdict:string})=>r.verdict)).toEqual(["active","queued"]);
  });
  it("allocates owner regions first in page/header/sidebar/box order, then applied chat order",()=>{
    const ds=[descriptor("chat-b",{order:2}),descriptor("box",{by:"human",region:"box"}),descriptor("sidebar",{by:"human",region:"sidebar"}),descriptor("header",{by:"human",region:"header"}),descriptor("page",{by:"human",region:"page"}),descriptor("chat-a",{order:1})];
    const rows=P.allocateEffectFrames(ds,ctx());
    expect(rows.filter((r:{verdict:string})=>r.verdict==="active").map((r:{key:string})=>r.key)).toEqual(["sidebar","header","page"]);
    expect(rows[1].queuePos).toBe(1); expect(rows[5].queuePos).toBe(2); expect(rows[0].queuePos).toBe(3);
    expect(P.allocateEffectFrames(ds,ctx({constrained:true})).find((r:{verdict:string})=>r.verdict==="active").key).toBe("page");
  });
  it.each([
    [{safe:true},"safe_mode"],[{publicLink:true},"public_link"],[{reducedMotion:true},"reduced_motion"],[{saveData:true},"save_data"],
    [{hidden:true},"hidden"],[{enabled:false},"disabled"],[{show:false},"disabled"],[{optIn:false},"preview_unavailable"],[{previewReady:false},"preview_unavailable"],
  ])("doesn't reserve frames for global refusal %o",(patch,reason)=>{
    expect(P.allocateEffectFrames([descriptor("a")],ctx(patch))[0]).toEqual({key:"a",verdict:"off",reason,queuePos:null});
  });
  it("fails closed for unknown state, offscreen/paused/closed chat and modal fronts",()=>{
    const ds=[descriptor("bad",{id:"unknown"}),descriptor("offscreen",{visible:false}),descriptor("paused",{paused:true}),descriptor("other",{instance:"other"}),descriptor("owner",{by:undefined,region:"page"}),descriptor("front",{layer:"front"}),descriptor("behind")];
    const rows=P.allocateEffectFrames(ds,ctx({modal:true}));
    expect(rows.map((r:{reason:string|null})=>r.reason)).toEqual(["unknown","offscreen","paused","closed_chat","scope","modal",null]);
    expect(P.allocateEffectFrames([descriptor("a"),descriptor("a")],ctx()).every((r:{verdict:string})=>r.verdict==="off")).toBe(true);
    expect(P.allocateEffectFrames([descriptor("a")],{}).every((r:{verdict:string})=>r.verdict==="off")).toBe(true);
    expect(P.allocateEffectFrames(Array.from({length:129},(_,n)=>descriptor(String(n))),ctx())).toEqual([]);
  });
  it.each([[{memory:4},true],[{memory:8,cores:4},true],[{memory:8,cores:8,coarse:true,width:900},true],[{memory:8,cores:8,coarse:true,width:901},false],[{},false],[{memory:0,cores:-1,width:0},false]])("classifies constrained devices %o",(s,want)=>{expect(P.constrainedDevice(s)).toBe(want);});
});
describe("#1629 unioned trust geometry",()=>{
  it("pads 8px, rounds outward and clamps to frame-local integer holes",()=>{
    const clip=P.effectTrustClip(frame,[{x:119.5,y:229.5,width:10.1,height:20.1}]);
    expect(clip).toEqual({ok:true,holes:[{x:11,y:21,width:27,height:37}],path:'path(evenodd, "M0 0H500V400H0ZM11 21H38V58H11Z")'});
    expect(P.effectTrustClip(frame,[{x:90,y:190,width:20,height:20}]).holes).toEqual([{x:0,y:0,width:18,height:18}]);
  });
  it("unions overlap instead of repainting it through evenodd",()=>{
    const rects=[{x:110,y:210,width:50,height:50},{x:130,y:230,width:50,height:50}];
    const clip=P.effectTrustClip(frame,rects);expect(clip.ok).toBe(true);
    for(let x=0;x<100;x++)for(let y=0;y<100;y++){
      const expected=rects.some(r=>x>=r.x-frame.x-8 && x<r.x+r.width-frame.x+8 && y>=r.y-frame.y-8 && y<r.y+r.height-frame.y+8);
      const count=clip.holes.filter((r:{x:number;y:number;width:number;height:number})=>x>=r.x && x<r.x+r.width && y>=r.y && y<r.y+r.height).length;
      expect(count,`${x},${y}`).toBe(expected?1:0);
    }
  });
  it("has the same union regardless of input ordering, duplicates or nested rectangles",()=>{
    const a={x:150,y:250,width:100,height:100}, b={x:180,y:280,width:10,height:10};
    expect(P.effectTrustClip(frame,[a,b,a])).toEqual(P.effectTrustClip(frame,[a,a,b]));
    const clip=P.effectTrustClip(frame,[a,b]);
    expect(clip.holes.reduce((n:number,r:{width:number;height:number})=>n+r.width*r.height,0)).toBe(116*116);
    expect(P.effectTrustClip(frame,[])).toEqual({ok:true,holes:[],path:'path(evenodd, "M0 0H500V400H0Z")'});
  });
  it.each([null, [{x:0,y:0,width:NaN,height:10}], [{x:0,y:0,width:-1,height:10}], Array(129).fill({x:0,y:0,width:1,height:1}), Array(1)])("hides for unknown trust rects %o",rects=>{expect(P.effectTrustClip(frame,rects).ok).toBe(false);});
  it("bounds frame geometry and fragmented union complexity",()=>{
    for(const patch of [{width:0},{width:4097},{height:1.5},{x:Infinity}])expect(P.effectTrustClip({...frame,...patch},[]).ok).toBe(false);
    const rects=Array.from({length:32},(_,i)=>({x:100+i*25,y:200,width:1,height:4096})).concat(Array.from({length:32},(_,i)=>({x:100,y:200+i*25,width:4096,height:1})));
    expect(P.effectTrustClip({x:100,y:200,width:4096,height:4096},rects)).toEqual({ok:false,reason:"trust_geometry_limit"});
  });
});

it("requires a known host binding and every current page gate",()=>{
  const env=P.effectEvent("env",samples.env,null,now);
  expect(P.maySendEffectEvent(env,{wants:[]})).toBe(false);
  for(const k of ["safe", "publicLink", "reducedMotion", "saveData", "hidden", "enabled", "show", "previewReady", "optIn", "constrained", "modal"]){
    expect(P.allocateEffectFrames([descriptor("a")],ctx({[k]:undefined}))[0]).toMatchObject({verdict:"off",reason:"unknown"});
  }
  expect(P.allocateEffectFrames([descriptor("a",{paused:undefined})],ctx())[0]).toMatchObject({verdict:"off",reason:"unknown"});
});

describe("#1629 final independent scope and boundary controls",()=>{
 it.each(["state","reply","mention"])("requires exact or absent scope on final %s send",type=>{
  const fields=type==="state"?{state:"working"}:{};
  const unbound=P.effectEvent(type,fields,null,now),bound=P.effectEvent(type,fields,"own",now);
  expect(P.maySendEffectEvent(unbound,{instance:"own",wants:[type]})).toBe(false);
  expect(P.maySendEffectEvent(bound,{instance:null,wants:[type]})).toBe(false);
  expect(P.maySendEffectEvent(unbound,{instance:null,wants:[type]})).toBe(type!=="mention");
  expect(P.maySendEffectEvent(bound,{instance:"own",wants:[type]})).toBe(type!=="mention");
 });
 it("rounds right and bottom outward even below a half pixel",()=>{
  expect(P.effectTrustClip(frame,[{x:119.1,y:229.1,width:10.1,height:20.1}]).holes).toEqual([{x:11,y:21,width:27,height:37}]);
 });
 it.each([{visible:undefined},{layer:"dialog"},{region:"dialog"},{order:-1},{order:0.5},{key:"x".repeat(257)}])("keeps unknown descriptor %o off",patch=>{
  expect(P.allocateEffectFrames([descriptor("a",patch)],ctx())[0].verdict).toBe("off");
 });
 it("refuses invalid current instances and admits one constrained front",()=>{
  expect(P.allocateEffectFrames([descriptor("a")],ctx({openInstance:{}}))[0].verdict).toBe("off");
  expect(P.allocateEffectFrames([descriptor("a",{layer:"front"})],ctx({constrained:true}))[0].verdict).toBe("active");
  expect(P.constrainedDevice({coarse:false,width:900,cores:8,memory:8})).toBe(false);
  expect(P.constrainedDevice({cores:0})).toBe(false);
 });
 it("bounds coordinates/clamps height and drops empty intersections",()=>{
  expect(P.effectTrustClip(frame,[{x:1e7+1,y:0,width:1,height:1}]).ok).toBe(false);
  expect(P.effectTrustClip(frame,[{x:100,y:590,width:10,height:50}]).holes).toEqual([{x:0,y:382,width:18,height:18}]);
  expect(P.effectTrustClip(frame,[{x:2000,y:2000,width:1,height:1}]).holes).toEqual([]);
  class Rect { x=0;y=0;width=10;height=10; }
  expect(P.effectTrustClip(frame,[new Rect()]).ok).toBe(false);
 });
});
