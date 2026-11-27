/** A person's policy handoff is a task notice, never a pane answer or reassignment. */
import { createHash } from "node:crypto";
import type { LivenessCard } from "./dispatcher-liveness.js";
import type { LivenessLedger } from "./scheduler/task-liveness.js";

const ACCEPTED = new Set(["queued", "delivering", "submission_started", "reconciliation_pending", "retry_wait", "delivered", "uncertain"]);
export interface PolicyHandoffDeps {
  cards(): LivenessCard[];
  ledger: LivenessLedger;
  current(): boolean;
  isInstance(name: string): boolean;
  boardOff(name: string): boolean;
  noticeState(key: string): string | null;
  deliver(target: string, message: string, key: string): boolean;
  withdraw?(key: string): void;
  message(card: LivenessCard): string;
  now(): number;
}
export function policyHandoffStatus(cards: LivenessCard[], ledger: LivenessLedger, assignee: string, identity?: string | null, noticeState: (key: string) => string | null = () => null) {
  const owned = cards.filter(c => c.assignee === assignee);
  const handed = owned.flatMap(c => {
    const row = ledger.get(c.uuid);
    return row?.policyHandoff && row.kind === "prompt" && row.detail === "codex_policy_recourse" && (!identity || row.policyHandoff === identity) && row.assignee === assignee && row.dispatcher === c.dispatcher?.name
      && (!row.noticeKey || !["failed", "cancelled"].includes(noticeState(row.noticeKey) ?? "")) ? [row] : [];
  });
  return { done: handed.length, total: owned.length, ...(handed.length ? { at: Math.max(...handed.map(row => row.notifiedAt)) } : {}) };
}
export function handoffPolicyRecourse(d: PolicyHandoffDeps, assignee: string, identity: string, since: number) {
  const result = { done: [] as string[], failed: [] as string[] };
  if (!/^selection:[0-9a-f]{64}$/.test(identity) || !d.current()) return result;
  const cards = d.cards().filter(c => c.assignee === assignee);
  for (const card of cards) {
    const disp = card.dispatcher;
    const assigned = () => d.cards().some(c => c.uuid === card.uuid && c.assignee === assignee && c.dispatcher?.name === disp?.name && c.dispatcher?.kind === disp?.kind);
    if (!d.current() || !assigned() || !disp || disp.name === assignee || (disp.kind === "instance" && (!d.isInstance(disp.name) || d.boardOff(disp.name)))) {
      result.failed.push(card.code); continue;
    }
    const old = d.ledger.get(card.uuid);
    const matching = old?.assignee === assignee && old.dispatcher === disp.name;
    if (matching && old.kind === "prompt" && old.detail === "codex_policy_recourse" && old.policyHandoff === identity) {
      if (old.noticeKey && ["failed", "cancelled"].includes(d.noticeState(old.noticeKey) ?? "")) result.failed.push(card.code);
      else result.done.push(card.code);
      continue;
    }
    // A human handoff is a new reassignment instruction, distinct from an earlier automatic blocked-work alert.
    let key: string | null = null;
    try {
      if (disp.kind === "instance") {
        key = `policy-handoff:${createHash("sha256").update(JSON.stringify([assignee, card.uuid, disp.name, identity])).digest("hex")}`;
        const state = d.noticeState(key);
        if (state !== null && !ACCEPTED.has(state)) { result.failed.push(card.code); continue; }
        if (state === null && !d.deliver(disp.name, d.message(card), key)) { result.failed.push(card.code); continue; }
        if (!ACCEPTED.has(d.noticeState(key) ?? "")) { result.failed.push(card.code); continue; }
      }
      if (!d.current() || !assigned()) { result.failed.push(card.code); continue; }
      d.ledger.open({ cardUuid: card.uuid, assignee, dispatcher: disp.name, dispatcherKind: disp.kind,
        kind: "prompt", since, detail: "codex_policy_recourse", noticeKey: key, notifiedAt: d.now(),
        needsYou: disp.kind === "person", policyHandoff: identity });
      if (matching && old.noticeKey && old.noticeKey !== key && d.ledger.openWithKey(old.noticeKey) === 0) {
        try { d.withdraw?.(old.noticeKey); } catch { /* admitted handoff remains valid; cleanup is best effort */ }
      }
      result.done.push(card.code);
    } catch { result.failed.push(card.code); }
  }
  return result;
}
