import type Database from "better-sqlite3";
import { HUB_ROOM_POST_CAPABILITY, roomPostSchema, roomPostResultSchema, roomListResultSchema,
  roomMembersSchema, roomMembersResultSchema, peopleSearchSchema, peopleSearchResultSchema } from "../protocol.js";
import type { HubRoomListResult, HubRoomPostResult, HubRoomMembersResult, HubPeopleSearchResult, HubRoomPostAnswer } from "../types.js";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ROOM_HUMAN_RECEIPT, type RoomReceiptProof } from "./room-post-receipt.js";
import { HubRoomPostAnswers, verifyRoomPostAnswers, type RoomPostAnswerLink, type RoomPostNotification, type RoomPostSource } from "./room-post-answers.js";
export interface RoomCaller { agent: string; current(): boolean }
export interface RoomIdentity { exposureId: string; revision: number; consentId: string; token: string }
export type RoomListResult = HubRoomListResult | { ok:false; code:"unavailable"|"stale" };
export type RoomPostResult = HubRoomPostResult | { ok:false; code:"uncertain" };
export interface RoomPostLink {
  features: ReadonlySet<string>; current(): boolean;
  list(exposureId: string): Promise<HubRoomListResult>;
  members?(exposureId: string, room: string): Promise<HubRoomMembersResult>;
  people?(exposureId: string, q: string): Promise<HubPeopleSearchResult>;
  ack?(id: string): void | Promise<void>;
  post(value: { exposureId: string; room: string; text: string; idempotencyKey: string; onBehalfOf?: {receiptId:string} }): Promise<HubRoomPostResult>;
}
export interface AgentRoomPort {
  available(): boolean;
  rooms(caller: RoomCaller): Promise<RoomListResult>;
  members(caller: RoomCaller, room: string): Promise<HubRoomMembersResult>;
  people(caller: RoomCaller, q: string): Promise<HubPeopleSearchResult>;
  post(caller: RoomCaller, value: { room: string; text: string; operationId: string; receiptId?: string }): Promise<RoomPostResult>;
}
export interface RoomPostOptions {
  db: Database.Database; binding: string; encryptionKey: Buffer;
  current(): boolean; local(agent: string): RoomIdentity | null;
  receipt?(caller: RoomCaller, receiptId: string): RoomReceiptProof | null;
  notify?(input: RoomPostNotification): Promise<boolean>;
  held?(id: string): void;
  changed?(): void;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
interface Saved { agent: string; local: RoomIdentity; room: string; text: string; receiptId?: string; result?: RoomPostResult }
const aad = (binding: string, id: string) => Buffer.from(JSON.stringify(["agend-room-post-v1", binding, id]));
type JournalOptions = Pick<RoomPostOptions, "db" | "binding" | "encryptionKey">;
function read(options: JournalOptions, id: string, value: string): Saved {
  const bytes = Buffer.from(value, "base64");
  const decipher = createDecipheriv("aes-256-gcm", options.encryptionKey, bytes.subarray(0, 12));
  decipher.setAAD(aad(options.binding, id)); decipher.setAuthTag(bytes.subarray(12, 28));
  const saved = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")) as Saved;
  if (!saved || typeof saved.agent !== "string" || !saved.local || !UUID.test(saved.local.exposureId)
    || typeof saved.local.token !== "string" || typeof saved.local.consentId !== "string"
    || !Number.isSafeInteger(saved.local.revision) || typeof saved.room !== "string" || typeof saved.text !== "string"
    || saved.receiptId !== undefined && !ROOM_HUMAN_RECEIPT.test(saved.receiptId)) throw Error("Invalid room post journal");
  if (saved.result && (!saved.result.ok || !roomPostResultSchema.safeParse(saved.result).success)) throw Error("Invalid saved post result");
  return saved;
}
/** Authenticate retained posts before any recovery/adoption; never fall back to an empty journal. */
export function verifyRoomPostJournal(options: JournalOptions): void {
  options.db.exec("CREATE TABLE IF NOT EXISTS hub_room_posts(operation_id TEXT PRIMARY KEY,binding TEXT NOT NULL,value TEXT NOT NULL)");
  for (const row of options.db.prepare("SELECT * FROM hub_room_posts").all() as { operation_id: string; binding: string; value: string }[]) {
    if (!UUID.test(row.operation_id) || row.binding !== options.binding) throw Error("Room post journal binding changed");
    read(options, row.operation_id, row.value);
  }
  verifyRoomPostAnswers(options);
}
/** Frozen durable calls; reconnect alone never sends a post. Only the same operation may retry its exact body. */
export class HubRoomPostAdapter implements AgentRoomPort {
  private link: RoomPostLink | null = null;
  private closed = false;
  private pending = new Map<string, Promise<RoomPostResult>>();
  private byPost = new Map<string,string>();
  private answers: HubRoomPostAnswers;
  private answerLink: RoomPostAnswerLink | null = null;
  constructor(private options: RoomPostOptions) {
    verifyRoomPostJournal(options);
    for (const row of options.db.prepare("SELECT operation_id,value FROM hub_room_posts").all() as {operation_id:string;value:string}[]) {
      const saved=read(options,row.operation_id,row.value);
      if(saved.result?.ok){if(this.byPost.has(saved.result.messageId))throw Error("Conflicting retained room post");this.byPost.set(saved.result.messageId,row.operation_id);}
    }
    this.answers=new HubRoomPostAnswers({...options,source:id=>this.source(id),
      current:source=>same(this.local(source.agent),source.local)&&this.available(),deliver:input=>options.notify?.(input)??Promise.resolve(false)});
  }
  private source(postId: string): RoomPostSource | null {
    const id=this.byPost.get(postId);if(!id)return null;
    const row=this.options.db.prepare("SELECT value FROM hub_room_posts WHERE operation_id=?").get(id) as {value:string}|undefined;
    if(!row)return null;const saved=read(this.options,id,row.value);
    return saved.result?.ok&&saved.result.messageId===postId?{agent:saved.agent,local:saved.local,roomId:saved.result.roomId,
      ...(saved.receiptId?{receiptId:saved.receiptId}:{})}:null;
  }
  connected(link: RoomPostLink | null): void {
    this.link = link;
    this.answerLink=link?.ack?{current:()=>this.link===link&&this.available(),ack:id=>link.ack!(id)}:null;
    this.answers.connected(this.answerLink);this.options.changed?.();
  }
  receiveAnswer(answer: HubRoomPostAnswer, source: RoomPostLink): boolean {
    return source===this.link&&!!this.answerLink&&this.answers.receive(answer,this.answerLink);
  }
  flushAnswers(): Promise<void> { return this.answers.flush(); }
  answersSettled(): Promise<void> { return this.answers.settled(); }
  deliveryFailed(id: string, agent: string): void { this.answers.deliveryFailed(id,agent); }
  available(): boolean {
    try { return !this.closed && this.options.current() && !!this.link?.current()
      && ["welcome-caps-v1", "room-ask-v1", HUB_ROOM_POST_CAPABILITY].every(cap => this.link!.features.has(cap)); }
    catch { return false; }
  }
  private current(caller: RoomCaller, local: RoomIdentity, link: RoomPostLink): boolean {
    try { return caller.current() && this.available() && link === this.link && same(this.options.local(caller.agent), local); }
    catch { return false; }
  }
  private local(agent: string): RoomIdentity | null { try { const value=this.options.local(agent); return value ? {...value} : null; } catch { return null; } }
  async rooms(caller: RoomCaller): Promise<RoomListResult> {
    const link = this.link, local = this.local(caller.agent);
    if (!link || !local || !this.current(caller, local, link)) return { ok: false, code: "unavailable" };
    try {
      const result = roomListResultSchema.parse(await link.list(local.exposureId));
      if (!this.current(caller, local, link)) return { ok: false, code: "stale" };
      if (result.exposureId !== local.exposureId) return { ok: false, code: "stale" };
      return result;
    } catch { return { ok: false, code: "unavailable" }; }
  }
  async members(caller: RoomCaller, room: string): Promise<HubRoomMembersResult> {
    const link=this.link,local=this.local(caller.agent);
    if(!roomMembersSchema.safeParse({exposureId:local?.exposureId,room}).success)return {ok:false,code:"invalid"};
    if(!link?.members||!local||!this.current(caller,local,link))return {ok:false,code:"unavailable"};
    try{const result=roomMembersResultSchema.parse(await link.members(local.exposureId,room));
      return this.current(caller,local,link)?result:{ok:false,code:"stale"};}catch{return {ok:false,code:"unavailable"};}
  }
  async people(caller: RoomCaller, q: string): Promise<HubPeopleSearchResult> {
    const link=this.link,local=this.local(caller.agent);
    if(!peopleSearchSchema.safeParse({exposureId:local?.exposureId,q}).success)return {ok:false,code:"invalid"};
    if(!link?.people||!local||!this.current(caller,local,link))return {ok:false,code:"unavailable"};
    try{const result=peopleSearchResultSchema.parse(await link.people(local.exposureId,q));
      return this.current(caller,local,link)?result:{ok:false,code:"stale"};}catch{return {ok:false,code:"unavailable"};}
  }
  private write(id: string, saved: Saved): void {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.options.encryptionKey, iv);
    cipher.setAAD(aad(this.options.binding, id));
    const content = Buffer.concat([cipher.update(JSON.stringify(saved)), cipher.final()]);
    const value = Buffer.concat([iv, cipher.getAuthTag(), content]).toString("base64");
    this.options.db.prepare("INSERT INTO hub_room_posts VALUES(?,?,?) ON CONFLICT(operation_id) DO UPDATE SET value=excluded.value").run(id, this.options.binding, value);
    if(saved.result?.ok)this.byPost.set(saved.result.messageId,id);
  }
  async post(caller: RoomCaller, input: { room: string; text: string; operationId: string; receiptId?: string }): Promise<RoomPostResult> {
    const link = this.link, local = this.local(caller.agent), id = input.operationId;
    if (!UUID.test(id) || !roomPostSchema.safeParse({exposureId:local?.exposureId,room:input.room,text:input.text,idempotencyKey:id}).success
      || input.receiptId !== undefined && !ROOM_HUMAN_RECEIPT.test(input.receiptId)) return { ok: false, code: "invalid" };
    if (!link || !local || !this.current(caller, local, link)) return { ok: false, code: "unavailable" };
    try {
      const proof = input.receiptId ? this.options.receipt?.(caller, input.receiptId) : undefined;
      if (input.receiptId && (!proof || proof.receiptId !== input.receiptId || !proof.current())) return {ok:false,code:"denied"};
      const authorized = () => this.current(caller, local, link) && (!proof || proof.current());
      const row = this.options.db.prepare("SELECT binding,value FROM hub_room_posts WHERE operation_id=?").get(id) as { binding:string; value: string } | undefined;
      if (row && row.binding !== this.options.binding) return {ok:false,code:"uncertain"};
      const saved: Saved = row ? read(this.options, id, row.value) : { agent: caller.agent, local, room: input.room, text: input.text, ...(input.receiptId ? {receiptId:input.receiptId} : {}) };
      if (saved.agent !== caller.agent || saved.room !== input.room || saved.text !== input.text || saved.receiptId !== input.receiptId) return { ok: false, code: "conflict" };
      if (!same(saved.local, local)) return { ok: false, code: "stale" };
      if (saved.result) return saved.result;
      if (!row) this.write(id, saved); // Intent is durable before any bytes can reach the Hub.
      let pending = this.pending.get(id);
      if (!pending) {
        pending = (async (): Promise<RoomPostResult> => {
          try {
            if (!authorized()) return { ok: false, code: "stale" };
            const result = roomPostResultSchema.parse(await link.post({ exposureId: local.exposureId, room: saved.room, text: saved.text, idempotencyKey: id,
              ...(saved.receiptId ? {onBehalfOf:{receiptId:saved.receiptId}} : {}) }));
            // A lost owner/link can hide a committed result; never claim that the post failed or retry with a new key.
            if (!authorized()) return { ok: false, code: "uncertain" };
            if (result.ok) this.write(id, { ...saved, result });
            return result;
          } catch { return { ok: false, code: "uncertain" }; }
        })();
        this.pending.set(id, pending);
        const work = pending;
        void work.then(() => { if (this.pending.get(id) === work) this.pending.delete(id); });
      }
      const result = await pending;
      if (!authorized()) return { ok: false, code: "uncertain" };
      return result;
    } catch { return { ok: false, code: "uncertain" }; }
  }
  close(): void { this.closed = true; this.answers.close(); this.connected(null); }
}
