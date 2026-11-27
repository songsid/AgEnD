import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import { FleetManager } from "../src/fleet-manager.js";
import { ContactAuthStore, contactPersonKey } from "../src/contact-auth-store.js";
import { ContactAuthService } from "../src/contact-auth-service.js";
import { prepareContactChange, ProposeContactChangeArgs } from "../src/contact-change-proposals.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import type { ContactPerson } from "../src/contact-auth-types.js";
const admin: ContactPerson = { platform: "discord", adapterId: "demo", userId: "fake-admin", label: "Demo admin" };
const other = { ...admin, userId: "fake-other" }, person = { ...admin, userId: "fake-person", label: "Demo person" };
const rigs: any[] = [];
afterEach(() => { for (const r of rigs.splice(0)) { for (const e of r.fm.pendingNonceButtons.values()) clearTimeout(e.timer); r.db.close(); } vi.restoreAllMocks(); });
function rig() {
  const db = new Database(":memory:"), store = new ContactAuthStore(db);
  let count = 0, manager = true, allowed = true, current = true, hub = false, routeCurrent = true;
  const gen = new Map([['general', 'g1'], ['room', 'r1'], ['worker', 'w1']]), modes = new Map([['room', 'legacy']]);
  const admit = vi.fn(() => `delivery-${++count}`);
  const service = new ContactAuthService({ store, restricted: () => true, adminOf: () => false, defaultApprovers: () => manager ? [admin] : [], generation: n => gen.get(n)!, hubRestricted: () => hub, delivered: () => false, admit, changed: vi.fn() });
  const write = vi.fn((n, input, actor) => { if (input.mode) modes.set(n, input.mode); return store.writePolicy(n, input, actor, k => gen.get(k)!); });
  const decide = vi.fn((id, input, actor) => service.decide(id, input, actor));
  const adapter: any = { id: "demo", type: "discord", getBotUserId: () => "fake-bot", notifyAlert: vi.fn(async (_chat, alert) => ({ chatId: "channel", messageId: "prompt", threadId: "thread" })), editMessageRemoveButtons: vi.fn(async () => {}) };
  const fm: any = Object.assign(Object.create(FleetManager.prototype), { fleetConfig: { defaults: { scheduler: { default_timezone: "Asia/Taipei" } }, instances: { general: { general_topic: true }, room: { display_name: "Demo room" }, worker: { display_name: "Demo worker" } } },
    pendingNonceButtons: new Map(), adapters: new Map([['demo', adapter]]), webPromptClicks: new WeakSet(), webPromptClaims: new WeakSet(),
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() }, renderPlaces: (_id: string, text: string) => ({ text, opts: {} }),
    webPromptGone: vi.fn(), collapseNoncePrompt: vi.fn(async () => {}), retireNonceButtons: vi.fn(async () => {}), hubContactRestricted: () => hub, lifecyclePin: () => () => current,
    contactService: () => service, contactRoom: (n: string) => modes.has(n) ? { restrictedMode: modes.get(n) === 'restricted' } : undefined,
    contactGeneration: (n: string) => gen.get(n)!, contactAdminOf: (_n: string, p: ContactPerson) => manager && p.adapterId === admin.adapterId && p.userId === admin.userId,
    writeContactPermissions: write, decideContactAuthorization: decide, contactAdapter: () => adapter,
    settingsGeneralRoute: (n: string) => n === 'general' ? ({ adapterId: 'demo', adapter, chatId: 'channel', topic: 'thread', current: () => routeCurrent }) : null });
  const host = { service, generation: (n: string) => gen.get(n)!, label: (n: string) => `Demo ${n}`, timeZone: () => "Asia/Taipei", mode: (n: string) => modes.get(n) as any, modeAdmin: fm.contactAdminOf, write, decide, clearOrigin: vi.fn() };
  const ticket = () => store.hold({ operationId: `op-${Math.random()}`, source: 'room', target: 'worker', sourceGeneration: 'r1', targetGeneration: 'w1', verb: 'send_to_instance',
    origin: { kind: 'human', people: [person], chain: ['room'], receiptIds: [] }, message: 'Synthetic public question', correlationId: 'synthetic', resultRecipient: 'room', payload: {} });
  const post = async (raw: unknown = { kind: 'mode', target: 'room', mode: 'restricted' }) => { await fm.requestContactChange('general', raw, () => current); return [...fm.pendingNonceButtons.values()].at(-1); };
  const click = (entry: any, userId = admin.userId, extras: any = {}, receiving = adapter, callbackAdapterId = 'demo') => fm.handleContactChangeCallback({ callbackData: `contact-change:${entry.nonce}:confirm`, chatId: entry.chatId, messageId: entry.messageId, threadId: entry.threadId, userId, username: admin.label, ack: vi.fn(), ...extras }, callbackAdapterId, receiving);
  const result = { db, store, service, fm, adapter, host, gen, modes, write, decide, ticket, post, click, admit,
    manager: (v: boolean) => manager = v, current: (v: boolean) => current = v, hub: (v: boolean) => hub = v, route: (v: boolean) => routeCurrent = v };
  rigs.push(result); return result;
}
it('raw tools and schemas cannot supply an actor/confirmation or use an unconfigured General', async () => {
  const r = rig();
  expect(ProposeContactChangeArgs.safeParse({ kind: 'mode', target: 'room', mode: 'legacy', actor: admin }).success).toBe(false);
  const respond = vi.fn();
  await outboundHandlers.get('propose_contact_change')!(r.fm, { change: { kind: 'mode', target: 'room', mode: 'restricted' } }, respond, { instanceName: 'worker', callerCurrent: () => true } as any);
  expect(respond.mock.calls[0]?.[1]).toContain('configured General'); expect(r.adapter.notifyAlert).not.toHaveBeenCalled();
  await expect(r.fm.requestContactChange('worker', { kind: 'mode', target: 'room', mode: 'restricted' }, () => true)).rejects.toThrow('general-only');
});
it('proposing writes nothing; only exact platform admin confirmation claims once, without web mirroring', async () => {
  const r = rig(), e = await r.post();
  expect(r.write).not.toHaveBeenCalled(); expect(e.web).toBeUndefined();
  await r.click(e, other.userId); await r.click(e, 'fake-bot');
  await r.click(e, admin.userId, { messageId: 'other-message' });
  const alternate = { ...r.adapter, id: 'elsewhere' }; r.fm.adapters.set('elsewhere', alternate);
  await r.click(e, admin.userId, {}, alternate, 'elsewhere');
  expect(r.write).not.toHaveBeenCalled(); expect(r.fm.pendingNonceButtons.has(e.nonce)).toBe(true);
  await Promise.all([r.click(e), r.click(e)]);
  expect(r.write).toHaveBeenCalledOnce(); expect(r.write.mock.calls[0]![2]).toMatchObject(admin);
});
it('admin revocation, requesting lifecycle/route changes, incarnation replacement, web-only clicks and deadline all refuse', async () => {
  for (const cause of ['admin', 'lifecycle', 'route', 'generation', 'web', 'deadline']) {
    const r = rig(), e = await r.post();
    if (cause === 'admin') r.manager(false);
    if (cause === 'lifecycle') r.current(false);
    if (cause === 'route') r.route(false);
    if (cause === 'generation') r.gen.set('room', 'r2');
    if (cause === 'deadline') vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 300_001);
    if (cause === 'web') { const data: any = { callbackData: `contact-change:${e.nonce}:confirm`, chatId: e.chatId, messageId: e.messageId, threadId: e.threadId, userId: admin.userId }; r.fm.webPromptClicks.add(data); await r.fm.handleContactChangeCallback(data, 'demo', r.adapter); }
    else await r.click(e);
    expect(r.write, cause).not.toHaveBeenCalled(); vi.restoreAllMocks();
  }
});
it.each([false, true])('ticket approval (legacy selector=%s) uses real store and target configured approver; single-use nonce cannot admit twice', async legacy => {
  const r = rig(), ticket = r.ticket();
  r.store.writePolicy('worker', { revision: 0, approvers: [other] }, admin, n => r.gen.get(n)!);
  const input = { kind: 'ticket-decision', ticket_id: ticket.id, decision: 'approve-once', grant: { expiresAt: new Date(Date.now()+86400000).toISOString(), remainingUses: null, personKeys: [legacy ? JSON.stringify([person.platform, person.adapterId, person.userId]) : contactPersonKey(person)] } };
  const e = await r.post(input); await r.click(e);
  expect(r.admit).not.toHaveBeenCalled();
  r.store.writePolicy('worker', { revision: 1, approvers: [admin] }, admin, n => r.gen.get(n)!);
  await r.click(e); expect(r.admit).not.toHaveBeenCalled(); // stale policy, not revived by restoring permission
  const fresh = await r.post(input); await Promise.all([r.click(fresh), r.click(fresh)]);
  expect(r.admit).toHaveBeenCalledOnce(); expect(r.store.policy('worker','w1').grants).toHaveLength(1);
  expect(r.store.origin('worker')).toBeUndefined();
});
it('adjust/revoke retain exact scope and current revision, stale/unknown/source-replaced requests do not write', () => {
  const r = rig(), ticket = r.ticket();
  r.service.decide(ticket.id, { revision: 1, decision:'approve-once', grant:{expiresAt:new Date(Date.now()+86400000).toISOString(),remainingUses:null} }, admin);
  const original = r.store.policy('worker','w1').grants[0]!;
  const input = { kind:'grant-adjust',target:'worker',grant_id:original.id,expires_at:new Date(Date.now()+2*86400000).toISOString(),remaining_uses:3 };
  const plan = prepareContactChange(input,r.host); plan.apply(admin);
  expect(r.store.policy('worker','w1').grants[0]).toMatchObject({id:original.id,person:original.person,source:original.source,verbs:original.verbs,remainingUses:3});
  expect(()=>plan.apply(admin)).toThrow('conflict');
  const revoke = prepareContactChange({kind:'grant-revoke',target:'worker',grant_id:original.id},r.host);
  r.gen.set('room','r2'); expect(()=>revoke.apply(admin)).toThrow('conflict');
  r.gen.set('room','r1'); revoke.apply(admin); expect(r.store.policy('worker','w1').grants).toEqual([]);
});
it('a changed or expired ticket is not approved and a Hub contact window prevents posting or delivery', async () => {
  const r=rig(), t=r.ticket(), e=await r.post({kind:'ticket-decision',ticket_id:t.id,decision:'approve-once'});
  r.service.decide(t.id,{revision:1,decision:'decline'},admin); await r.click(e); expect(r.admit).not.toHaveBeenCalled();
  r.hub(true); await expect(r.post()).rejects.toThrow('hub-contact-restricted');
});
it('proposals are immutable, cancel is inert, and pending cards cannot be replayed after restart', async () => {
  const r=rig(), raw:any={kind:'mode',target:'room',mode:'restricted'}, e=await r.post(raw); raw.mode='legacy';
  await r.click(e); expect(r.write.mock.calls[0]![1].mode).toBe('restricted');
  const next=await r.post({kind:'mode',target:'room',mode:'legacy'});
  await r.click(next,admin.userId,{callbackData:`contact-change:${next.nonce}:cancel`});
  expect(r.write).toHaveBeenCalledTimes(1);
  const orphan=await r.post({kind:'mode',target:'room',mode:'legacy'}); clearTimeout(orphan.timer); r.fm.pendingNonceButtons.clear();
  await r.click(orphan); expect(r.write).toHaveBeenCalledTimes(1);
});
it('late card delivery is retired when its bound requester disappears, and per-General limits stop prompt flooding', async () => {
  const r=rig(); let finish:(v:any)=>void=()=>{};
  r.adapter.notifyAlert.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const posting=r.post(); const failed=expect(posting).rejects.toThrow('conflict');
  const unbound=[...r.fm.pendingNonceButtons.values()][0];
  await r.click(unbound,admin.userId,{messageId:'before-canonical-delivery'}); expect(r.write).not.toHaveBeenCalled();
  r.current(false); finish({chatId:'channel',messageId:'late',threadId:'thread'}); await failed;
  expect(r.fm.pendingNonceButtons.size).toBe(0); expect(r.fm.retireNonceButtons).toHaveBeenCalled();
  r.current(true); for(let i=0;i<8;i++)await r.post();
  await expect(r.post()).rejects.toThrow('contact-proposal-limit');
  expect(r.adapter.notifyAlert).toHaveBeenCalledTimes(9); expect(r.write).not.toHaveBeenCalled();
});
it('unknown or forged standing-grant selections cannot even become an actionable proposal', () => {
  const r=rig(), tk=r.store.hold({operationId:'unknown',source:'room',target:'worker',sourceGeneration:'r1',targetGeneration:'w1',verb:'send_to_instance',origin:{kind:'unknown',people:[],chain:[],receiptIds:[]},message:'Synthetic',correlationId:'synthetic',resultRecipient:'room',payload:{}});
  expect(()=>prepareContactChange({kind:'ticket-decision',ticket_id:tk.id,decision:'approve-once',grant:{expiresAt:new Date(Date.now()+86400000).toISOString(),remainingUses:null,personKeys:[contactPersonKey(person)]}},r.host)).toThrow('invalid-grant-origin');
  expect(r.admit).not.toHaveBeenCalled();
});
it.each(['en','zh-TW'] as const)('%s visible native card states come from the real posting/callback/timer paths', async language => {
  const { setLocale } = await import('../src/locale.js');
  setLocale(language);
  try {
    const r=rig(), rawMode={kind:'mode',target:'room',mode:'restricted'}, modeEntry=await r.post(rawMode);
    const mode=r.adapter.notifyAlert.mock.calls[0]![1];
    const tk=r.ticket(), rawContact={kind:'ticket-decision',ticket_id:tk.id,decision:'approve-once',grant:{expiresAt:new Date(Date.now()+7*86400000).toISOString(),remainingUses:null,personKeys:[contactPersonKey(person)]}};
    const contactEntry=await r.post(rawContact), contact=r.adapter.notifyAlert.mock.calls[1]![1];
    expect(mode.message).toContain(language==='en'?'Nothing changes until':'確認前');
    expect(contact.message).toContain(language==='en'?"doesn't approve":'不代表核准');
    for(const card of [mode,contact]) {
      expect(card.choices.map((c:any)=>c.label)).toEqual(language==='en'?['Confirm change','Cancel proposal']:['確認變更','取消提案']);
      expect(card.choices.every((c:any)=>Buffer.byteLength(c.id)<=64)).toBe(true);
    }
    const ack=vi.fn(); await r.click(modeEntry,other.userId,{ack});
    const unauthorized=ack.mock.calls[0]?.[0]; expect(r.write).not.toHaveBeenCalled();
    expect(contact.message).not.toMatch(/fake-person|discord:demo|send_to_instance|\d{4}-\d\d-\d\dT|Approve once|單次核准/);
    expect(contact.message).toContain('Demo person'); expect(contact.message).toContain('Discord');
    expect(contact.message).toContain('Demo worker'); expect(contact.message).not.toContain(tk.id);
    expect(contact.message).not.toMatch(/Time zone:|時區：|Uses: unlimited|次數：到期前|） /);
    await r.click(contactEntry); const confirmed=r.fm.retireNonceButtons.mock.calls.at(-1)[2];
    await r.click(modeEntry,admin.userId,{callbackData:`contact-change:${modeEntry.nonce}:cancel`});
    const cancelled=r.fm.retireNonceButtons.mock.calls.at(-1)[2];
    const confirmedModeEntry=await r.post(rawMode); await r.click(confirmedModeEntry);
    const modeConfirmed=r.fm.retireNonceButtons.mock.calls.at(-1)[2];
    const rule=r.store.policy('worker','w1').grants[0]!;
    const rawAdjust={kind:'grant-adjust',target:'worker',grant_id:rule.id,expires_at:new Date(Date.now()+8*86400000).toISOString(),remaining_uses:null};
    const adjustEntry=await r.post(rawAdjust), adjustCard=r.adapter.notifyAlert.mock.calls.at(-1)![1]; await r.click(adjustEntry);
    const adjusted=r.fm.retireNonceButtons.mock.calls.at(-1)[2];
    const rawRevoke={kind:'grant-revoke',target:'worker',grant_id:rule.id};
    const revokeEntry=await r.post(rawRevoke), revokeCard=r.adapter.notifyAlert.mock.calls.at(-1)![1]; await r.click(revokeEntry);
    const revoked=r.fm.retireNonceButtons.mock.calls.at(-1)[2];
    const declinedTicket=r.ticket(), rawDecline={kind:'ticket-decision',ticket_id:declinedTicket.id,decision:'decline'};
    const declineEntry=await r.post(rawDecline), declineCard=r.adapter.notifyAlert.mock.calls.at(-1)![1]; await r.click(declineEntry);
    const declined=r.fm.retireNonceButtons.mock.calls.at(-1)[2]; expect(r.store.get(declinedTicket.id)?.state).toBe('declined');
    const staleEntry=await r.post(); r.gen.set('room','r2'); await r.click(staleEntry);
    const stale=r.fm.retireNonceButtons.mock.calls.at(-1)[2]; r.gen.set('room','r1');
    const errorEntry=await r.post(); r.write.mockImplementationOnce(()=>{throw Error('synthetic-failure');}); await r.click(errorEntry);
    const failed=r.fm.retireNonceButtons.mock.calls.at(-1)[2];
    vi.useFakeTimers(); const expiryEntry=await r.post(); await vi.advanceTimersByTimeAsync(300_001);
    expect(r.fm.collapseNoncePrompt).toHaveBeenCalledWith(expiryEntry); expect(r.fm.pendingNonceButtons.has(expiryEntry.nonce)).toBe(false);
    const expired=expiryEntry.expiredText; vi.useRealTimers();
    expect(stale).toBe(expired); expect(confirmed).not.toBe(cancelled); expect(failed).not.toBe(confirmed);
    if(process.env.S217_CARD_EVIDENCE) {
      const {mkdirSync,writeFileSync}=await import('node:fs');
      const card=(value:any)=>({type:value.type,instance:value.instanceName,text:value.message,buttons:value.choices.map((c:any)=>({label:c.label,callback:c.id.replace(/[0-9a-f]{32}/,'<ephemeral-test-nonce>')}))});
      mkdirSync(process.env.S217_CARD_EVIDENCE,{recursive:true});
      writeFileSync(`${process.env.S217_CARD_EVIDENCE}/${language}.json`,JSON.stringify({provenance:'Actual FleetManager nonce posting/callback/timer; synthetic adapter/people, no platform connection. Only ephemeral nonce values redacted.',posted:{mode:{proposal:rawMode,card:card(mode)},contact:{proposal:rawContact,card:card(contact)},decline:{proposal:rawDecline,card:card(declineCard)},adjust:{proposal:rawAdjust,card:card(adjustCard)},revoke:{proposal:rawRevoke,card:card(revokeCard)}},outcomes:{afterConfirm:confirmed,afterModeConfirm:modeConfirmed,afterAdjustConfirm:adjusted,afterRevokeConfirm:revoked,afterCancel:cancelled,afterDeclineConfirmed:declined,expired,stale,failed,unauthorized}},null,2)+'\n');
    }
  } finally {vi.useRealTimers();setLocale('en');}
});
it('even a bot ID accidentally listed as a target administrator cannot confirm a system proposal', async () => {
  const r=rig(); r.fm.contactAdminOf=()=>true;
  const e=await r.post(); await r.click(e,'fake-bot');
  expect(r.write).not.toHaveBeenCalled(); expect(r.fm.pendingNonceButtons.has(e.nonce)).toBe(true);
  await r.click(e); expect(r.write).toHaveBeenCalledOnce();
});
it('unrelated platform callbacks do not touch contact state or require contact initialization', async () => {
  const fm:any=Object.create(FleetManager.prototype);
  expect(await fm.handleContactChangeCallback({callbackData:'existing-feature:callback',userId:'fake-admin'},'demo',{})).toBe(false);
});
it('zh-TW names before Chinese prose are spaced by their ending script, never by a fixture name', async () => {
  const {setLocale}=await import('../src/locale.js'); setLocale('zh-TW');
  try {
    const r=rig();
    for(const [name,expected] of [['Demo room','Demo room '],['Café','Café '],['room 2','room 2 '],['會議室','會議室'],['Demo room）','Demo room）']]) {
      r.host.label=(n:string)=>n==='room'?name!:'Demo worker';
      const tk=r.ticket();
      for(const decision of ['approve-once','decline']) {
        const plan=prepareContactChange({kind:'ticket-decision',ticket_id:tk.id,decision},r.host);
        expect(plan.summary.join('\n')).toContain(`${expected}的聯絡申請`);
      }
    }
  } finally {setLocale('en');}
});
it('compact model schema retains the strict runtime variants and all field bounds', () => {
  const invalid = [
    {kind:'mode',target:'room',mode:'unknown'}, {kind:'ticket-decision',ticket_id:'Rfake',decision:'unknown'},
    {kind:'mode',target:'room'}, {kind:'mode',target:'',mode:'legacy'}, {kind:'mode',target:'room',mode:'legacy',revision:-1},
    {kind:'mode',target:'room',mode:'legacy',ticket_id:'extra'}, {kind:'grant-revoke',target:'worker'},
    {kind:'grant-adjust',target:'worker',grant_id:'g',expires_at:'not-a-date',remaining_uses:null},
    {kind:'grant-adjust',target:'worker',grant_id:'g',expires_at:'2027-01-01T00:00:00Z',remaining_uses:0},
    {kind:'grant-adjust',target:'worker',grant_id:'g',expires_at:'2027-01-01T00:00:00Z',remaining_uses:null,grant:{expiresAt:'2027-01-01T00:00:00Z',remainingUses:null}},
    {kind:'ticket-decision',ticket_id:'Rfake',decision:'decline',grant:{expiresAt:'2027-01-01T00:00:00Z',remainingUses:null}},
    {kind:'ticket-decision',ticket_id:'Rfake',decision:'approve-once',grant:{expiresAt:'2027-01-01T00:00:00Z',remainingUses:10001}},
  ];
  expect(invalid.length).toBeGreaterThan(0);
  for(const change of invalid)expect(ProposeContactChangeArgs.safeParse({change}).success,JSON.stringify(change)).toBe(false);
  expect(ProposeContactChangeArgs.safeParse({change:{kind:'mode',target:'room',mode:'legacy'}}).success).toBe(true);
  expect(ProposeContactChangeArgs.safeParse({change:{kind:'ticket-decision',ticket_id:'Rfake',decision:'approve-once',grant:{expiresAt:'2027-01-01T00:00:00Z',remainingUses:null}}}).success).toBe(true);
});
it.each(['grant-adjust','grant-revoke'] as const)('%s crosses the real FleetManager write boundary and retains neighboring metadata', async kind => {
  const r=rig();
  r.store.writePolicy('worker',{revision:0,grants:[person,other].map(p=>({id:'',person:p,source:'room',target:'worker',verbs:['send_to_instance' as const],expiresAt:new Date(Date.now()+86400000).toISOString(),remainingUses:null}))},admin,n=>r.gen.get(n)!);
  const before=structuredClone(r.store.policy('worker','w1')), row=before.grants[0]!, neighbor=before.grants[1]!;
  r.fm.contactPermissions=(_name:string,actor:ContactPerson)=>({...r.store.policy('worker','w1'),canManage:r.service.canManage('worker',actor),canSetMode:false,eligibleApprovers:[admin]});
  r.fm.webChatOwner=()=>true; r.fm.lifecycle={daemons:new Map()}; r.fm.emitSseEvent=vi.fn(); r.fm.needsYouItems=()=>[];
  r.fm.writeContactPermissions=FleetManager.prototype.writeContactPermissions.bind(r.fm);
  const expiresAt=new Date(Date.now()+2*86400000).toISOString();
  const e=await r.post({kind,target:'worker',grant_id:row.id,...(kind==='grant-adjust'?{expires_at:expiresAt,remaining_uses:3}:{})});
  await r.click(e);
  const after=r.store.policy('worker','w1');
  if(kind==='grant-adjust')expect(after.grants[0]).toEqual({...row,expiresAt,remainingUses:3});
  else expect(after.grants).toEqual([neighbor]);
  expect(after.grants.find(g=>g.id===neighbor.id)).toEqual(neighbor);
  expect(after.revision).toBe(before.revision+1);
});

// ── M-3693: General approves a held message from a person's words (Lumen's admin audit, A1/A2) ─────────────────
import { contactProposalRefusal, resolvePendingTicket } from "../src/contact-change-proposals.js";
import { setLocale, getLocale } from "../src/locale.js";
it('M-3693: the 9-character short id people see approves the held message, through the tool, ending in an admin Confirm card', async () => {
  const r = rig(), ticket = r.ticket(), short = ticket.id.slice(0, 9);
  expect(short).not.toBe(ticket.id);
  const respond = vi.fn();
  await outboundHandlers.get('propose_contact_change')!(r.fm, { change: { kind: 'ticket-decision', ticket_id: short, decision: 'approve-once' } }, respond, { instanceName: 'general', callerCurrent: () => true } as any);
  expect(respond).toHaveBeenCalledWith({ status: 'awaiting_platform_admin_confirmation' });
  const card = [...r.fm.pendingNonceButtons.values()].at(-1);
  expect(r.adapter.notifyAlert.mock.calls.at(-1)![1].message).toContain(short);   // the card names the short id the person used
  expect(r.decide).not.toHaveBeenCalled();                                          // proposing decides nothing
  await r.click(card);
  expect(r.decide).toHaveBeenCalledOnce(); expect(r.decide.mock.calls[0]![0]).toBe(ticket.id);
  expect(r.store.get(ticket.id)!.state).not.toBe('pending');
});
it('M-3693: an id prefix shorter than 9, a prefix two pending tickets share, or a decided ticket is refused with the next step — never guessed', async () => {
  const r = rig(), a = r.ticket();
  expect(() => resolvePendingTicket(r.store, a.id.slice(0, 5))).toThrow('contact-proposal-ticket-unavailable');
  const respond = vi.fn();
  await outboundHandlers.get('propose_contact_change')!(r.fm, { change: { kind: 'ticket-decision', ticket_id: 'Rzzzzzzzz', decision: 'approve-once' } }, respond, { instanceName: 'general', callerCurrent: () => true } as any);
  expect(respond.mock.calls[0]![1]).toMatch(/^Not proposed: no pending held message has that ticket id\..*contact_state/);
  expect(respond.mock.calls[0]![1]).not.toContain('contact-proposal-ticket-unavailable');
});
it('Prism #4436 P2-1: a match behind more than 20 pages of history is found, and a second pending match anywhere makes it ambiguous', () => {
  const r = rig(), oldest = r.ticket();
  // 1100 newer decided tickets (history) fill more than 20 list pages of 50 before the oldest pending one.
  const clone = r.db.prepare("INSERT INTO contact_auth_tickets SELECT ?, ?, request_hash, request_json, json_set(ticket_json,'$.id',?,'$.state','declined'), created_at+? FROM contact_auth_tickets WHERE id=?");
  for (let i = 1; i <= 1100; i++) { const id = `R${randomUUID()}`; clone.run(id, `op-history-${i}`, id, i, oldest.id); }
  expect(r.store.list({}).nextCursor).not.toBeNull();
  expect(resolvePendingTicket(r.store, oldest.id.slice(0, 9)).id).toBe(oldest.id);
  const twin = oldest.id.slice(0, 9) + randomUUID().slice(8);
  r.db.prepare("INSERT INTO contact_auth_tickets SELECT ?, 'op-twin', request_hash, request_json, json_set(ticket_json,'$.id',?), created_at+2000 FROM contact_auth_tickets WHERE id=?").run(twin, twin, oldest.id);
  expect(() => resolvePendingTicket(r.store, oldest.id.slice(0, 9))).toThrow('contact-proposal-ticket-ambiguous');
  r.db.prepare("UPDATE contact_auth_tickets SET ticket_json=json_set(ticket_json,'$.state','declined') WHERE id=?").run(twin);
  expect(resolvePendingTicket(r.store, oldest.id.slice(0, 9)).id).toBe(oldest.id);   // a decided twin does not count
});
it('M-3693: every refusal is a sentence with a next step, in English and zh-TW; an unknown code still says what to do', () => {
  const codes = ['general-only', 'hub-contact-restricted', 'contact-proposal-limit', 'contact-proposal-ticket-unavailable', 'contact-proposal-ticket-ambiguous', 'conflict',
    'stale-generation', 'invalid-grant-origin', 'contact-proposal-not-room', 'not-found', 'invalid-grant', 'forbidden', 'contact-proposal-use-web', 'contact-proposal-route-unavailable'];
  const was = getLocale();
  try {
    for (const locale of ['en', 'zh-TW'] as const) {
      setLocale(locale as any);
      for (const code of codes) {
        const text = contactProposalRefusal(new Error(code));
        expect(text, `${locale} ${code}`).toMatch(locale === 'en' ? /^Not proposed: .{20,}/ : /^沒有提出：.{10,}/);
        expect(text, `${locale} ${code}`).not.toContain(code);
      }
      expect(contactProposalRefusal(new Error('weird-code'))).toContain('contact_state');
    }
  } finally { setLocale(was); }
});
it('M-3693: a `target` on a ticket decision (the audit\'s Sonnet case) is refused naming the field', async () => {
  const r = rig(), ticket = r.ticket(), respond = vi.fn();
  await outboundHandlers.get('propose_contact_change')!(r.fm, { change: { kind: 'ticket-decision', ticket_id: ticket.id.slice(0, 9), decision: 'approve-once', target: 'worker' } }, respond, { instanceName: 'general', callerCurrent: () => true } as any);
  expect(respond.mock.calls[0]![1]).toMatch(/target/);
  expect(r.adapter.notifyAlert).not.toHaveBeenCalled();
});
it('M-3693: contact_state shows held messages (with short id and who decides), rules, room modes and restricting origins — and writes nothing', async () => {
  const r = rig(), ticket = r.ticket();
  r.store.writePolicy('worker', { revision: 0, grants: [{ id: '', person, source: 'room', target: 'worker', verbs: ['send_to_instance' as const], expiresAt: new Date(Date.now() + 86400000).toISOString(), remainingUses: 3 }] }, admin, n => r.gen.get(n)!);
  r.store.inheritOrigin('worker', { kind: 'mixed', people: [person, other], chain: ['room', 'worker'], receiptIds: [] });
  r.store.inheritOrigin('general', { kind: 'human', people: [admin], chain: ['general'], receiptIds: [] });   // a person's origin restricts nothing: not listed
  const changes = r.db.prepare('SELECT total_changes() AS n').get() as { n: number };
  const respond = vi.fn();
  await outboundHandlers.get('contact_state')!(r.fm, {}, respond, { instanceName: 'general' } as any);
  const state = respond.mock.calls[0]![0];
  expect((r.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(changes.n);   // read-only
  expect(state.held).toEqual([expect.objectContaining({ ticket_id: ticket.id, short_id: ticket.id.slice(0, 9), from: 'Demo room (room)', to: 'Demo worker (worker)', verb: 'send_to_instance',
    origin: { kind: 'human', people: ['Demo person (Discord)'] }, decides: ['a fleet admin'], current: true })]);
  expect(state.held[0]).not.toHaveProperty('message');                           // its text is for approvers only
  expect(state.grants).toEqual([expect.objectContaining({ target: 'Demo worker (worker)', person: 'Demo person (Discord)', from: 'Demo room (room)', remaining_uses: 3, grant_id: expect.any(String) })]);
  expect(state.rooms).toEqual([expect.objectContaining({ room: 'Demo room (room)', mode: 'unrestricted', stored_as: 'legacy' })]);
  expect(state.retained_origins).toEqual([expect.objectContaining({ agent: 'Demo worker (worker)', kind: 'mixed', people: ['Demo person (Discord)', 'Demo admin (Discord)'] })]);
  const narrowed = vi.fn();
  await outboundHandlers.get('contact_state')!(r.fm, { agent: 'general' }, narrowed, { instanceName: 'general' } as any);
  expect(narrowed.mock.calls[0]![0]).toMatchObject({ held: [], grants: [], rooms: [], retained_origins: [] });
  const refused = vi.fn();
  await outboundHandlers.get('contact_state')!(r.fm, {}, refused, { instanceName: 'worker' } as any);
  expect(refused.mock.calls[0]![1]).toContain('configured General');
});
it('Prism #4436 P2-2: contact_state writes nothing even when a pending ticket has run out (no expiry write, no revision bump)', async () => {
  const r = rig(), live = r.ticket(), stale = r.ticket();
  r.db.prepare("UPDATE contact_auth_tickets SET ticket_json=json_set(ticket_json,'$.expiresAt',?) WHERE id=?").run(new Date(Date.now() - 60_000).toISOString(), stale.id);
  const before = (r.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, raw = () => JSON.parse((r.db.prepare('SELECT ticket_json FROM contact_auth_tickets WHERE id=?').get(stale.id) as { ticket_json: string }).ticket_json);
  const respond = vi.fn(); await outboundHandlers.get('contact_state')!(r.fm, {}, respond, { instanceName: 'general' } as any);
  expect((r.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(before);
  expect(raw()).toMatchObject({ state: 'pending', revision: stale.revision });       // untouched: the next ordinary read expires it
  expect(respond.mock.calls[0]![0].held.map((h: any) => h.ticket_id)).toEqual([live.id]);   // and it is not shown as held
});
it('Prism #4436 P2-2: the store snapshot and the prefix query leave out a ticket past its expiry, and write nothing', () => {
  const r = rig(), live = r.ticket(), stale = r.ticket();
  r.db.prepare("UPDATE contact_auth_tickets SET ticket_json=json_set(ticket_json,'$.expiresAt',?) WHERE id=?").run(new Date(Date.now() - 60_000).toISOString(), stale.id);
  const before = (r.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  expect(r.store.pendingSnapshot().items.map(t => t.id)).toEqual([live.id]);
  expect(r.store.pendingByPrefix(stale.id.slice(0, 9))).toEqual([]);
  expect(r.store.pendingByPrefix("R%")).toEqual([]);                                  // not an id: never a LIKE pattern
  expect((r.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(before);
});
it('Prism #4436 P2-3: a rule is current only with both exact incarnations, as the proposal matcher requires', async () => {
  const r = rig();
  r.store.writePolicy('worker', { revision: 0, grants: [{ id: '', person, source: 'room', target: 'worker', verbs: ['send_to_instance' as const], expiresAt: new Date(Date.now() + 86400000).toISOString(), remainingUses: null }] }, admin, n => r.gen.get(n)!);
  const read = async () => { const respond = vi.fn(); await outboundHandlers.get('contact_state')!(r.fm, {}, respond, { instanceName: 'general' } as any); return respond.mock.calls[0]![0].grants[0]; };
  expect((await read()).current).toBe(true);
  r.gen.set('room', 'r2');                                                           // the source was replaced
  expect((await read()).current).toBe(false);
  r.gen.set('room', 'r1');
  const policy = r.store.policy('worker'); delete (policy.grants[0] as any).targetGeneration;
  r.db.prepare('UPDATE contact_auth_policies SET policy_json=? WHERE instance=?').run(JSON.stringify(policy), 'worker');
  expect((await read()).current).toBe(false);                                        // a missing binding is not current
});
it('Prism #4436 P3: a field error gets the localized sentence and next step, not the raw schema text', async () => {
  const r = rig(), was = getLocale();
  try {
    for (const [locale, start] of [['en', /^Not proposed: change\.target: .*Check the fields/], ['zh-TW', /^沒有提出：change\.target: .*請依工具說明檢查/]] as const) {
      setLocale(locale as any);
      const respond = vi.fn();
      await outboundHandlers.get('propose_contact_change')!(r.fm, { change: { kind: 'mode', mode: 'restricted' } }, respond, { instanceName: 'general', callerCurrent: () => true } as any);
      expect(respond.mock.calls[0]![1], locale).toMatch(start);
    }
  } finally { setLocale(was); }
});
it('M-3693: the grant_id contact_state shows is the one grant-adjust needs', async () => {
  const r = rig();
  r.store.writePolicy('worker', { revision: 0, grants: [{ id: '', person, source: 'room', target: 'worker', verbs: ['send_to_instance' as const], expiresAt: new Date(Date.now() + 86400000).toISOString(), remainingUses: null }] }, admin, n => r.gen.get(n)!);
  const respond = vi.fn(); await outboundHandlers.get('contact_state')!(r.fm, {}, respond, { instanceName: 'general' } as any);
  const g = respond.mock.calls[0]![0].grants[0];
  const e = await r.post({ kind: 'grant-revoke', target: 'worker', grant_id: g.grant_id });
  expect(e).toBeTruthy(); await r.click(e);
  expect(r.write).toHaveBeenCalledOnce();
});
it('M-3693: the short id is the web\'s (shortTicketId): the card, the Authorizations page and contact_state print the same one', async () => {
  const ui = "../src/ui/contact-auth-client.js";   // an untyped browser module: imported by path
  const { shortTicketId } = await import(ui) as { shortTicketId(id: string): string };
  const { shortContactTicketId } = await import("../src/contact-change-proposals.js");
  const r = rig(), ticket = r.ticket();
  for (const id of [ticket.id, 'R1234abcd-not-a-ticket', 'plain']) expect(shortContactTicketId(id)).toBe(shortTicketId(id));
  const respond = vi.fn(); await outboundHandlers.get('contact_state')!(r.fm, {}, respond, { instanceName: 'general' } as any);
  expect(respond.mock.calls[0]![0].held[0].short_id).toBe(shortTicketId(ticket.id));
});
