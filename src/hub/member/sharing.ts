/** Hub owner requests use the same writer as Settings. The journal, never a chat button, proves each effect. */
import type { HubAgentCatalog, HubExposureRequest } from "../agent-catalog-model.js";
import type { HubLocalExposure } from "../execution/service.js";
import { canonicalArguments } from "../identity.js";
import { HubProtocolError } from "../validation.js";
import type { HubAuditRecord } from "../types.js";
import { HUB_AGENT_MODE } from "./agent-mode.js";
import type { MemberCatalogAgent } from "./agent-catalog.js";
import type { HubMemberExposureApi } from "./exposure-api.js";
import { HubExposureRefusal, type HubExposureCommit, type HubExposureStore } from "./exposures.js";
import { HubMemberSharingJournal, type SharingPlan, type SharingRecord } from "./sharing-journal.js";

type Refusal = Extract<SharingRecord["rows"][number]["outcome"], { ok: false }>["code"];
export interface HubMemberSharingOptions {
  journal: HubMemberSharingJournal;
  store: HubExposureStore;
  api: HubMemberExposureApi;
  catalog(): HubAgentCatalog;
  agents(): MemberCatalogAgent[];
  current(): boolean;
  enabled(): boolean;
  /** M-3543: the agent's published share lapsed (backend/folder changed since); Share again may republish it. */
  lapsed?(agent: string): boolean;
  now(): number;
  /** Upsert the same web notice durably. False means definitely not saved; a throw is uncertain. */
  notice(record: SharingRecord): Promise<boolean>;
  snapshot(): Promise<unknown>;
}
const same = (a: unknown, b: unknown) => canonicalArguments(a) === canonicalArguments(b);

export class HubMemberSharing {
  private tail: Promise<unknown> = Promise.resolve();
  private fence: (() => boolean) | null = null;
  constructor(private readonly options: HubMemberSharingOptions) {}
  private serial<T>(work: () => Promise<T>, fence?: () => boolean): Promise<T> {
    const result = this.tail.then(async () => {
      this.fence = fence ?? null;
      try { return await work(); } finally { this.fence = null; }
    });
    this.tail = result.catch(() => {});
    return result;
  }
  private current(): void {
    if (!this.options.current() || this.fence && !this.fence()) throw new HubProtocolError("stale");
  }
  private token(agent: string): string | null {
    return this.options.agents().find(row => row.instance === agent)?.incarnation ?? null;
  }
  private local(agent: string): HubLocalExposure | null {
    return this.options.store.list().find(row => row.agent === agent)?.committed ?? null;
  }
  private plan(request: HubExposureRequest): SharingPlan[] {
    const sources = this.options.agents(), locals = this.options.store.list();
    return [...request.share.map(target => ({ action: "share" as const, target })),
      ...request.stop.map(target => ({ action: "stop" as const, target }))].map(({ action, target }) => {
      const before = action === "share" ? locals.find(row => row.agent === target)?.committed ?? null
        : locals.find(row => row.committed?.exposure.id === target)?.committed ?? null;
      const source = sources.find(row => row.instance === (action === "share" ? target : before?.agent));
      return { action, target, before, agent: source?.instance ?? null, name: source?.displayName ?? before?.exposure.displayName ?? target,
        kind: source?.kind ?? "agent", incarnation: source?.incarnation ?? null };
    });
  }
  private refusal(record: SharingRecord, row: SharingPlan, undo: boolean): Refusal | null {
    if (!undo && !this.options.enabled()) return "switched-off";
    if (!undo && this.options.now() >= record.request.expiresAt) return "expired";
    if (undo && (record.undoUntil === null || this.options.now() >= record.undoUntil)) return "expired";
    if (!row.agent || !row.incarnation) return "unknown-agent";
    const source = this.options.agents().find(agent => agent.instance === row.agent);
    if (!source || source.incarnation !== row.incarnation) return "stale-list";
    if (!source.shareable && (row.action === "share") !== undo) return "not-shareable";
    return null;
  }
  private receipt(record: SharingRecord, index: number, undo: boolean): HubExposureCommit {
    const row = record.rows[index]!;
    const actor: HubAuditRecord["actor"] = undo ? { kind: "local-host" } : { kind: "person", person: record.request.by };
    return { requestId: undo ? record.undoId! : record.id, actor,
      assertCurrent: () => {
        this.current();
        const refusal = this.refusal(record, row, undo);
        if (refusal) throw new HubProtocolError(refusal === "expired" ? "expired" : "stale");
        return undefined;
      },
      committed: next => undo ? this.options.journal.undone(record.id, index, next) : this.options.journal.applied(record.id, index, next) };
  }
  private knownRefusal(error: unknown): Refusal | null {
    if (!(error instanceof HubExposureRefusal)) return null;
    return error.code === "limit" ? "limit" : error.code === "unknown_agent" ? "unknown-agent"
      : error.code === "not_enforceable" ? "not-shareable" : "stale-list";
  }
  private async change(record: SharingRecord, index: number, undo: boolean): Promise<void> {
    const row = record.rows[index]!;
    if (undo ? row.outcome?.ok !== true || row.undoOutcome !== null : row.outcome !== null) return;
    this.current();
    let refusal = this.refusal(record, row, undo);
    const expected = undo ? row.after : row.before;
    if (!refusal && !same(this.local(row.agent!), expected)) refusal = "stale-list";
    const publishing = (row.action === "share") !== undo;
    // Ticking an already shared agent is not permission to revise it; only a withdrawn/absent mapping can be shared —
    // except M-3543's Share again of a lapsed one (the owner re-consents for the agent as it is now; #3147 holds).
    const lapsedAgain = !undo && publishing && expected?.exposure.state === "published" && (() => { try { return this.options.lapsed?.(row.agent!) === true; } catch { return false; } })();
    if (!refusal && !undo && publishing && expected?.exposure.state !== undefined && expected.exposure.state !== "withdrawn" && !lapsedAgain) refusal = "stale-list";
    if (!refusal && !publishing && (!expected || expected.exposure.state === "withdrawn")) refusal = "stale-list";
    if (refusal) { this.options.journal.refuse(record.id, index, refusal, undo); return; }
    try {
      const receipt = this.receipt(record, index, undo);
      if (publishing) {
        this.options.api.publish({ agent: row.agent!, dataViewId: HUB_AGENT_MODE, tools: [],
          expectedRevision: expected?.exposure.revision ?? 0, contactLimit: undo ? row.before?.contactLimit !== false : true }, receipt);
      } else await this.options.api.withdraw(expected!.exposure.id, expected!.exposure.revision, receipt);
    } catch (error) {
      // An atomic receipt wins over a lost caller result. An unclassified failure remains pending, never "not shared".
      const saved = this.options.journal.read(record.id)!.rows[index]!;
      if ((undo ? saved.undoOutcome : saved.outcome)?.ok) return;
      const code = this.knownRefusal(error);
      if (!code) throw error;
      this.options.journal.refuse(record.id, index, code, undo);
    }
  }
  async apply(id: string, request: HubExposureRequest, current?: () => boolean): Promise<SharingRecord> {
    return this.serial(async () => {
      this.current();
      this.options.journal.prune();
      let record = this.options.journal.read(id);
      const fresh = !record;
      const catalog = fresh ? this.options.catalog() : null;
      const refused = fresh && !this.options.enabled() ? "switched-off"
        : fresh && catalog!.revision !== request.catalogRevision ? "stale-list" : undefined;
      record = this.options.journal.reserve(id, request, fresh ? this.plan(request) : [], refused);
      if (record.finalNoticeDurable) return record;
      if (!record.noticeDurable) {
        record = this.options.journal.prepareNotice(id);
        if (!await this.options.notice(record)) {
          this.options.journal.noticeRefused(id);
          throw new HubProtocolError("unavailable");
        }
        this.current(); this.options.journal.noticeSaved(id);
      }
      for (let i = 0; i < record.rows.length; i++) await this.change(this.options.journal.read(id)!, i, false);
      record = this.options.journal.read(id)!;
      if (!await this.options.notice(record)) throw new HubProtocolError("unavailable");
      this.current(); this.options.journal.finalNoticeSaved(id);
      await this.options.snapshot();
      return this.options.journal.read(id)!;
    }, current);
  }
  /** The caller supplies a rechecked local-admin fence, never an AD identity inferred from the local administrator. */
  async undo(noticeKey: string, actor: string, authorized: () => boolean): Promise<SharingRecord> {
    return this.serial(async () => {
      this.current(); if (!authorized()) throw new HubProtocolError("denied");
      let record = this.options.journal.byNotice(noticeKey);
      if (!record) throw new HubProtocolError("not-found");
      this.fence = authorized;
      record = this.options.journal.beginUndo(record.id, actor);
      for (let i = 0; i < record.rows.length; i++) {
        if (!authorized()) throw new HubProtocolError("denied");
        await this.change(record, i, true);
        record = this.options.journal.read(record.id)!;
      }
      if (!await this.options.notice(record)) throw new HubProtocolError("unavailable");
      this.current(); if (!authorized()) throw new HubProtocolError("denied");
      this.options.journal.undoNoticeSaved(record.id);
      await this.options.snapshot();
      return this.options.journal.read(record.id)!;
    });
  }
}
