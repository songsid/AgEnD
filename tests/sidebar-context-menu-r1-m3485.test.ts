import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {h,page,settle,type AppPage} from './helpers/app-harness.js';
import {fire} from './helpers/mini-dom.js';
let p:AppPage,chat:any,app:any,nav:any,cards:any;
let reply:any={choices:{current:'demo',options:[{id:'demo',label:'Demo model'}]}},held:((v:any)=>void)|null=null;
let wait=false;const sent:any[]=[];
const rows=[{name:'alpha',backend:'codex',status:'running',card_v:'a'},{name:'beta',backend:'codex',status:'running',card_v:'b'}];
const alphaCard={tagline:{text:'Alpha signature',by:'agent'}},betaCard={tagline:{text:'Beta signature',by:'agent'}};
const fakeFetch=async(input:any,opts:any={})=>{
 const url=String(input);if(url==='/ui/command'){sent.push(JSON.parse(opts.body));if(wait)return new Promise(resolve=>{held=resolve;});return{ok:true,status:200,json:async()=>reply};}
 if(url.startsWith('/api/card/'))return{ok:true,status:200,json:async()=>(url.endsWith('beta')?betaCard:alphaCard)};
 return{ok:false,status:404,json:async()=>({})};
};
beforeAll(async()=>{
 p=page({url:'http://localhost/ui/chat/alpha',matchNarrow:true,storage:{agend_lang:'en',agend_tour_done:'1'}});vi.stubGlobal('fetch',fakeFetch);
 app=await import('/assets/app-store.js');nav=await import('/assets/instance-nav.js');cards=await import('/assets/identity-card.js');chat=await import('/ui/js/panel-chat.js');
 chat.boot({stream:{on(){return()=>{};}},boot:null,deps:{fetch:fakeFetch}});
});
beforeEach(()=>{wait=false;held=null;sent.length=0;reply={choices:{current:'demo',options:[{id:'demo',label:'Demo model'}]}};app.applyStatus({instances:rows});app.appStore.set({sidebarChatMenu:chat.SidebarChatMenu});chat.setChatCardOpen(false);cards.cardsStore.set({alpha:{v:'a',card:alphaCard},beta:{v:'b',card:betaCard}});chat.store.state.commands.alpha={command:'ctx',text:'Alpha remains'};});
afterEach(async()=>{await p.unmount();chat.store.dismissCommand('beta');});afterAll(()=>{p.restore();vi.unstubAllGlobals();});
async function open(){await p.mount(h(nav.InstanceNav,{route:{panel:'chat',instance:'alpha'},items:rows}));fire(p.root.querySelector('[data-agent-row="beta"] a.inst')!,'contextmenu');await settle(8);}
function row(label:string){return [...p.root.querySelectorAll('button')].find((b:any)=>b.textContent.startsWith(label)) as any;}
async function model(){await open();fire(row('Model & effort'),'click');await settle(12);}
describe('sidebar target-owned card and command surface',()=>{
 it('opens Beta card without changing current Alpha card preference',async()=>{
  await open();fire(row('Card'),'click');await settle(8);
  expect(chat.chatCardPrefs.get().open).toBe(false);expect(p.root.querySelector('.id-card')?.textContent).toContain('Beta signature');expect(p.root.querySelector('.id-card')?.textContent).not.toContain('Alpha signature');expect(globalThis.location.pathname).toContain('alpha');
 });
 it.each(['close','escape'])('model %s leaves no outer empty dialog and preserves Alpha',async how=>{
  const alpha=chat.store.state.commands.alpha;await model();expect(p.root.querySelectorAll('dialog[open]')).toHaveLength(1);
  const sheet=p.root.querySelector('.model-menu-sheet')!;expect(sheet).not.toBeNull();if(how==='close')fire(sheet.querySelector('.dlg-x')!,'click');else fire(sheet,'cancel');await settle(10);
  expect(p.root.querySelectorAll('dialog[open]')).toHaveLength(0);expect(chat.store.state.commands.beta).toBeUndefined();expect(chat.store.state.commands.alpha).toBe(alpha);expect(sent[0].instance).toBe('beta');expect(globalThis.location.pathname).toContain('alpha');
 });
 it('dismissing a backend result closes its surface as well',async()=>{
  reply={text:'Beta backend result'};await open();fire(row('CLI backend'),'click');await settle(12);expect(p.root.querySelectorAll('dialog[open]')).toHaveLength(1);
  fire(p.root.querySelector('.cmd-head-actions .icon-btn')!,'click');await settle(10);expect(p.root.querySelectorAll('dialog[open]')).toHaveLength(0);expect(chat.store.state.commands.beta).toBeUndefined();
 });
 it('closing a loading target picker fences its held response',async()=>{
  wait=true;await model();expect(held).not.toBeNull();const sheet=p.root.querySelector('.model-menu-sheet')!;fire(sheet,'cancel');await settle(8);
  held!({ok:true,status:200,json:async()=>reply});await settle(12);expect(chat.store.state.commands.beta).toBeUndefined();expect(p.root.querySelectorAll('dialog[open]')).toHaveLength(0);expect(chat.store.state.commands.alpha.text).toBe('Alpha remains');
 });
});
