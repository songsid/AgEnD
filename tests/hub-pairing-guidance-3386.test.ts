import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let client: any, card: any, i18n: any;
const mounted: AppPage[] = [];
const realFetch = globalThis.fetch;
const unpaired = { state: "unpaired" };
const pending = { state: "pending", memberOrigin: "https://hub.test", fingerprint: { kind: "pairing", digest: "ab".repeat(32) }, localConfirmed: false, ownerConfirmed: null, adminApproved: null };
const paired = { state: "paired", binding: "b".repeat(64), link: "online", hub: { hubId: "h1", name: "Team", memberOrigin: "https://hub.test", webOrigin: "https://hub.test", fingerprint: { kind: "hub-key", digest: "cd".repeat(32) } } };
beforeAll(async () => {
  const pg = page();
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as any;
  client = await import("/ui/js/hub-client.js");
  card = await import("/ui/js/settings-hub.js");
  i18n = await import("/assets/app-i18n.js");
  pg.restore();
});
afterEach(async () => {
  for (const pg of mounted.splice(0)) { await pg.unmount(); pg.restore(); }
  client.setHubClient(null); i18n.setLang("en", { store: false });
  delete (globalThis as any).confirm;
});
afterAll(() => { globalThis.fetch = realFetch; });
const notice = (pg: AppPage) => pg.root.querySelector(".s-hub-connect > p[role=status]");
async function fixture(initial: any, over: any = {}) {
  let current = initial, listener: (p: any) => void = () => {};
  const c = { stub: false, pairing: async () => current, exposures: async () => [],
    subscribe: (fn: any) => { listener = fn; return () => { listener = () => {}; }; },
    connect: vi.fn(async () => ({ ok: true, pendingConfirmation: true, pairing: current })),
    confirmFingerprint: vi.fn(async () => ({ ok: true, pendingConfirmation: true, pairing: current })),
    disconnect: vi.fn(async () => ({ ok: true, pendingConfirmation: true })), ...over };
  client.setHubClient(c);
  const pg = page({ url: "http://127.0.0.1:19280/settings/hub" }); mounted.push(pg);
  pg.document.body.setAttribute("data-hub", "member");
  await pg.mount(h(card.HubConnectCard, {})); await settle(10);
  return { pg, c, emit: async (p: any) => { current = p; listener(p); await settle(10); } };
}
async function connect(pg: AppPage) {
  for (const [id, value] of [["hubAddress", "https://hub.test"], ["hubCode", "ABCD-EFGH"]]) {
    const input = pg.root.querySelector(`#${id}`)!; input.value = value; fire(input, "input");
  }
  await settle(5); fire(pg.root.querySelector("form.hub-connect"), "submit"); await settle(10);
}

describe("#3386 pairing confirmation hints follow the operation shown", () => {
  it.each(["failed", "expired", "rejected", "stale", "applied"])("#3404: a %s proposal settles the unchanged unpaired card", async state => {
    let decide!:(value:any)=>void;
    const settled=new Promise(resolve=>{decide=resolve;});
    const api=vi.fn(async(path:string)=>path.endsWith("/connect")
      ?{status:202,ok:false,body:{result:"pending_confirmation",pending_change:{id:"one"}}}
      :{status:200,ok:true,body:{pairing:unpaired}});
    const real=client.createMemberClient({confirm:{api,isPendingResponse:(r:any)=>r.status===202,track:()=>settled,newKey:()=>"key"},timers:{setTimeout:()=>1,clearTimeout:()=>{}},doc:{hidden:false}});
    const {pg}=await fixture(unpaired,real);await connect(pg);expect(notice(pg)).not.toBeNull();
    decide({state});await settle(20);
    expect(notice(pg)).toBeNull();
    const error=pg.root.querySelector(".s-hub-connect > p[role=alert]");
    if(state==="failed"||state==="expired")expect(error?.textContent).toContain("new code");
    else if(state!=="applied")expect(error?.textContent).toContain("Check the pairing status");
    else expect(error).toBeNull();
  });
  it("#3404: a late old failure cannot replace a newer pending proposal",async()=>{
    let first!:(v:any)=>void,second!:(v:any)=>void;
    const one=new Promise(r=>{first=r;}),two=new Promise(r=>{second=r;});let call=0;
    const {pg}=await fixture(unpaired,{connect:async()=>({ok:true,pendingConfirmation:true,pairing:unpaired,settled:call++===0?one:two})});
    await connect(pg);await connect(pg);first({state:"failed"});await settle(20);
    expect(notice(pg)).not.toBeNull();expect(pg.root.querySelector(".s-hub-connect > p[role=alert]")).toBeNull();
    second({state:"applied"});await settle(20);expect(notice(pg)).toBeNull();
  });
  it("#3404: an unreadable result clears a false waiting claim without asking to retry an unknown outcome",async()=>{
    let fail!:(e:Error)=>void;const settled=new Promise((_r,reject)=>{fail=reject;});
    void settled.catch(()=>{});
    const {pg}=await fixture(unpaired,{connect:async()=>({ok:true,pendingConfirmation:true,pairing:unpaired,settled})});
    await connect(pg);fail(Error("read unavailable"));await settle(20);
    expect(notice(pg)).toBeNull();expect(pg.root.querySelector(".s-hub-connect > p[role=alert]")?.textContent).toContain("result cannot be checked");
  });
  it("#3404: superseding a proposal while its final projection read is held fences that late result too",async()=>{
    let first!:(v:any)=>void,second!:(v:any)=>void,release!:(v:any)=>void;
    const one=new Promise(r=>{first=r;}),two=new Promise(r=>{second=r;}),held=new Promise(r=>{release=r;});
    let call=0,hold=false,entered=false;
    const {pg}=await fixture(unpaired,{pairing:()=>{if(hold){entered=true;return held;}return Promise.resolve(unpaired);},connect:async()=>({ok:true,pendingConfirmation:true,pairing:unpaired,settled:call++===0?one:two})});
    await connect(pg);hold=true;first({state:"failed"});await settle(10);expect(entered).toBe(true);
    hold=false;await connect(pg);release(unpaired);await settle(20);
    expect(notice(pg)).not.toBeNull();expect(pg.root.querySelector(".s-hub-connect > p[role=alert]")).toBeNull();
    second({state:"applied"});await settle(20);expect(notice(pg)).toBeNull();
  });
  it("#3404: cancelling an expired local confirmation makes its late result inert",async()=>{
    let decide!:(v:any)=>void;const settled=new Promise(r=>{decide=r;});
    const read=vi.fn(async()=>pending),cancel=vi.fn(async()=>unpaired);
    const {pg,emit}=await fixture(pending,{pairing:read,cancel,confirmFingerprint:async()=>({ok:true,pendingConfirmation:true,pairing:pending,settled})});
    pg.root.querySelector(".hub-local-confirm").click();await settle(10);
    await emit({state:"held",hold:"expired"});pg.root.querySelector(".hub-held button").click();await settle(10);
    const reads=read.mock.calls.length;decide({state:"failed"});await settle(20);
    expect(read).toHaveBeenCalledTimes(reads);expect(cancel).toHaveBeenCalledOnce();
    expect(pg.root.querySelector("form.hub-connect")).not.toBeNull();expect(notice(pg)).toBeNull();
    expect(pg.root.querySelector(".s-hub-connect > p[role=alert]")).toBeNull();
  });
  it.each(["en", "zh-TW"])("%s: fingerprint confirmation clears on local application and never reappears after Connected", async lang => {
    i18n.setLang(lang, { store: false });
    const { pg, c, emit } = await fixture(pending);
    pg.root.querySelector(".hub-local-confirm").click(); await settle(10);
    expect(c.confirmFingerprint).toHaveBeenCalledWith(pending.fingerprint.digest);
    expect(notice(pg)).not.toBeNull();
    await emit({ ...pending }); expect(notice(pg)).not.toBeNull(); // an unchanged poll is not a decision
    await emit({ ...pending, localConfirmed: true });
    expect(pg.root.querySelector(".hub-local-confirmed")).not.toBeNull();
    expect(notice(pg)).toBeNull();
    await emit(paired);
    expect(pg.root.querySelector(".hub-paired .is-online")).not.toBeNull();
    expect(notice(pg)).toBeNull();
    await emit(unpaired); expect(notice(pg)).toBeNull();
    await emit(pending); expect(notice(pg)).toBeNull(); // a late old projection cannot resurrect the cleared note
  });
  it("connect clears its queued hint when the pairing request applies, keeping the actual next fingerprint step", async () => {
    const { pg, emit } = await fixture(unpaired);
    await connect(pg); expect(notice(pg)).not.toBeNull();
    await emit(pending);
    expect(pg.root.querySelector(".hub-local-confirm")).not.toBeNull();
    expect(notice(pg)).toBeNull();
  });
  it("disconnect still pending on the same binding retains its hint through an offline poll, then clears when applied", async () => {
    (globalThis as any).confirm = () => true;
    const { pg, c, emit } = await fixture(paired);
    pg.root.querySelector(".hub-paired .btn-danger").click(); await settle(15);
    expect(c.disconnect).toHaveBeenCalledWith(paired);
    expect(notice(pg)).not.toBeNull();
    await emit({ ...paired, link: "offline" }); expect(notice(pg)).not.toBeNull();
    await emit({ ...paired, binding: "c".repeat(64) }); expect(notice(pg)).toBeNull();
    await emit(unpaired);
    expect(pg.root.querySelector(".hub-connect")).not.toBeNull(); expect(notice(pg)).toBeNull();
  });
  it("a different Hub cannot inherit the old disconnect hint even if its projection reuses the binding", async () => {
    (globalThis as any).confirm = () => true;
    const { pg, emit } = await fixture(paired);
    pg.root.querySelector(".hub-paired .btn-danger").click(); await settle(15);
    expect(notice(pg)).not.toBeNull();
    await emit({ ...paired, hub: { ...paired.hub, hubId: "h2" } });
    expect(notice(pg)).toBeNull();
  });
  it("a pairing read already showing completion never draws the old queued hint", async () => {
    const { pg } = await fixture(unpaired, { connect: async () => ({ ok: true, pendingConfirmation: true, pairing: paired }) });
    await connect(pg);
    expect(pg.root.querySelector(".hub-paired")).not.toBeNull(); expect(notice(pg)).toBeNull();
  });
  it("replacement fingerprint and held state dismiss only the old pending note, not error messages", async () => {
    const { pg, emit } = await fixture(pending);
    pg.root.querySelector(".hub-local-confirm").click(); await settle(10);
    await emit({ ...pending, fingerprint: { ...pending.fingerprint, digest: "ef".repeat(32) } });
    expect(notice(pg)).toBeNull();
    pg.root.querySelector(".hub-local-confirm").click(); await settle(10);
    expect(notice(pg)).not.toBeNull();
    await emit({ state: "held", hold: "expired" }); expect(notice(pg)).toBeNull();
    expect(pg.root.querySelector(".hub-held")).not.toBeNull();
    await emit(unpaired);
    const c = client.hubClient(); c.connect = async () => ({ ok: false, error: "refused" });
    await connect(pg);
    const error = pg.root.querySelector(".s-hub-connect > p[role=alert]")!.textContent;
    await emit(paired);
    expect(pg.root.querySelector(".s-hub-connect > p[role=alert]")!.textContent).toBe(error);
  });
  it.each(["en", "zh-TW"])("%s: pending pairing wording does not invent a General or sharing step", async lang => {
    i18n.setLang(lang, { store: false });
    const { pg } = await fixture(pending);
    pg.root.querySelector(".hub-local-confirm").click(); await settle(10);
    expect(notice(pg)!.textContent).toBe(lang === "en" ? "Waiting for your confirmation" : "等待你的確認");
    expect(notice(pg)!.textContent).not.toMatch(/General|share|公開/);
  });
});
