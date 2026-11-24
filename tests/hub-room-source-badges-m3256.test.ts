import { afterEach, beforeAll, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let thread:any, members:any, i18n:any, source:any, shared:any, toasts:any;
const pages:AppPage[]=[];
beforeAll(async()=>{
  const p=page();
  thread=await import("/ui/js/hub-room-thread.js");
  members=await import("/ui/js/hub-room-members.js");
  source=await import("/ui/js/hub-room-source.js");
  shared=await import("/assets/chat-thread.js");
  toasts=await import("/assets/ui-toast.js");
  i18n=await import("/assets/app-i18n.js");p.restore();
});
afterEach(async()=>{for(const p of pages.splice(0)){await p.unmount();p.restore();}i18n.setLang("en",{store:false});});
const author=(kind:string,extra:any={})=>({kind,id:"source",name:"Project helper",owner:{name:"Alex"},...extra});
const view=(who:any)=>thread.toThreadMessages([{id:"m",roomId:"r",at:1,text:"Ready",author:who}],{meId:"me",ids:new Map()})[0];

it("maps explicit app and AgEnD origins without guessing from an app's name",()=>{
  expect(view(author("agent")).sourceBadge).toMatchObject({kind:"agend"});
  expect(view(author("agent")).sourceBadge.label).toBe("AgEnD agent");
  expect(view(author("agent",{agentKind:"personal"})).sourceBadge).toMatchObject({kind:"agend"});
  for(const name of ["Claude Code","Codex","Project helper"]){
    expect(view(author("person",{via:{kind:"app",id:"app",name}})).sourceBadge).toMatchObject({kind:"app"});
  }
  expect(view(author("person",{via:{kind:"agent",id:"agent",name:"Codex"}})).sourceBadge).toMatchObject({kind:"agend"});
  expect(view(author("person"))).not.toHaveProperty("sourceBadge");
  expect(view(author("person",{via:{id:"old",name:"Claude Code"}}))).not.toHaveProperty("sourceBadge");
});

it.each(["en","zh-TW"])("badges agent members while keeping people and their presence unchanged (%s)",async(lang)=>{
  const p=page();pages.push(p);
  i18n.setLang(lang,{store:false});
  await p.mount(h(members.RoomMembersPanel,{client:{},roomId:"r",detail:{me:{role:"member"},members:[
    {id:"p",kind:"person",name:"Casey",presence:"online"},
    {id:"f",kind:"agent",name:"Project helper",owner:{name:"Alex"},presence:"idle",agentKind:"fleet"},
    {id:"a",kind:"agent",name:"Personal helper",owner:{name:"Alex"},presence:"idle",agentKind:"personal"},
  ]}}));await settle(10);
  // M-3533 R2a (the design check): an agent row wears its avatar in the badge's slot — every agent's badge was the same
  // logo — and says its source by its title and accessible name; a person's row has neither avatar nor badge.
  const rows=[...p.root.querySelectorAll(".hub-member-agent .hub-member-open")] as any[];
  expect(rows.map(b=>[!!b.querySelector(".hub-agent-av"),b.querySelector("[data-room-source]")])).toEqual([[true,null],[true,null]]);
  // Each title names the owner, and a personal agent's differs from a Fleet agent's.
  expect(rows.every(b=>(b.getAttribute("title")||"").includes("Alex"))).toBe(true);
  expect(new Set(rows.map(b=>b.getAttribute("title"))).size).toBe(2);
  expect(p.root.querySelector('.hub-member:not(.hub-member-agent) [data-room-source], .hub-member:not(.hub-member-agent) .hub-agent-av')).toBeNull();
  expect(p.root.querySelectorAll('.hub-member-agent .dot.ok')).toHaveLength(2);
  const button=[...p.root.querySelectorAll(".hub-member-open")].find(b=>b.textContent?.includes("Personal helper"))!;
  expect(button.getAttribute("aria-label")).toContain(lang==="en"?"Alex's personal agent":"Alex 的個人 Agent");
  fire(button,"click");await settle(5);
  expect(p.root.querySelector(".hub-source-explanation")?.textContent).toBe(lang==="en"?"Alex's personal agent":"Alex 的個人 Agent");
});

it.each(["en","zh-TW"])("renders and explains a source without treating an app name as markup or vendor proof (%s)",async(lang)=>{
  const p=page();pages.push(p);i18n.setLang(lang,{store:false});await p.mount(h(toasts.Toasts,{}));
  const host=p.document.createElement("div");p.document.body.append(host);
  const renderer=shared.createThread(host,p.document.createElement("div"),{isUser:()=>false,t:(k:string)=>k,onEmpty:()=>{},onJump:()=>{},senderBadge:source.mountSourceAuthor});
  try{
    const appName='<img src=x onerror="bad()">',row=view(author("person",{name:"Casey",via:{kind:"app",id:"a",name:appName}}));
    renderer.render([row]);await settle(5);
    const button=host.querySelector(".hub-source-trigger")!;
    expect(host.querySelector(".sender")?.textContent).toBe(row.sender);
    expect(button.textContent).toContain(appName);expect(host.querySelector("img")).toBeNull();
    expect(button.getAttribute("aria-label")).toContain(lang==="en"?"The app gave":"App 自己提供");
    expect(button.getAttribute("title")).toBe(row.sourceBadge.label);
    fire(button,"click");await settle(5);expect([...p.root.querySelectorAll(".toast-detail")].at(-1)?.textContent).toBe(row.sourceBadge.label);
    renderer.render([view(author("agent",{agentKind:"personal"}))]);await settle(5);
    expect(host.querySelector('img[src="/assets/agend-mark.svg"]')).not.toBeNull();
    expect(host.querySelector(".hub-source-trigger")?.getAttribute("title")).toBe(lang==="en"?"Alex's personal agent":"Alex 的個人 Agent");
    renderer.render([view(author("person",{name:"Casey"}))]);await settle(5);
    expect(host.querySelector(".hub-source-trigger")).toBeNull();expect(host.querySelector(".sender")?.textContent).toBe("Casey");
  }finally{renderer.dispose(true);host.remove();}
});
