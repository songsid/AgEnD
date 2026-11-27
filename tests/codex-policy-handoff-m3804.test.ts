import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LivenessLedger } from "../src/scheduler/task-liveness.js";
import { handoffPolicyRecourse, policyHandoffStatus, type PolicyHandoffDeps } from "../src/codex-policy-handoff.js";
import { policyRecourseChoices } from "../src/codex-policy-recourse-copy.js";
import type { LivenessCard } from "../src/dispatcher-liveness.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const identity = `selection:${"a".repeat(64)}`;
const card = (uuid = "one", dispatcher = "leader"): LivenessCard => ({ uuid, code: "M-100", title: "Review change", assignee: "reviewer", dispatcher: { kind: "instance", name: dispatcher }, claimedAt: 1, updatedAt: 1 });
function rig(cards = [card()]) {
  const db = new Database(":memory:"); databases.push(db);
  const ledger = new LivenessLedger(db), states = new Map<string, string>();
  let live = true, accept = true;
  const deliver = vi.fn((_target: string, _message: string, key: string) => { if (accept) states.set(key, "queued"); return accept; });
  const deps: PolicyHandoffDeps = { cards: () => cards, ledger, current: () => live, isInstance: (n: string) => n !== "missing", boardOff: (n: string) => n === "off",
    noticeState: (key: string) => states.get(key) ?? null, deliver, message: (c: LivenessCard) => `${c.code} reviewer: safety blocked`, now: () => 10 };
  return { db, ledger, states, deliver, deps, set live(v: boolean) { live = v; }, set accept(v: boolean) { accept = v; }, run: () => handoffPolicyRecourse(deps, "reviewer", identity, 1) };
}
describe("M-3804 explicit policy handoff", () => {
  it("admits once, marks only accepted notice, survives ledger reload and delivery-row pruning", () => {
    const r = rig(); expect(r.run()).toEqual({ done: ["M-100"], failed: [] });
    expect(r.deliver).toHaveBeenCalledTimes(1);
    expect(r.ledger.get("one")).toMatchObject({ policyHandoff: identity, assignee: "reviewer", dispatcher: "leader", kind: "prompt" });
    expect(r.run().done).toEqual(["M-100"]); expect(r.deliver).toHaveBeenCalledTimes(1);
    r.states.clear(); const restarted = new LivenessLedger(r.db);
    expect(handoffPolicyRecourse({ ...r.deps, ledger: restarted }, "reviewer", identity, 2).done).toEqual(["M-100"]);
    expect(r.deliver).toHaveBeenCalledTimes(1);
    expect(policyHandoffStatus([card()], restarted, "reviewer", identity)).toEqual({ done: 1, total: 1, at: 10 });
    expect(policyHandoffStatus([card()], restarted, "reviewer", `selection:${"b".repeat(64)}`)).toEqual({ done: 0, total: 1 });
  });
  it.each(["rejected", "exception", "no durable row"])("%s never marks success", mode => {
    const r = rig(); r.accept = false;
    if (mode === "exception") r.deps.deliver = () => { throw Error("closed"); };
    if (mode === "no durable row") r.deps.deliver = () => true;
    expect(r.run()).toEqual({ done: [], failed: ["M-100"] }); expect(r.ledger.get("one")).toBeNull();
  });
  it.each(["failed", "cancelled"])("a %s durable notice is not success and is not resent blindly", state => {
    const r = rig(); r.run(); const key = r.ledger.get("one")!.noticeKey!; r.states.set(key, state);
    expect(r.run()).toEqual({ done: [], failed: ["M-100"] }); expect(r.deliver).toHaveBeenCalledTimes(1);
    expect(policyHandoffStatus([card()], r.ledger, "reviewer", identity, r.deps.noticeState).done).toBe(0);
  });
  it("explicit handoff sends its reassignment intent even after an automatic blocked-work alert", () => {
    const r = rig(); r.states.set("ordinary-liveness", "delivered");
    r.ledger.open({ cardUuid: "one", assignee: "reviewer", dispatcher: "leader", dispatcherKind: "instance", kind: "prompt", since: 1, detail: "codex_policy_recourse", noticeKey: "ordinary-liveness", notifiedAt: 2 });
    expect(r.run().done).toEqual(["M-100"]); expect(r.deliver).toHaveBeenCalledOnce();
    expect(r.ledger.get("one")!.noticeKey).not.toBe("ordinary-liveness");
    expect(r.ledger.get("one")!.policyHandoff).toBe(identity);
  });
  it("preserves partial admission and retries only the unresolved card", () => {
    const cards = [card("one"), { ...card("two", "second"), code: "M-101" }], r = rig(cards);
    r.deps.deliver = (target, message, key) => target !== "second" && r.deliver(target, message, key);
    expect(r.run()).toEqual({ done: ["M-100"], failed: ["M-101"] });
    r.deps.deliver = r.deliver;
    expect(r.run()).toEqual({ done: ["M-100", "M-101"], failed: [] });
    expect(r.deliver).toHaveBeenCalledTimes(2);
  });
  it.each(["missing", "off", "reviewer"])("refuses unavailable/self dispatcher %s", dispatcher => {
    const r = rig([card("one", dispatcher)]); expect(r.run().done).toEqual([]); expect(r.deliver).not.toHaveBeenCalled();
  });
  it("person dispatcher gets a durable local Needs-you notice, never an agent-name delivery", () => {
    const r = rig([{ ...card(), dispatcher: { kind: "person", name: "owner" } }]);
    expect(r.run().done).toEqual(["M-100"]); expect(r.deliver).not.toHaveBeenCalled();
    expect(r.ledger.get("one")).toMatchObject({ dispatcherKind: "person", needsYou: true, policyHandoff: identity, noticeKey: null });
  });
  it("expired owner, missing card and reassigned task do not notify the old dispatcher", () => {
    const r = rig(); r.live = false; expect(r.run()).toEqual({ done: [], failed: [] });
    r.live = true; r.deps.cards = () => [{ ...card(), assignee: "other" }]; expect(r.run().done).toEqual([]);
    r.deps.cards = () => []; expect(r.run().done).toEqual([]); expect(r.deliver).not.toHaveBeenCalled();
  });
  it("state changing during admission is not marked as a current handoff", () => {
    const r = rig(); r.deps.deliver = (target, message, key) => { const ok = r.deliver(target, message, key); r.live = false; return ok; };
    expect(r.run().done).toEqual([]); expect(r.ledger.get("one")).toBeNull();
  });
  it("migrates an old ledger without losing existing episodes", () => {
    const db = new Database(":memory:"); databases.push(db);
    db.exec("CREATE TABLE task_liveness(card_uuid TEXT PRIMARY KEY,assignee TEXT,dispatcher TEXT,dispatcher_kind TEXT,kind TEXT,since INTEGER,detail TEXT,notice TEXT,notified_at INTEGER,needs_you INTEGER)");
    db.exec("INSERT INTO task_liveness VALUES('one','reviewer','leader','instance','prompt',1,'codex_policy_recourse','old',2,0)");
    expect(new LivenessLedger(db).get("one")).toMatchObject({ noticeKey: "old", notifiedAt: 2 });
  });
  it("counts real rewrite labels, excludes feedback and optional Daybreak, and never translates labels", () => {
    expect(policyRecourseChoices(["1. First", "2. Second", "3. Third", "4. Give feedback"])).toEqual({ count: 3, feedback: true });
    expect(policyRecourseChoices(["First", "Second", "Third", "Enable Daybreak", "Give feedback"])).toEqual({ count: 3, feedback: true });
    expect(policyRecourseChoices(["First", "Second", "Third"])).toEqual({ count: 3, feedback: false });
    expect(policyRecourseChoices(["First", "Second", "Give feedback"])).toEqual({ count: 2, feedback: true });
    expect(policyRecourseChoices(["First", "Enable Daybreak", "Give feedback"])).toEqual({ count: 1, feedback: true });
  });
});


it("assignment changing during queue admission cannot mark the old assignee handed off", () => {
  const cards = [card()], r = rig(cards);
  r.deps.deliver = (target, message, key) => { const ok = r.deliver(target, message, key); cards[0] = { ...cards[0]!, assignee: "other" }; return ok; };
  expect(r.run().done).toEqual([]); expect(r.ledger.get("one")).toBeNull();
});


it("an old reader's replacement episode cannot turn leftover handoff metadata into current status", () => {
  const r = rig(); r.run();
  r.db.prepare("UPDATE task_liveness SET kind='quiet',detail='' WHERE card_uuid='one'").run();
  expect(policyHandoffStatus([card()], r.ledger, "reviewer", identity).done).toBe(0);
});


it("superseded queued alert is withdrawn only when no other card shares it", () => {
  const r = rig(); const withdraw = vi.fn(); r.deps.withdraw = withdraw;
  const automatic = { cardUuid: "one", assignee: "reviewer", dispatcher: "leader", dispatcherKind: "instance" as const, kind: "prompt" as const, since: 1, detail: "codex_policy_recourse", noticeKey: "auto", notifiedAt: 1 };
  r.ledger.open(automatic); r.ledger.open({ ...automatic, cardUuid: "other" });
  r.run(); expect(withdraw).not.toHaveBeenCalled();
  const alone = rig(); alone.deps.withdraw = withdraw; alone.ledger.open(automatic);
  alone.run(); expect(withdraw).toHaveBeenCalledWith("auto");
});
