/**
 * #2293 PR 1: the real search worker behind SearchIndex — it alone opens search.db. A new index is backfilled from the
 * chat the fleet holds and, read-only, from the outbox's cross-instance messages and the Task Board; a corrupt file is
 * moved aside and rebuilt; a built one is not backfilled again.
 */
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SearchIndex } from "../src/search/search-index.js";
import { chatDoc } from "../src/search/search-docs.js";
import type { SearchDoc } from "../src/search/search-store.js";

const dirs: string[] = [];
const open: SearchIndex[] = [];
afterEach(async () => {
  open.splice(0).forEach(i => i.close());
  await new Promise(r => setTimeout(r, 100));
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }));
});
const now = new Date().toISOString();

function sources(dir: string): void {
  const outbox = new Database(join(dir, "delivery-outbox.db"));
  outbox.exec("CREATE TABLE deliveries (created_seq INTEGER, target_instance TEXT, target_session TEXT, kind TEXT, created_at TEXT, payload_json TEXT)");
  const put = outbox.prepare("INSERT INTO deliveries VALUES (?,?,?,?,?,?)");
  put.run(1, "dev", "dev", "fleet_inbound", now, JSON.stringify({ content: "please fix the nginx proxy", meta: { from_instance: "lead", message_id: "xmsg-1", request_kind: "task", forwards: "SECRETFWD", working_directory: "/secret/dir" } }));
  put.run(2, "dev", null, "fleet_inbound", now, JSON.stringify({ content: "nginx from a person", meta: { message_id: "m-2" } }));
  put.run(3, "dev", null, "system", now, JSON.stringify({ content: "nginx notice", meta: { from_instance: "lead", message_id: "s-3" } }));
  outbox.close();
  const scheduler = new Database(join(dir, "scheduler.db"));
  scheduler.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT, priority TEXT, assignee TEXT, created_by TEXT, depends_on TEXT, result TEXT, created_at TEXT, updated_at TEXT)");
  scheduler.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("t1", "Upgrade nginx", `token ghp_${"a".repeat(36)}`, "open", "normal", "dev", "lead", null, null, now, now);
  scheduler.close();
}
function start(dir: string, chats: SearchDoc[] = []): { index: SearchIndex; logs: string[] } {
  const logs: string[] = [];
  const index = new SearchIndex({ path: join(dir, "search.db"), retentionDays: 90, outboxPath: join(dir, "delivery-outbox.db"), schedulerPath: join(dir, "scheduler.db"),
    chatDocs: () => chats, log: (l, m) => logs.push(`${l} ${m}`) });
  open.push(index);
  index.start();
  return { index, logs };
}
async function ready(index: SearchIndex): Promise<void> {
  for (let i = 0; i < 200 && index.status() !== "ready"; i++) await new Promise(r => setTimeout(r, 50));
  expect(index.status()).toBe("ready");
}
const keysOf = async (index: SearchIndex, q: string) => { const r = await index.query({ q }); if (!r.ok) throw new Error(r.reason); return r.value.hits.map(h => h.key).sort(); };

describe("the search worker", () => {
  it("backfills chat, the outbox's agent messages (not a person's or a notice) and tasks; masks; never forwards or paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-worker-")); dirs.push(dir);
    sources(dir);
    const chat = chatDoc({ instance: "dev", boot: "b1", id: 1, role: "user", sender: "han", text: "請改 nginx 設定", ts: now } as never)!;
    const { index, logs } = start(dir, [chat]);
    await ready(index);
    expect(await keysOf(index, "nginx")).toEqual(["chat:dev:b1-1", "task:t1", "xmsg:xmsg-1:dev"]);
    expect(await keysOf(index, "ghp_aaaa")).toEqual([]);
    expect(await keysOf(index, "SECRETFWD")).toEqual([]);
    expect(await keysOf(index, "secret/dir")).toEqual([]);
    expect(logs.join("\n")).toMatch(/index built \(1 chat, 1 cross-instance, 1 task docs/);
    // Live docs, after it is built.
    index.record(chatDoc({ instance: "ops", boot: "b1", id: 2, role: "agent", sender: "bot", text: "nginx restarted", ts: now } as never));
    await new Promise(r => setTimeout(r, 400));
    expect(await keysOf(index, "restarted")).toEqual(["chat:ops:b1-2"]);
    // Every batch was committed and acked: nothing is held for a replay.
    expect((index as any).inflight.size).toBe(0);
    index.removeInstance("ops");
    await new Promise(r => setTimeout(r, 200));
    expect([await keysOf(index, "restarted"), (index as any).removals.size]).toEqual([[], 0]);
    const ctx = await index.context("chat:dev:b1-1");
    expect(ctx.ok && ctx.value?.doc.text).toBe("請改 nginx 設定");
  });
  it("a built index is not backfilled again; missing sources are skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-worker-")); dirs.push(dir);
    const first = start(dir);
    await ready(first.index);
    first.index.close(); open.length = 0;
    await new Promise(r => setTimeout(r, 200));
    sources(dir);
    const again = start(dir);
    await ready(again.index);
    expect(await keysOf(again.index, "nginx")).toEqual([]);
    expect(again.logs.join("\n")).not.toMatch(/index built/);
  });
  it("a corrupt file is moved aside (with its -wal/-shm) and the index rebuilt from the sources", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-worker-")); dirs.push(dir);
    sources(dir);
    writeFileSync(join(dir, "search.db"), "not a database ".repeat(500));
    const { index } = start(dir);
    await ready(index);
    expect(await keysOf(index, "nginx")).toEqual(["task:t1", "xmsg:xmsg-1:dev"]);
    const aside = readdirSync(dir).filter(f => f.startsWith("search.db.corrupt-"));
    expect(aside.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, "search.db"))).toBe(true);
  });
});
