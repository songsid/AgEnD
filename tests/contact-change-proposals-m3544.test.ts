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
  const host = { service, generation: (n: string) => gen.get(n)!, label: (n: string) => `Demo ${n}`, timeZone: () => "Asia/Taipei", mode: (n: string) => modes.get(n) as any, modeAdmin: fm.contactAdminOf, write, decide };
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
it('ticket approval with rules uses real store and target configured approver; single-use nonce cannot admit twice', async () => {
  const r = rig(), ticket = r.ticket();
  r.store.writePolicy('worker', { revision: 0, approvers: [other] }, admin, n => r.gen.get(n)!);
  const input = { kind: 'ticket-decision', ticket_id: ticket.id, decision: 'approve-once', grant: { expiresAt: new Date(Date.now()+86400000).toISOString(), remainingUses: null, personKeys: [contactPersonKey(person)] } };
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
