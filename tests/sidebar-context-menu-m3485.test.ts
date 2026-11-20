import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { h, page, settle, type AppPage } from './helpers/app-harness.js';
import { fire } from './helpers/mini-dom.js';
let p:AppPage, nav:any, app:any, Menu:any;
const alpha={name:'alpha',backend:'codex',status:'running'}, beta={name:'beta',backend:'claude-code',status:'running'};
let selected:string[]=[];
beforeAll(async()=>{
 p=page({url:'http://127.0.0.1:19280/ui/chat/alpha'});
 p.document.documentElement.setAttribute('data-prefs',JSON.stringify({rev:1,values:{}}));vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:404,json:async()=>({})})));
 nav=await import('/assets/instance-nav.js'); app=await import('/assets/app-store.js');
 Menu=(await import('/assets/ui-menu.js')).Menu;
});
afterEach(async()=>{await p.unmount();delete p.document.body.dataset.tier;selected=[];vi.useRealTimers();});
afterAll(()=>{p.restore();vi.unstubAllGlobals();});
function Actions({inst,context,onClose}:any){return h(Menu,{context:{...context,onClose},ownerKey:inst.name,fit:true,topLayer:true,label:'Chat actions',items:[{key:'stop',label:'Stop '+inst.name,onSelect:()=>selected.push(inst.name)}]});}
async function mount(extra:any={}){app.applyStatus({instances:[alpha,beta]});app.appStore.set({sidebarChatMenu:Actions});await p.mount(h(nav.InstanceNav,{route:{panel:'chat',instance:'alpha'},items:[alpha,beta],...extra}));await settle(4);return p.root.querySelector('[data-agent-row="beta"] a.inst') as any;}
describe('sidebar agent context interaction',()=>{
 it('opens targeted shared menu without navigation; Escape returns to row and outside closes',async()=>{
  const row=await mount();row.focus();const e=fire(row,'contextmenu',{clientX:25,clientY:80});await settle(4);
  expect(e.defaultPrevented).toBe(true);expect(p.root.querySelector('[role="menu"]')?.textContent).toContain('Stop beta');
  expect(globalThis.location.pathname).toContain('alpha');
  fire(p.root.querySelector('[role="menu"]')!,'keydown',{key:'Escape'});await settle(4);
  expect(p.root.querySelector('[role="menu"]')).toBeNull();expect(p.document.activeElement).toBe(row);
  fire(row,'contextmenu');await settle(4);fire(p.document.body,'pointerdown');await settle(4);expect(p.root.querySelector('[role="menu"]')).toBeNull();
 });
 it.each([{key:'F10',shiftKey:true},{key:'ContextMenu'}])('keyboard opens and selection targets the row: %j',async keys=>{
  const row=await mount();fire(row,'keydown',keys);await settle(4);const item=p.root.querySelector('[role="menuitem"]');expect(item).not.toBeNull();fire(item!,'click');await settle(4);expect(selected).toEqual(['beta']);
 });
 it('long press opens, cancels on movement and suppresses only its following click',async()=>{
  const row=await mount();vi.useFakeTimers({toFake:["setTimeout","clearTimeout","Date"]});
  fire(row,'pointerdown',{pointerType:'touch',pointerId:1,button:0,clientX:20,clientY:20});
  fire(row,'pointermove',{pointerType:'touch',pointerId:1,clientX:20,clientY:50});await vi.advanceTimersByTimeAsync(600);vi.useRealTimers();await settle(4);expect(p.root.querySelector('[role="menu"]')).toBeNull();
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout","Date"]});fire(row,'pointerdown',{pointerType:'touch',pointerId:2,button:0,clientX:20,clientY:20});await vi.advanceTimersByTimeAsync(600);vi.useRealTimers();await settle(4);
  expect(p.root.querySelector('[role="menu"]')).not.toBeNull();expect(fire(row,'click').defaultPrevented).toBe(true);
 });
 it('does not swallow a fresh touch on an opened menu item when no synthetic row click arrived',async()=>{
  const row=await mount();vi.useFakeTimers({toFake:["setTimeout","clearTimeout","Date"]});fire(row,'pointerdown',{pointerType:'touch',pointerId:10,button:0,clientX:20,clientY:20});await vi.advanceTimersByTimeAsync(600);vi.useRealTimers();await settle(4);
  const item=p.root.querySelector('[role="menuitem"]')!;expect(item).not.toBeNull();fire(item,'click',{pointerType:'touch',pointerId:11});await settle(4);expect(selected).toEqual(['beta']);
 });
 it.each([{viewOnly:true},{guest:true}])('does not intercept unavailable guest/read-only menus %j',async mode=>{
  if(mode.guest)p.document.body.dataset.tier='guest';const row=await mount(mode);expect(fire(row,'contextmenu').defaultPrevented).toBe(false);await settle(4);expect(p.root.querySelector('[role="menu"]')).toBeNull();
 });
});

describe('shared real chat actions',()=>{
 it('derives the target status/capabilities and sends lifecycle requests to that target',async()=>{
  const chat:any=await import('/ui/js/panel-chat.js');
  const build=(inst:any)=>chat.chatAgentMenuItems({name:inst.name,inst,wide:false,onDelete:vi.fn(),onPins:vi.fn()}).filter(Boolean);
  const live=build(beta);expect(live.some((x:any)=>x.key==='stop')).toBe(true);expect(live.some((x:any)=>x.key==='start')).toBe(false);
  const stopped=build({...beta,status:'stopped'});expect(stopped.some((x:any)=>x.key==='stop')).toBe(false);expect(stopped.some((x:any)=>x.key==='start')).toBe(true);
  const remote=build({...beta,runtime:'windows',machine_id:'demo-machine'});expect(remote.some((x:any)=>x.key==='workspace')).toBe(false);
  const fetcher=vi.fn(async()=>({json:async()=>({})}));vi.stubGlobal('fetch',fetcher);await live.find((x:any)=>x.key==='stop').onSelect();expect(fetcher).toHaveBeenCalledWith('/ui/stop/beta',expect.objectContaining({method:'POST'}));
  p.document.body.dataset.tier='guest';expect(build(beta)).toEqual([]);
 });
});

describe('the registered action host',()=>{
 it('uses the real header list and delete dialog for beta while alpha stays current',async()=>{
  const chat:any=await import('/ui/js/panel-chat.js');
  const row=await mount();app.appStore.set({sidebarChatMenu:chat.SidebarChatMenu});await settle(4);
  fire(row,'contextmenu');await settle(8);
  const list=p.root.querySelector('[role="menu"]')!;
  const expected=chat.chatAgentMenuItems({name:'beta',inst:beta,wide:false}).filter(Boolean).map((x:any)=>x.label);
  expect([...list.querySelectorAll('button')].map((b:any)=>b.textContent)).toEqual(["Add to favorites",...expected]);
  const del=[...list.querySelectorAll('button')].at(-1);expect(del).toBeTruthy();fire(del!,'click');await settle(8);
  expect(p.root.querySelector('dialog')?.textContent).toContain('beta');expect(p.root.querySelector('dialog input')?.getAttribute('placeholder')).toBe("delete beta");
  expect(globalThis.location.pathname).toContain('alpha');expect(p.root.querySelector('.p-chat')).toBeNull();
 });
 it('drops a context menu when the target disappears or read-only access takes over',async()=>{
  const row=await mount();fire(row,'contextmenu');await settle(4);expect(p.root.querySelector('[role="menu"]')).not.toBeNull();
  p.document.body.dataset.tier='guest';app.appStore.set({connected:false});await settle(4);expect(p.root.querySelector('[role="menu"]')).toBeNull();
 });
 it('does not suppress the browser menu on the filter or an ordinary touch tap',async()=>{
  const row=await mount();expect(fire(p.root.querySelector('#filterInput')!,'contextmenu').defaultPrevented).toBe(false);
  fire(row,'pointerdown',{pointerType:'touch',pointerId:3,button:0,clientX:20,clientY:20});fire(row,'pointerup',{pointerType:'touch',pointerId:3});await settle(4);
  expect(p.root.querySelector('[role="menu"]')).toBeNull();expect(fire(row,'click').defaultPrevented).toBe(false);
 });
});

describe('phone sheet priority and target metadata',()=>{
 it('lets native dialog Escape close the sheet before the still-open sidebar drawer',async()=>{
  const chat:any=await import('/ui/js/panel-chat.js'), shell:any=await import('/assets/app-shell.js');
  const prior=globalThis.matchMedia;vi.stubGlobal('matchMedia',(q:string)=>({matches:/max-width/.test(q),addEventListener(){},removeEventListener(){}}));
  try{
   const row=await mount();app.appStore.set({sidebarChatMenu:chat.SidebarChatMenu});await settle(4);shell.shellStore.set({drawer:true});
   p.document.addEventListener('keydown',shell.handleKey);fire(row,'contextmenu');await settle(8);
   const dialog=p.root.querySelector('dialog[open]')!;expect(dialog).not.toBeNull();expect(dialog.querySelector('h3')?.textContent).toBe('beta');const e=fire(dialog.querySelector('.dlg-box')!,'keydown',{key:'Escape'});
   expect(e.defaultPrevented).toBe(false);expect(shell.shellStore.get().drawer).toBe(true);
   fire(dialog,'cancel');await settle(6);expect(p.root.querySelector('dialog[open]')).toBeNull();expect(p.document.activeElement).toBe(row);
  }finally{p.document.removeEventListener('keydown',shell.handleKey);vi.stubGlobal('matchMedia',prior);shell.shellStore.set({drawer:false});}
 });
 it('reads only the explicit target activity metadata before offering its optional controls',async()=>{
  const chat:any=await import('/ui/js/panel-chat.js');const activity:any=await import('/ui/js/chat-activity.js');
  p.document.body.dataset.chatActivity='1';activity.setActivityOn(true);
  const reads:string[]=[];vi.stubGlobal('fetch',vi.fn(async(input:any)=>{const u=String(input);reads.push(u);return {ok:u.startsWith('/ui/steps?'),status:u.startsWith('/ui/steps?')?200:404,json:async()=>({enabled:true,supported:true,level:'off',steps:[]})};}));
  try{const row=await mount();app.appStore.set({sidebarChatMenu:chat.SidebarChatMenu});await settle(4);fire(row,'contextmenu');await settle(10);
   expect(reads.some(u=>u.startsWith('/ui/steps?')&&u.includes('instance=beta'))).toBe(true);expect(activity.activityInfo('beta')?.level).toBe('off');
   expect(p.root.querySelector('[role="menu"]')?.textContent).not.toContain('Show activity');expect(reads.some(u=>/history|instance=alpha/.test(u))).toBe(false);
  }finally{delete p.document.body.dataset.chatActivity;}
 });
});
