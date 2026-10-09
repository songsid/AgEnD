/**
 * #1386 §3/§4: the derivation (pure), and the delivery outbox's acknowledgement and attention query.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { DeliveryOutbox, NEEDS_ATTENTION_SQL } from "../src/delivery-outbox.js";
import {
  deriveNeedsYou, instanceLink, itemsForWorld, messageLink, renderLiveMessage, renderSignature,
  type InstanceInput, type NeedsYouInputs, type PromptInput,
} from "../src/needs-you.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "needs-1386-")); dirs.push(d); return d; };

const prompt = (over: Partial<PromptInput> = {}): PromptInput => ({
  nonce: "a".repeat(32), prefix: "hang:", instance: "alpha", text: "alpha is not responding", actions: [{ id: "restart", label: "Force restart" }],
  createdAt: 1_000, adapterId: "dc", chatId: "guild", threadId: "general", messageId: "m1", ...over,
});
const waiting = (over: Partial<InstanceInput> = {}): InstanceInput => ({
  name: "beta", state: "awaiting_input", interaction: { kind: "permission", owner: "boot:1:1:0", episode: 7, since: 2_000 },
  interactionSummary: "Permission prompt · 3s", ...over,
});
const inputs = (over: Partial<NeedsYouInputs> = {}): NeedsYouInputs => ({ prompts: [], instances: [], deliveries: [], ownerOf: () => "dc", ...over });

describe("§3 every item type, from the inputs only", () => {
  it("a prompt, an instance at its terminal, an auth pause, a crash and a delivery", () => {
    const items = deriveNeedsYou(inputs({
      prompts: [prompt()],
      instances: [waiting(), { name: "gamma", pauseReason: "auth", pausedAt: 3_000 }, { name: "delta", crashedAt: 4_000 }, { name: "eps", pauseReason: "idle", pausedAt: 1 }],
      deliveries: [{ deliveryId: "d1", state: "uncertain", source: "alpha", target: "zeta", kind: "fleet_inbound", finishedAt: 5_000 }],
    }));
    expect(items.map(i => [i.type, i.instance, i.reason])).toEqual([
      ["prompt", "alpha", "hang"],
      ["awaiting_input", "beta", "permission"],
      ["instance", "gamma", "auth_paused"],
      ["instance", "delta", "crashed"],
      ["delivery", "zeta", "delivery_uncertain"],
    ]);
    expect(items[4]!.detail).toBe("alpha → zeta · fleet_inbound");
    // An idle pause is chosen, not waiting: no item.
    expect(items.some(i => i.instance === "eps")).toBe(false);
  });

  it("not waiting (any other state) is no item", () => {
    expect(deriveNeedsYou(inputs({ instances: [waiting({ state: "working" }), waiting({ state: "idle" })] }))).toEqual([]);
  });

  it("an awaiting_input folds into an interactive-assist prompt only for the same wait (owner + episode)", () => {
    const assist = prompt({ prefix: "interactive-assist:", instance: "beta", assistFor: { owner: "boot:1:1:0", episode: 7 } });
    const same = deriveNeedsYou(inputs({ prompts: [assist], instances: [waiting()] }));
    expect(same.map(i => i.type)).toEqual(["prompt"]);
    // The old assist prompt persists; a NEW episode (e.g. a dangerous command) must not be hidden by it.
    const next = deriveNeedsYou(inputs({ prompts: [assist], instances: [waiting({ interaction: { kind: "dangerous_command", owner: "boot:1:1:0", episode: 8, since: 9_000 } })] }));
    expect(next.map(i => [i.type, i.reason])).toEqual([["prompt", "assist"], ["awaiting_input", "dangerous_command"]]);
    // A respawn (another owner) with the same episode number is another wait too.
    const respawned = deriveNeedsYou(inputs({ prompts: [assist], instances: [waiting({ interaction: { kind: "permission", owner: "boot:2:1:0", episode: 7, since: 9_000 } })] }));
    expect(respawned.map(i => i.type)).toEqual(["prompt", "awaiting_input"]);
    // A hang prompt never folds an awaiting_input.
    expect(deriveNeedsYou(inputs({ prompts: [prompt({ instance: "beta" })], instances: [waiting()] })).map(i => i.type)).toEqual(["prompt", "awaiting_input"]);
  });

  it("ids are per occurrence: a new episode, crash time or pause is a new id", () => {
    const a = deriveNeedsYou(inputs({ instances: [waiting()] }))[0]!.id;
    const b = deriveNeedsYou(inputs({ instances: [waiting({ interaction: { kind: "permission", owner: "boot:1:1:0", episode: 8, since: 2_000 } })] }))[0]!.id;
    expect(a).not.toBe(b);
    expect(deriveNeedsYou(inputs({ instances: [{ name: "d", crashedAt: 1 }] }))[0]!.id).not.toBe(deriveNeedsYou(inputs({ instances: [{ name: "d", crashedAt: 2 }] }))[0]!.id);
  });

  it("grouped by instance (oldest first), and each item carries its owning world, or none", () => {
    const items = deriveNeedsYou(inputs({
      prompts: [prompt({ instance: "late", createdAt: 9_000 }), prompt({ nonce: "b".repeat(32), instance: "early", createdAt: 1_000 }), prompt({ nonce: "c".repeat(32), instance: "late", createdAt: 500 })],
      ownerOf: i => (i === "early" ? "tg" : i === "late" ? "dc" : undefined),
    }));
    expect(items.map(i => [i.instance, i.since, i.owner])).toEqual([["late", 500, "dc"], ["late", 9_000, "dc"], ["early", 1_000, "tg"]]);
    expect(itemsForWorld(items, "dc").map(i => i.instance)).toEqual(["late", "late"]);
    const orphan = deriveNeedsYou(inputs({ prompts: [prompt()], ownerOf: () => undefined }));
    expect(orphan[0]!.owner).toBeUndefined();
    expect(itemsForWorld(orphan, "dc")).toEqual([]);
  });
});

describe("§4.2 the rendered signature", () => {
  it("changes with what is shown — text, age bucket, link coordinates, owner — not with anything finer", () => {
    const base = deriveNeedsYou(inputs({ prompts: [prompt()] }));
    const sig = renderSignature(base, 1_000 + 30_000);
    expect(renderSignature(base, 1_000 + 50_000)).toBe(sig);                      // still "<1m"
    expect(renderSignature(base, 1_000 + 61_000)).not.toBe(sig);                  // "1m"
    expect(renderSignature(deriveNeedsYou(inputs({ prompts: [prompt({ messageId: "m2" })] })), 31_000)).not.toBe(sig);   // re-posted elsewhere
    expect(renderSignature(deriveNeedsYou(inputs({ prompts: [prompt()], ownerOf: () => "tg" })), 31_000)).not.toBe(sig); // moved worlds
  });
});

describe("§5.1 links", () => {
  it("Discord: the prompt's own message, and the instance channel as a mention", () => {
    expect(messageLink({ type: "discord", groupId: "111111" }, { chatId: "111111", threadId: "222222", messageId: "333333" })).toBe("https://discord.com/channels/111111/222222/333333");
    expect(instanceLink({ type: "discord", groupId: "111111" }, "444444")).toBe("<#444444>");
    expect(messageLink({ type: "discord" }, { chatId: "x", messageId: "333333" })).toBeUndefined();
  });
  it("Telegram: t.me/c/ for a supergroup; General (topic 1) has no topic segment; others have none", () => {
    expect(messageLink({ type: "telegram", groupId: "-1001234" }, { chatId: "-1001234", threadId: "55", messageId: "9" })).toBe("https://t.me/c/1234/55/9");
    expect(messageLink({ type: "telegram", groupId: "-1001234" }, { chatId: "-1001234", threadId: "1", messageId: "9" })).toBe("https://t.me/c/1234/9");
    expect(instanceLink({ type: "telegram", groupId: "-1001234" }, "55")).toBe("https://t.me/c/1234/55");
    expect(messageLink({ type: "telegram" }, { chatId: "-555", messageId: "9" })).toBeUndefined();
  });
});

describe("§5.1 the live message text", () => {
  const t = (k: string, ...a: Array<string | number>) => `${k}${a.length ? `(${a.join(",")})` : ""}`;
  it("at most 10 lines, then '… and N more'; Acknowledge for the newest 5 shown deliveries", () => {
    const deliveries = Array.from({ length: 12 }, (_, i) => ({ deliveryId: `d${i}`, state: "failed" as const, source: "s", target: `t${i}`, kind: "k", finishedAt: i * 1000 }));
    const items = deriveNeedsYou(inputs({ deliveries }));
    const { text, ackable } = renderLiveMessage(items.map(item => ({ item, title: "T" })), 100_000, t);
    expect(text.split("\n")).toHaveLength(1 + 10 + 1);
    expect(text).toContain("needs.live_more(2)");
    expect(ackable).toHaveLength(5);
    expect(ackable.map(a => a.deliveryId)).toEqual(["d9", "d8", "d7", "d6", "d5"]);   // newest of the 10 shown
  });
  it("nothing waiting: the empty text", () => {
    expect(renderLiveMessage([], 0, t)).toEqual({ text: "needs.live_empty", ackable: [] });
  });
});

describe("§3.4 the outbox: acknowledgement and the bounded attention query", () => {
  function outbox() {
    const dir = tmp(), path = join(dir, "outbox.db");
    const ob = new DeliveryOutbox(path);
    return { ob, path };
  }
  function insert(db: Database.Database, id: string, state: string, finishedAt: string, seq: number) {
    db.prepare(`INSERT INTO deliveries (delivery_id, operation_id, source_key, source_instance, source_daemon_boot_id, target_instance,
      kind, payload_json, state, attempt_no, created_seq, created_at, updated_at, accepted_at, finished_at)
      VALUES (?, ?, ?, 's', 'b', 't', 'fleet_inbound', '{}', ?, 1, ?, ?, ?, ?, ?)`)
      .run(id, `op-${id}`, `src-${id}`, state, seq, finishedAt, finishedAt, finishedAt, finishedAt);
  }

  it("the plan is a range on idx_delivery_attention — with every competing index present and no ANALYZE", () => {
    const { ob, path } = outbox();
    ob.close?.();
    const db = new Database(path);
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${NEEDS_ATTENTION_SQL}`).all("2026-01-01T00:00:00.000Z", 50).map((r: any) => r.detail);
    expect(plan).toEqual(["SEARCH deliveries USING INDEX idx_delivery_attention (finished_at>?)"]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='idx_delivery_state_seq'").get()).toBeTruthy();
    db.close();
  });

  it("1,000 expired uncertain rows and 3 recent: exactly the 3", () => {
    const { ob, path } = outbox();
    ob.close?.();
    const db = new Database(path);
    db.transaction(() => {
      for (let i = 0; i < 1000; i++) insert(db, `old${i}`, "uncertain", "2025-01-01T00:00:00.000Z", i);
      for (let i = 0; i < 3; i++) insert(db, `new${i}`, i === 1 ? "failed" : "uncertain", `2026-06-01T00:00:0${i}.000Z`, 2000 + i);
    })();
    db.close();
    const again = new DeliveryOutbox(path);
    expect(again.needsAttention("2026-05-31T00:00:00.000Z").map(d => d.deliveryId)).toEqual(["new2", "new1", "new0"]);
    again.close?.();
  });

  it("acknowledged rows are excluded BEFORE the cap: 51 recent, the newest 50 acknowledged → #51 is listed", () => {
    const { ob, path } = outbox();
    ob.close?.();
    const db = new Database(path);
    db.transaction(() => { for (let i = 0; i < 51; i++) insert(db, `r${i}`, "uncertain", `2026-06-01T00:${String(i).padStart(2, "0")}:00.000Z`, i); })();
    db.close();
    const box = new DeliveryOutbox(path);
    for (let i = 1; i < 51; i++) expect(box.acknowledge(`r${i}`, "web:0123456789abcdef")).toBe(true);
    expect(box.needsAttention("2026-05-01T00:00:00.000Z").map(d => d.deliveryId)).toEqual(["r0"]);
    box.close?.();
  });

  it("acknowledge is one atomic statement: once, never on delivered or unknown rows", () => {
    const { ob, path } = outbox();
    ob.close?.();
    const db = new Database(path);
    insert(db, "u", "uncertain", "2026-06-01T00:00:00.000Z", 1);
    insert(db, "ok", "delivered", "2026-06-01T00:00:00.000Z", 2);
    db.close();
    const box = new DeliveryOutbox(path);
    expect(box.acknowledge("u", "discord:42")).toBe(true);
    expect(box.acknowledge("u", "discord:43")).toBe(false);
    expect(box.acknowledge("ok", "discord:42")).toBe(false);
    expect(box.acknowledge("nope", "discord:42")).toBe(false);
    box.close?.();
    const check = new Database(path);
    expect(check.prepare("SELECT acknowledged_by FROM deliveries WHERE delivery_id='u'").get()).toEqual({ acknowledged_by: "discord:42" });
    check.close();
  });

  it("a database the migration never reached refuses the query loudly instead of scanning", () => {
    const { ob, path } = outbox();
    ob.close?.();
    const db = new Database(path);
    db.exec("DROP INDEX idx_delivery_attention");
    expect(() => db.prepare(NEEDS_ATTENTION_SQL)).toThrow(/no such index/);
    db.close();
    // Opening it again migrates it back.
    const box = new DeliveryOutbox(path);
    expect(box.needsAttention("2026-01-01T00:00:00.000Z")).toEqual([]);
    box.close?.();
  });
});
