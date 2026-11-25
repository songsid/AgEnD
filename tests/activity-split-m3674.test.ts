/**
 * M-3674: an agent's activity, split. The time it showed counted only turns a person started (its last reply to a
 * person, web chat history), so an agent kept busy by other agents — send_to_instance, delegate_task, report_result, a
 * broadcast — read "33 天前". Beside it now: the last turn another agent started (the delivery outbox).
 * - DeliveryOutbox.lastAgentTurn: the newest delivered message from another instance, at the turn that took it up,
 *   else when it was delivered; never a queued or failed one, never one to itself, never a person's;
 * - the sidebar's row (M-3707, the user: one time again): the newer of the two, unlabelled ("2 min ago"), the title
 *   saying which kind it was; in the one-line (compact) sidebar the name keeps room and the time ellipsizes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DeliveryOutbox, type NewOutboxDelivery } from "../src/delivery-outbox.js";
import { page, type AppPage } from "./helpers/app-harness.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const tempDb = () => { const r = mkdtempSync(join(tmpdir(), "m3674-")); roots.push(r); return join(r, "outbox.db"); };
const input = (n: number, o: Partial<NewOutboxDelivery> = {}): NewOutboxDelivery => {
  const target = o.targetInstance ?? "forge", source = o.sourceInstance ?? "leader", kind = o.kind ?? "fleet_inbound";
  return { operationId: `op-${n}`, sourceKey: `mcp:${source}:op-${n}:${target}:${kind}`, sourceInstance: source, sourceDaemonBootId: "boot-s",
    targetInstance: target, kind, correlationId: `c-${n}`, payload: { type: kind, content: "hi", meta: {} }, ...o };
};
/** Admit a row, then put it where a run would leave it (the state machine is tested elsewhere). */
function row(path: string, outbox: DeliveryOutbox, n: number, set: { state: string; consumed?: string | null; finished?: string | null }, o: Partial<NewOutboxDelivery> = {}) {
  const id = outbox.admit(input(n, o)).delivery.deliveryId, db = new Database(path);
  db.prepare("UPDATE deliveries SET state=?, consumed_at=?, finished_at=? WHERE delivery_id=?").run(set.state, set.consumed ?? null, set.finished ?? null, id);
  db.close();
}

describe("DeliveryOutbox.lastAgentTurn", () => {
  it("none: null; the newest delivered message from another instance, at its turn (else its delivery)", () => {
    const path = tempDb(), outbox = new DeliveryOutbox(path, "m-1");
    expect(outbox.lastAgentTurn("forge")).toBeNull();
    row(path, outbox, 1, { state: "delivered", consumed: "2026-11-24T10:00:05.000Z", finished: "2026-11-24T10:00:00.000Z" });
    expect(outbox.lastAgentTurn("forge")).toBe("2026-11-24T10:00:05.000Z");                  // the turn that took it up
    row(path, outbox, 2, { state: "delivered", consumed: null, finished: "2026-11-24T11:00:00.000Z" }, { kind: "steer" });
    expect(outbox.lastAgentTurn("forge")).toBe("2026-11-24T11:00:00.000Z");                  // newer, not yet consumed: its delivery
    row(path, outbox, 3, { state: "delivered", finished: "2026-11-24T12:00:00.000Z" }, { kind: "broadcast" });
    expect(outbox.lastAgentTurn("forge")).toBe("2026-11-24T12:00:00.000Z");
    outbox.close();
  });
  it("the latest activity, not the newest row (Prism #4430): an older message taken up after a newer one was delivered", () => {
    const path = tempDb(), outbox = new DeliveryOutbox(path, "m-1");
    row(path, outbox, 1, { state: "delivered", consumed: "2026-11-24T16:00:00.000Z", finished: "2026-11-24T09:00:00.000Z" });   // older row, its turn later
    row(path, outbox, 2, { state: "delivered", consumed: null, finished: "2026-11-24T10:00:00.000Z" });                           // newer row, delivered earlier
    expect(outbox.lastAgentTurn("forge")).toBe("2026-11-24T16:00:00.000Z");
    outbox.close();
  });
  it("whatever the admission order: one old row taken up after 64 newer ones were delivered (Prism #4430 r2)", () => {
    const path = tempDb(), outbox = new DeliveryOutbox(path, "m-1");
    row(path, outbox, 1, { state: "delivered", consumed: "2026-11-24T16:00:00.000Z", finished: "2026-11-24T08:00:00.000Z" });
    for (let n = 2; n <= 66; n++) row(path, outbox, n, { state: "delivered", finished: "2026-11-24T10:00:00.000Z" });
    expect(outbox.lastAgentTurn("forge")).toBe("2026-11-24T16:00:00.000Z");
    outbox.close();
  });
  it("one indexed step: the plan walks idx_delivery_agent_turn in order (no table scan, no sort)", () => {
    const path = tempDb(), outbox = new DeliveryOutbox(path, "m-1");
    outbox.close();
    const db = new Database(path);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT COALESCE(consumed_at, finished_at) AS at FROM deliveries
      WHERE target_instance=? AND state='delivered' AND kind IN ('fleet_inbound','steer','broadcast') AND source_instance<>target_instance
      ORDER BY COALESCE(consumed_at, finished_at) DESC LIMIT 1`).all("forge") as Array<{ detail: string }>;
    db.close();
    const detail = plan.map((p) => p.detail).join(" | ");
    expect(detail).toContain("USING INDEX idx_delivery_agent_turn (target_instance=?)");
    expect(detail).not.toMatch(/TEMP B-TREE|SCAN deliveries/);
  });
  it("never a queued, failed or cancelled one, one it sent itself, one to someone else", () => {
    const path = tempDb(), outbox = new DeliveryOutbox(path, "m-1");
    row(path, outbox, 1, { state: "delivered", finished: "2026-11-24T09:00:00.000Z" });
    row(path, outbox, 2, { state: "queued" });
    row(path, outbox, 3, { state: "failed", finished: "2026-11-24T13:00:00.000Z" });
    row(path, outbox, 4, { state: "cancelled", finished: "2026-11-24T13:00:00.000Z" });
    row(path, outbox, 5, { state: "delivered", finished: "2026-11-24T14:00:00.000Z" }, { sourceInstance: "forge" });   // to itself
    row(path, outbox, 6, { state: "delivered", finished: "2026-11-24T15:00:00.000Z" }, { targetInstance: "other" });
    expect(outbox.lastAgentTurn("forge")).toBe("2026-11-24T09:00:00.000Z");
    expect(outbox.lastAgentTurn("other")).toBe("2026-11-24T15:00:00.000Z");
    outbox.close();
  });
});

describe("the compact sidebar keeps the name (app.css)", () => {
  it("the name's line keeps at least 40 %; the times shrink and ellipsize", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8");
    expect(css).toContain(".inst-nav.compact .inst-line2 { flex: 0 1 auto; min-width: 0; }");
    expect(css).toContain(".inst-nav.compact .inst-line { min-width: 40%; }");
    expect(css).toContain(".inst-nav.compact .inst-line2 > .inst-when { overflow: hidden; text-overflow: ellipsis; max-width: 100%; }");
  });
});

describe("the sidebar row's time (instance-nav activityText; M-3707: one time again)", () => {
  let p: AppPage, N: any, i18n: any;
  beforeAll(async () => {
    p = page({ url: "http://127.0.0.1:19280/ui" });
    N = await import("/assets/instance-nav.js"); i18n = await import("/assets/app-i18n.js");
  });
  afterAll(async () => { i18n.setLang("en", { store: false }); await p.unmount(); p.restore(); });
  const now = Date.parse("2026-11-24T12:00:00.000Z");
  const it33 = { last_reply: "2026-10-22T12:00:00.000Z", last_agent_turn: "2026-11-24T11:58:00.000Z" };
  it("both: the newer one, unlabelled, as a reply's time reads; the title names each kind, the newer first", () => {
    i18n.setLang("zh-TW", { store: false });
    const a = N.activityText(it33, N.replyAge(it33, now), N.agentTurnAge(it33, now));
    expect([a.text, a.person]).toEqual(["2 分鐘前", false]);
    expect(a.title.split("\n").map((l: string) => l.split("：")[0])).toEqual(["最後一次由其他 Agent 發起的回合（send_to_instance、任務、回報、廣播）", "最後回覆人的時間"]);
    i18n.setLang("en", { store: false });
    expect(N.activityText(it33, N.replyAge(it33, now), N.agentTurnAge(it33, now)).text).toBe("2 min ago");
    const fresh = { last_reply: "2026-11-24T11:59:00.000Z", last_agent_turn: "2026-11-23T12:00:00.000Z" };
    const b = N.activityText(fresh, N.replyAge(fresh, now), N.agentTurnAge(fresh, now));
    expect([b.text, b.person, b.title.split("\n")[0].startsWith("Last reply to a person")]).toEqual(["1 min ago", true, true]);
    expect(b.text).not.toMatch(/Person|Agent|人/);
  });
  it("one alone: a reply as before; an agent turn the same way (no label); neither: nothing", () => {
    i18n.setLang("en", { store: false });
    const reply = { last_reply: "2026-11-24T11:30:00.000Z" }, agent = { last_agent_turn: "2026-11-24T09:00:00.000Z" };
    expect(N.activityText(reply, N.replyAge(reply, now), N.agentTurnAge(reply, now))).toMatchObject({ text: "30 min ago", person: true });
    expect(N.activityText(agent, N.replyAge(agent, now), N.agentTurnAge(agent, now))).toMatchObject({ text: "3 h ago", person: false });
    expect(N.activityText({}, null, null)).toBeNull();
  });
});
