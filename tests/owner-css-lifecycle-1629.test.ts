/** B2: positive off evidence and physical stylesheet ownership, without mounting effects. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, settle, type AppPage } from "./helpers/app-harness.js";
const A = "a".repeat(32), B = "b".repeat(32);
const g = globalThis as any;
let p: AppPage | null = null;
afterEach(() => { p?.restore(); p = null; delete g.fetch; vi.resetModules(); });
async function boot(opts: { active?: string | null; evidence?: string; hold?: boolean; route?: string; storage?: Record<string,string>; mode?: string; publicLink?: boolean; safe?: boolean } = {}) {
  vi.resetModules(); p = page({ url: `http://127.0.0.1:19280/ui/chat/a${opts.safe ? '?safe=1' : ''}`, storage: opts.storage });
  p.document.body.dataset.mode = opts.mode ?? "full";
  if (opts.active) p.document.body.dataset.ownerCss = opts.active;
  if (opts.evidence) p.document.body.dataset.ownerCssState = opts.evidence;
  if (opts.publicLink) p.document.body.dataset.publicLink = "1";
  let answer: any = { active: opts.active ?? null, pending: null, effectState: opts.evidence ?? "unknown" };
  const pending: Array<(v: any) => void> = [];
  g.fetch = vi.fn(async () => opts.hold ? new Promise(r => pending.push(r)) : { ok: true, json: async () => answer });
  const nav = await import("/assets/app-nav.js"), app = await import("/assets/app-store.js");
  nav.navStore.set({ route: { panel: opts.route ?? "chat", instance: "a" }, seq: 1 });
  const css = await import("/assets/owner-css.js");
  expect(css.ownerCssLifecycle.get()).toMatchObject({ state: "unknown" });
  css.installOwnerCss(); await settle();
  const link = () => p!.document.getElementById("owner-css") as any;
  const loaded = (el = link(), overrides: any = {}) => {
    Object.assign(el, { disabled: false, sheet: { ownerNode: el, href: new URL(el.getAttribute('href'), g.location.href).href, disabled: false }, ...overrides });
    el.dispatchEvent(new g.Event('load'));
  };
  const refresh = async (body: any) => { answer = body; const old=app.appStore.get(); app.appStore.set({ ...old, prefsRev: (old.prefsRev ?? 0)+1 }); await settle(); app.appStore.set({ ...app.appStore.get(), prefsRev: (app.appStore.get().prefsRev ?? 0)+1 }); await settle(); };
  return { css, nav, app, link, loaded, pending, refresh };
}
describe("owner CSS lifecycle admission", () => {
  it.each([undefined,"unknown","nonsense"])("absent link with %s evidence is unknown, never off", async evidence => {
    const f=await boot({ evidence }); expect(f.link()).toBeNull(); expect(f.css.ownerCssLifecycle.get()).toMatchObject({ state:"unknown" });
  });
  it("only explicit host-off plus physical absence proves off; snapshots are immutable", async () => {
    const f=await boot({ evidence:"off" }); const state=f.css.ownerCssLifecycle.get(); expect(state).toMatchObject({state:"off",reason:"host_off"}); expect(Object.isFrozen(state)).toBe(true); expect(Object.isFrozen(f.css.ownerCssLifecycle)).toBe(true); expect(f.css.ownerCssLifecycle.set).toBeUndefined(); expect(f.link()).toBeNull();
  });
  it("boot off is revoked before a held refresh; a stale/unknown reply cannot restore it", async () => {
    const f=await boot({ evidence:"off",hold:true }); expect(f.css.ownerCssLifecycle.get().state).toBe("unknown");
    f.pending[0]!({ok:true,json:async()=>({active:null,pending:null})}); await settle(); expect(f.css.ownerCssLifecycle.get().state).toBe("unknown");
  });
  it("an active link remains loading until its actual owned stylesheet reports a matching load", async () => {
    const f=await boot({active:A,evidence:"on"}); expect(f.css.ownerCssLifecycle.get().state).toBe("loading"); f.loaded(); expect(f.css.ownerCssLifecycle.get()).toMatchObject({state:"on",reason:"loaded"});
  });
  it.each([{sheet:null},{disabled:true},{sheet:{ownerNode:null,href:'http://127.0.0.1:19280/wrong',disabled:false}}])("a load without a verified sheet stays unknown: %j", async over => {
    const f=await boot({active:A,evidence:"on"});f.loaded(f.link(),over);expect(f.css.ownerCssLifecycle.get().state).toBe("unknown");
  });
  it.each(['ownerNode','href','disabled'])("each native sheet %s field is independently required", async field => {
    const f=await boot({active:A,evidence:'on'}),el=f.link(),sheet:any={ownerNode:el,href:new URL(el.getAttribute('href'),g.location.href).href,disabled:false};sheet[field]=field==='disabled'?true:field==='href'?'http://127.0.0.1:19280/wrong':null;f.loaded(el,{sheet});expect(f.css.ownerCssLifecycle.get().state).toBe('unknown');
  });
  it("sheet errors are unknown and cannot become off on a route refresh", async () => {
    const f=await boot({active:A,evidence:"on"});f.link().dispatchEvent(new g.Event('error'));expect(f.css.ownerCssLifecycle.get().state).toBe("unknown");f.nav.navStore.set({route:{panel:'chat',instance:'b'},seq:2});expect(f.css.ownerCssLifecycle.get().state).toBe("unknown");
  });
  it("revokes before replacement, ignores every late old-version event and accepts only the current load", async () => {
    const f=await boot({active:A,evidence:"on"}); f.loaded(); const old=f.link(), observed:any[]=[];
    const unsub=f.css.ownerCssLifecycle.subscribe((s:any)=>observed.push({state:s.state,href:f.link()?.getAttribute('href')}));
    f.css.setOwnerCssActive(B); const next=f.link();expect(next).not.toBe(old);expect(old.isConnected).toBe(false);expect(observed[0]).toEqual({state:'unknown',href:`/ui/owner-css.css?v=${A}`});
    f.loaded(old);old.dispatchEvent(new g.Event('error'));expect(f.css.ownerCssLifecycle.get().state).toBe('loading');f.loaded(next);expect(f.css.ownerCssLifecycle.get().state).toBe('on');unsub();
  });
  it("a failing pre-change consumer cannot let a new stylesheet reach the document", async () => {
    const f=await boot({active:A,evidence:'on'});f.loaded();const old=f.link(),unsub=f.css.ownerCssLifecycle.subscribe(()=>{throw Error('consumer failed')});
    try{expect(()=>f.css.setOwnerCssActive(B)).toThrow('consumer failed');expect(f.link()).toBe(old);expect(old.isConnected).toBe(true);expect(old.getAttribute('href')).toBe(`/ui/owner-css.css?v=${A}`);expect(f.css.ownerCssLifecycle.get().state).toBe('unknown');}finally{unsub();}
  });
  it("switch off is observed only after physical removal; late loads cannot turn it on", async () => {
    const f=await boot({active:A,evidence:'on'});const old=f.link();f.loaded();f.css.setOwnerCssOffHere(true);expect(f.css.ownerCssLifecycle.get().state).toBe('off');expect(f.link()).toBeNull();f.loaded(old);expect(f.css.ownerCssLifecycle.get().state).toBe('off');
    f.css.setOwnerCssOffHere(false);expect(f.css.ownerCssLifecycle.get().state).toBe('loading');f.loaded();expect(f.css.ownerCssLifecycle.get().state).toBe('on');
  });
  it.each(['throw','no-op'])("a %s local-storage write is not positive disable proof", async how => {
    const f=await boot({active:A,evidence:'on'});f.loaded();g.localStorage.setItem=()=>{if(how==='throw')throw Error('blocked')};f.css.setOwnerCssOffHere(true);expect(f.css.ownerCssLifecycle.get().state).toBe('on');expect(f.link()).not.toBeNull();
  });
  it("a removal that leaves a duplicate cannot report off", async () => {
    const f=await boot({active:A,evidence:'on'});const extra=p!.document.createElement('link');extra.id='owner-css';p!.document.head.appendChild(extra);f.css.setOwnerCssOffHere(true);expect(f.css.ownerCssLifecycle.get().state).toBe('unknown');
  });
  it("an unowned existing link never gets a successful admission verdict", async () => {
    const f=await boot({active:A,evidence:'on'});f.link().remove();const extra=p!.document.createElement('link');extra.id='owner-css';p!.document.head.appendChild(extra);f.nav.navStore.set({route:{panel:'chat',instance:'b'},seq:2});expect(f.css.ownerCssLifecycle.get()).toMatchObject({state:'unknown',reason:'unowned_link'});
  });
  it.each([{route:'settings'},{mode:'view-only'},{publicLink:true},{safe:true}])("host-disabled surface has no link: %j", async opts => {
    const f=await boot({active:A,evidence:'on',...opts});expect(f.link()).toBeNull();expect(f.css.ownerCssLifecycle.get().state).toBe('off');
  });
  it("Settings removes the sheet, leaving recreates a loading sheet with a new generation", async () => {
    const f=await boot({active:A,evidence:'on'});f.loaded();const before=f.css.ownerCssLifecycle.get();f.nav.navStore.set({route:{panel:'settings'},seq:2});expect(f.css.ownerCssLifecycle.get().state).toBe('off');f.nav.navStore.set({route:{panel:'chat',instance:'a'},seq:3});expect(f.css.ownerCssLifecycle.get().state).toBe('loading');expect(f.css.ownerCssLifecycle.get().generation).toBeGreaterThan(before.generation);
  });
  it("a failed state refresh revokes a previous host-off proof", async () => {
    const f=await boot({evidence:'off'});g.fetch=vi.fn(async()=>({ok:false,status:503}));await f.refresh(null);expect(f.css.ownerCssLifecycle.get().state).toBe('unknown');expect(f.link()).toBeNull();
  });
  it("a local accepted off supersedes a held stale on reply", async () => {
    const f=await boot({active:A,evidence:'on',hold:true});f.css.setOwnerCssActive(null);expect(f.css.ownerCssLifecycle.get().state).toBe('off');f.pending[0]!({ok:true,json:async()=>({active:A,effectState:'on'})});await settle();expect(f.css.ownerCssLifecycle.get().state).toBe('off');expect(f.link()).toBeNull();
  });
});
