/**
 * #2122 §10 step 3: Grok's usage, measured — its `updates.jsonl` `turn_completed` usage (real counts, per turn), by
 * working directory (the session directory is the cwd, percent-encoded), with its reasoning, its model calls and the
 * cost grok reported (the amount where the price table lacks the model, said so). Records in the shape grok 1.0.x
 * wrote on the development host (design §10.1).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { grokLine, reviveLedger, type FileCursor } from "../src/cache-ledger.js";
import { CacheService, type CacheInstance } from "../src/cache-service.js";
import { emptyDays, foldHours, reviveDays } from "../src/usage-rollup.js";
import { buildUsageReport } from "../src/usage-report.js";

const NOW = Date.UTC(2026, 9, 18, 12), T = (h: number) => Date.UTC(2026, 9, 17, h);
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-grok-usage-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const usage = (o: Partial<Record<string, number>> = {}) => ({ inputTokens: 103_838, outputTokens: 897, totalTokens: 104_735, cachedReadTokens: 85_504, cacheCreationTokens: 0,
  reasoningTokens: 421, modelCalls: 4, apiDurationMs: 20_506, costUsdTicks: 244_163_400, ...o });
const completed = (t: number, promptId: string, u = usage(), model = "grok-4.6-build") => JSON.stringify({ jsonrpc: "2.0", method: "_x.ai/session/update", timestamp: Math.floor(t / 1000),
  params: { sessionId: "s", _meta: { eventId: `e-${promptId}`, agentTimestampMs: t }, update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn", usage: { ...u, modelUsage: { [model]: u }, numTurns: 4 } } } });
const chunk = JSON.stringify({ method: "_x.ai/session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "turn_completed in text" } } } });
const line = (s: string) => { const whole = Buffer.from(s); return { whole, length: whole.length }; };

describe("a turn_completed line", () => {
  it("one turn per model: cache reads out of input, reasoning a part of output, model calls as requests, grok's cost", () => {
    const file: FileCursor = { kind: "grok", ino: 1, offset: 0 };
    expect(grokLine(line(completed(T(9), "p1")), file)).toEqual([{ t: T(9), model: "grok-4.6-build", prompt: 103_838, uncached: 18_334, read: 85_504, write5m: 0, write1h: 0, write: 0,
      output: 897, reasoning: 421, requests: 4, cost: 0.02441634 }]);
  });
  it("a prompt counted once (a re-sent update is not counted again); other updates and mentions in text are not usage", () => {
    const file: FileCursor = { kind: "grok", ino: 1, offset: 0 };
    expect(grokLine(line(completed(T(9), "p1")), file)).toHaveLength(1);
    expect(grokLine(line(completed(T(9), "p1")), file)).toEqual([]);
    expect(grokLine(line(chunk), file)).toEqual([]);
    expect(grokLine(line(completed(T(10), "p2", usage({ inputTokens: 0, outputTokens: 0 }))), file)).toEqual([]);
  });
});

describe("in the usage report", () => {
  function setup() {
    const root = tmp(), sessions = join(root, "grok-sessions"), cwd = join(root, "dev-grok"), other = join(root, "other");
    mkdirSync(cwd); mkdirSync(other);
    // As grok writes it: session directories, and a plain prompt_history.jsonl beside them (Fable #2606).
    const write = (at: string, id: string, lines: string[]) => {
      const d = join(sessions, encodeURIComponent(at), id); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "updates.jsonl"), lines.join("\n") + "\n");
      writeFileSync(join(sessions, encodeURIComponent(at), "prompt_history.jsonl"), "{}\n");
    };
    const inst: CacheInstance = { name: "dev-grok", backend: "grok", workingDirectory: cwd, ledgerPath: join(root, "dev-grok", "cache-ledger.json"), profile: "default" };
    const svc = (insts = [inst]) => new CacheService({ instances: () => insts, claudeProjectsDir: () => join(root, "c"), claudeKey: (d) => d, codexSessionsDir: () => join(root, "x"),
      listRollouts: () => [], metaPath: join(root, "m.json"), now: () => NOW, zone: () => "UTC", grokSessionsDir: () => sessions });
    return { root, cwd, other, write, inst, svc };
  }
  const report = (data: Awaited<ReturnType<CacheService["usageData"]>>) => buildUsageReport({ now: NOW, zone: "UTC", range: { kind: "7d" }, group: "instance", messages: [],
    scanning: data.scanning, instances: data.instances.map(d => ({ name: d.inst.name, backend: d.inst.backend, team: null, status: d.status, with: d.with, ledger: d.ledger, days: d.days })) });

  it("measured per instance, with reasoning; the model has no list price, so grok's reported cost is the amount, said so", async () => {
    const s = setup();
    s.write(s.cwd, "sess-1", [chunk, completed(T(9), "p1"), chunk, completed(T(10), "p2")]);
    s.write(s.other, "sess-2", [completed(T(9), "x1")]);
    const svc = s.svc();
    await svc.pass();
    const r = report(await svc.usageData());
    expect(r.rows[0]).toMatchObject({ key: "dev-grok", backends: ["grok"], estimated: false, requests: 8, input: 36_668, cacheRead: 171_008, output: 952, reasoning: 842,
      reasoningReported: true, priced: "all" });
    expect(r.rows[0]!.amount).toBeCloseTo(0.04883268, 10);
    expect(r.rows[0]!.flags).toEqual(["cost_reported"]);
    expect(r.daily[0]!.flags).toContain("cost_reported");
    expect((await svc.report("7d")).instances[0]).toMatchObject({ name: "dev-grok", status: "unsupported" });
    // Read whole, so covered: the plain file beside the sessions is no failure.
    await svc.kick();                                                     // a whole catch-up records coverage
    expect((await svc.usageData()).instances[0]!.days.coverage).not.toEqual([]);
  });
  it("read incrementally: a second pass adds only the new turn", async () => {
    const s = setup();
    s.write(s.cwd, "sess-1", [completed(T(9), "p1")]);
    const svc = s.svc();
    await svc.pass();
    s.write(s.cwd, "sess-1", [completed(T(9), "p1"), completed(T(10), "p2")]);
    await svc.pass(); await svc.pass();
    expect(report(await svc.usageData()).rows[0]!.requests).toBe(8);
  });
  it("a listing that fails keeps the cursors: listed again, nothing is counted twice", async () => {
    const s = setup();
    s.write(s.cwd, "sess-1", [completed(T(9), "p1")]);
    const svc = s.svc();
    await svc.pass();
    const dir = join(s.root, "grok-sessions", encodeURIComponent(s.cwd));
    const { renameSync } = await import("node:fs");
    renameSync(dir, `${dir}.away`); writeFileSync(dir, "not a directory");        // there, and not listable
    await svc.pass();
    rmSync(dir); renameSync(`${dir}.away`, dir);
    await svc.pass(); await svc.pass();
    expect(report(await svc.usageData()).rows[0]!.requests).toBe(4);
  });
  it("the reported cost survives the ledger's round trip and the rollup; an older reader keeps the totals", async () => {
    const s = setup();
    s.write(s.cwd, "sess-1", [completed(T(9), "p1")]);
    const svc = s.svc();
    await svc.pass();
    const raw = JSON.parse(readFileSync(s.inst.ledgerPath, "utf8"));
    const l = reviveLedger(raw);
    expect(l.hours[String(T(9))]!.cs).toEqual({ "grok:default": { "grok-4.6-build|0": 0.02441634 } });
    const days = emptyDays();
    foldHours(days, l, T(11), "UTC");
    const back = reviveDays(JSON.parse(JSON.stringify(days)));
    expect(back.rows[0]).toMatchObject({ be: "grok", c: { "grok-4.6-build|0": 0.02441634 }, r: { "grok-4.6-build|0": 421 } });
    expect(Object.values<number[]>(raw.hours[String(T(9))].m).every(t => t.length === 7)).toBe(true);
  });
});
