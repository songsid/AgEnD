/** Durable directory security history. Reads do not acknowledge; sockets and transient feeds are not the outbox. */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { HubAuditStore } from "./audit/index.js";
import type { HubRequestContext, PersonKey } from "./types.js";
import type { HubTransportStore } from "./store.js";
import { canonicalArguments, personKeyString } from "./identity.js";
import { createHubDirectorySettingsDecision, parseHubDirectorySecurityNotice, type HubDirectorySecurityNotice } from "./settings-directory-decision.js";
import { epoch, identifier, person, uuid, validated, parseStrictJson, HubProtocolError } from "./validation.js";

const querySchema = z.strictObject({ before: uuid.optional(), limit: z.number().int().min(1).max(100).default(50), unread: z.boolean().default(false) });
export const HUB_DIRECTORY_HOST_NOTICE_SINK = "owner-needs-you";
export function parseHubDirectoryNoticeQuery(raw: unknown) { return validated(querySchema, raw); }
export type HubDirectoryNoticeQuery = z.input<typeof querySchema>;
export interface HubDirectoryNoticeView {
  id: string; operationId: string; kind: HubDirectorySecurityNotice["kind"]; phase: "applying"; at: number;
  changes: HubDirectorySecurityNotice["changes"];
  actor: { kind: "host-owner" } | { kind: "hub-administrator"; person: PersonKey };
  acknowledged: boolean;
}
export interface HubDirectoryNoticePage { v: 1; items: HubDirectoryNoticeView[]; nextBefore: string | null }
/** Private adapter only: the host HTTP layer must supply its D3/hostSessionHere authority, never a body flag. */
export interface HubDirectoryNoticeHostContext { requestId: string; current(): boolean }
interface Row { serial: number; id: string; operation_id: string; body: string; state: "queued" | "delivered" }
interface Access { kind: "host" | "person"; target: string; actor: PersonKey | null; requestId: string; current(): boolean }
const same = (a: unknown, b: unknown) => canonicalArguments(a) === canonicalArguments(b);

export function createHubDirectoryNotices(options: {
  db: Database.Database; transport: HubTransportStore; hubId: string; hostSink: string;
  audit: Pick<HubAuditStore, "appendInTransaction">; current(): boolean; now?: () => number;
}) {
  const { db } = options, hostSink = validated(identifier, options.hostSink);
  const decision = createHubDirectorySettingsDecision(options);
  let closed = false;
  function available() {
    if (closed || options.current() !== true) throw new HubProtocolError("unavailable");
  }
  function check(access: Access) {
    available();
    if (access.current() !== true) throw new HubProtocolError("revoked");
  }
  function row(access: Access, id: string): Row {
    const found = db.prepare(`SELECT n.rowid serial,n.id,n.operation_id,n.body,t.state FROM hub_settings_security_notices n
      JOIN hub_settings_security_targets t ON t.notice_id=n.id WHERE n.id=? AND t.kind=? AND t.target=?`)
      .get(id, access.kind, access.target) as Row | undefined;
    if (!found) throw new HubProtocolError("not-found");
    view(access, found); return found;
  }
  function view(access: Access, saved: Row): HubDirectoryNoticeView {
    const notice = parseHubDirectorySecurityNotice(parseStrictJson(saved.body)), operation = decision.operation(notice.operationId);
    if (!Number.isSafeInteger(saved.serial) || saved.serial < 1 || notice.id !== saved.id || notice.operationId !== saved.operation_id
      || !["queued", "delivered"].includes(saved.state)
      || !same([notice.kind, notice.actor, notice.at, notice.changes, notice.recipients],
        [operation.kind, operation.actor, operation.at, operation.changes, operation.recipients])
      || !notice.recipients.some(r => r.kind === access.kind && (r.kind === "host" ? r.sink : personKeyString(r.person)) === access.target)) {
      throw new HubProtocolError("uncertain");
    }
    // No recipient list, issuing session/request IDs, directory values, file images or secret references leave this projection.
    return { id: notice.id, operationId: notice.operationId, kind: notice.kind, phase: notice.phase, at: notice.at,
      changes: notice.changes, actor: notice.actor.kind === "host-owner" ? { kind: "host-owner" }
        : { kind: "hub-administrator", person: notice.actor.person }, acknowledged: saved.state === "delivered" };
  }
  function audit(access: Access, action: "directory.notice-disclosed" | "directory.notice-acknowledged", version: number) {
    const result: unknown = options.audit.appendInTransaction({ id: randomUUID(), sequence: 0,
      at: validated(epoch, options.now?.() ?? Date.now()), requestId: access.requestId,
      actor: access.actor ? { kind: "person", person: access.actor } : { kind: "local-host" }, action,
      result: action === "directory.notice-disclosed" ? "allowed" : "completed", policyVersion: version }, db);
    if (result && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") {
      try { (result as PromiseLike<unknown>).then(undefined, () => undefined); } catch { /* refused below */ }
      throw new HubProtocolError("unavailable");
    }
  }
  function transaction<T>(access: Access, work: (version: number, retain: (r: Row) => void) => T): T {
    check(access);
    if (db.inTransaction) throw new HubProtocolError("invalid");
    return db.transaction(() => {
      const expected = decision.inspect(), images = new Map<string, Row>();
      const result = work(expected.authorizationVersion, r => images.set(r.id, { ...r }));
      // Caller/audit callbacks may revoke authority or mutate rows. No callback follows these final SQL comparisons.
      check(access);
      if (!same(decision.inspect(), expected)) throw new HubProtocolError("conflict");
      for (const saved of images.values()) if (!same(row(access, saved.id), saved)) throw new HubProtocolError("conflict");
      return result;
    }).immediate();
  }
  function read(access: Access, query: z.output<typeof querySchema>): HubDirectoryNoticePage {
    return transaction(access, (version, retain) => {
      const anchor = query.before ? row(access, query.before) : undefined;
      if (anchor) retain(anchor);
      const rows = db.prepare(`SELECT n.rowid serial,n.id,n.operation_id,n.body,t.state FROM hub_settings_security_notices n
        JOIN hub_settings_security_targets t ON t.notice_id=n.id WHERE t.kind=? AND t.target=?
        AND (? IS NULL OR n.rowid<?) AND (?=0 OR t.state='queued') ORDER BY n.rowid DESC LIMIT ?`)
        .all(access.kind, access.target, anchor?.serial ?? null, anchor?.serial ?? null, Number(query.unread), query.limit + 1) as Row[];
      const views = rows.map(r => { retain(r); return view(access, r); });
      audit(access, "directory.notice-disclosed", version);
      return { v: 1, items: views.slice(0, query.limit), nextBefore: views.length > query.limit ? views[query.limit - 1]!.id : null };
    });
  }
  function acknowledge(access: Access, id: string): void {
    transaction(access, (version, retain) => {
      const saved = row(access, id);
      if (saved.state === "queued") {
        audit(access, "directory.notice-acknowledged", version);
        if (!same(row(access, id), saved)) throw new HubProtocolError("conflict");
        const changed = db.prepare(`UPDATE hub_settings_security_targets SET state='delivered'
          WHERE notice_id=? AND kind=? AND target=? AND state='queued'`).run(id, access.kind, access.target);
        if (changed.changes !== 1) throw new HubProtocolError("conflict");
      }
      retain({ ...saved, state: "delivered" });
    });
  }
  async function session(ctx: HubRequestContext): Promise<Access> {
    available();
    const requestId = validated(identifier, ctx.requestId), requirePerson = ctx.requirePerson.bind(ctx), current = ctx.current.bind(ctx);
    const isCurrent = ctx.isCurrent?.bind(ctx), who = validated(person, await requirePerson()), actor = await current();
    if (actor.kind !== "directory" || personKeyString(validated(person, actor.person)) !== personKeyString(who)) throw new HubProtocolError("revoked");
    return { kind: "person", target: personKeyString(who), actor: who, requestId, current: () => isCurrent?.() === true };
  }
  function host(ctx: HubDirectoryNoticeHostContext): Access {
    return { kind: "host", target: hostSink, actor: null, requestId: validated(identifier, ctx.requestId), current: ctx.current.bind(ctx) };
  }
  return {
    async forSession(ctx: HubRequestContext, raw: HubDirectoryNoticeQuery = {}): Promise<HubDirectoryNoticePage> {
      const query = validated(querySchema, raw); return read(await session(ctx), query);
    },
    async acknowledgeSession(ctx: HubRequestContext, raw: string): Promise<void> {
      const id = validated(uuid, raw); acknowledge(await session(ctx), id);
    },
    forHost(ctx: HubDirectoryNoticeHostContext, raw: HubDirectoryNoticeQuery = {}): HubDirectoryNoticePage {
      const query = validated(querySchema, raw); return read(host(ctx), query);
    },
    acknowledgeHost(ctx: HubDirectoryNoticeHostContext, raw: string): void { const id = validated(uuid, raw); acknowledge(host(ctx), id); },
    close(): void { closed = true; },
  };
}
export type HubDirectoryNotices = ReturnType<typeof createHubDirectoryNotices>;
