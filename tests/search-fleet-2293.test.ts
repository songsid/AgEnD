/**
 * #2293 PR 1: where FleetManager feeds the search index — every chat message it records (a person's or an agent's;
 * never a status line), every cross-instance message outbound-handlers reports — and web.search.enabled at start.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchIndex } from "../src/search/search-index.js";

// The fleet's logger writes daemon.log into the scratch home from a worker thread (#1599); this file has no use for it.
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});

const homes: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
async function fleet() {
  const h = mkdtempSync(join(tmpdir(), "agend-test-search-")); homes.push(h);
  vi.stubEnv("AGEND_HOME", h);
  const { FleetManager } = await import("../src/fleet-manager.js");
  const fm = new FleetManager(h) as any;
  clearInterval(fm.sessionPruneTimer);
  return { fm, h };
}

describe("FleetManager feeds the search index", () => {
  it("a recorded chat message (a person's, an agent's) is indexed as its history row; a status line is not", async () => {
    const { fm } = await fleet();
    const record = vi.fn();
    fm.searchIndex = { record, removeInstance: vi.fn(), close: vi.fn() };
    const ts = new Date().toISOString();
    fm.emitSseEvent("message", { instance: "dev", sender: "han", role: "user", text: "fix nginx", ts, from: "discord:1" });
    fm.emitSseEvent("message", { instance: "dev", sender: "bot", role: "agent", text: "nginx fixed", ts });
    fm.emitSseEvent("message", { instance: "dev", sender: "lead", role: "status", text: "lead → dev: nginx", ts });
    const docs = record.mock.calls.map(c => c[0]).filter(Boolean);
    const rows = fm.webChatHistory.list("dev");
    expect(docs.map((d: any) => [d.key, d.role, d.text, d.mine])).toEqual([
      [`chat:dev:${rows[0].boot}-${rows[0].id}`, "user", "fix nginx", "discord:1"],
      [`chat:dev:${rows[1].boot}-${rows[1].id}`, "agent", "nginx fixed", undefined],
    ]);
  });
  it("indexCrossInstance: the message as an xmsg doc", async () => {
    const { fm } = await fleet();
    const record = vi.fn();
    fm.searchIndex = { record };
    fm.indexCrossInstance({ messageId: "xmsg-1", from: "lead", to: "dev", kind: "task", content: "nginx", ts: "2026-10-01T00:00:00.000Z" });
    expect(record.mock.calls[0][0]).toMatchObject({ key: "xmsg:xmsg-1:dev", source: "xmsg", instance: "lead", peer: "dev" });
  });
  it("web.search.enabled: false — no index at all; otherwise search.db in the fleet's home, retention_days applied", async () => {
    const { fm, h } = await fleet();
    fm.startSearchIndex({ instances: {}, web: { search: { enabled: false } } });
    expect(fm.searchIndex).toBeNull();
    const start = vi.spyOn(SearchIndex.prototype, "start").mockImplementation(() => {});
    fm.startSearchIndex({ instances: {}, web: { search: { retention_days: 30 } } });
    expect(fm.searchIndex).toBeInstanceOf(SearchIndex);
    expect([fm.searchIndex.opts.path, fm.searchIndex.opts.retentionDays, fm.searchIndex.opts.outboxPath]).toEqual([join(h, "search.db"), 30, join(h, "delivery-outbox.db")]);
    expect(start).toHaveBeenCalledTimes(1);
    fm.startSearchIndex({ instances: {} });
    expect(start).toHaveBeenCalledTimes(1);
    start.mockRestore();
    fm.searchIndex.close();
  });
  it("the backfill's chat: every instance's history, as docs (status lines left out)", async () => {
    const { fm } = await fleet();
    const ts = new Date().toISOString();
    fm.webChatHistory.record({ instance: "a", sender: "x", text: "one", ts, role: "user" });
    fm.webChatHistory.record({ instance: "b", sender: "x", text: "two", ts, role: "agent" });
    fm.webChatHistory.record({ instance: "b", sender: "x", text: "line", ts, role: "status" });
    const start = vi.spyOn(SearchIndex.prototype, "start").mockImplementation(() => {});
    fm.startSearchIndex({ instances: {} });
    expect([...fm.searchIndex.opts.chatDocs()].map((d: any) => d.text)).toEqual(["one", "two"]);
    start.mockRestore();
    fm.searchIndex.close();
  });
});
