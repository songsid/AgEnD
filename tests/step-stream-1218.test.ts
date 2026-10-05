/**
 * #1218 spike — live per-instance step stream: the daemon's transcript events, batched to the fleet, kept in a small
 * per-instance ring, sent to the dashboard over SSE. Expectations written out by hand.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstanceStepLog, STEP_TEXT_MAX, StepBatcher, resultPreview, stepText, type Step } from "../src/step-stream.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("a step's text", () => {
  it("one line, secrets redacted, capped", () => {
    expect(stepText("  git push\n  https://user:hunter2pass@github.com/x  ")).toBe("git push https://user:[REDACTED]@github.com/x");
    expect(stepText("curl -H 'Authorization: Bearer abcdefgh12345678'")).toBe("curl -H 'Authorization: [REDACTED] [REDACTED]'");
    expect(stepText("x".repeat(500))).toBe("x".repeat(STEP_TEXT_MAX - 1) + "…");
    expect(stepText(undefined)).toBe("");
  });

  it("a tool result: a string, Claude Code's content blocks, or nothing (other sources)", () => {
    expect(resultPreview("12 passed")).toBe("12 passed");
    expect(resultPreview([{ type: "text", text: "a" }, { type: "image", source: {} }, { type: "text", text: "b" }])).toBe("a [image] b");
    expect(resultPreview(undefined)).toBe("");
    expect(resultPreview({ weird: true })).toBe("");
  });
});

describe("StepBatcher: never more than one batch per interval, never unbounded", () => {
  function batcher(opts: { maxBatch?: number; maxPending?: number } = {}) {
    vi.useFakeTimers();
    const sent: Step[][] = [];
    const b = new StepBatcher(s => sent.push(s), { intervalMs: 1000, now: () => Date.now(), ...opts });
    return { b, sent };
  }

  it("a burst waits one interval and leaves as one batch, in order, numbered", () => {
    const { b, sent } = batcher();
    b.tool("Bash", "$ npm test");
    b.result("toolu_1", "12 passed");
    b.text("All green.");
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(999);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.map(s => [s.seq, s.kind, s.name, s.text])).toEqual([
      [1, "tool", "Bash", "$ npm test"], [2, "result", "toolu_1", "12 passed"], [3, "text", undefined, "All green."],
    ]);
  });

  it("a long burst: one batch per interval, maxBatch each, until it is drained", () => {
    const { b, sent } = batcher({ maxBatch: 50, maxPending: 1000 });
    for (let i = 0; i < 120; i++) b.tool("Read", `Read f${i}`);
    vi.advanceTimersByTime(1000);
    expect(sent.map(x => x.length)).toEqual([50]);
    vi.advanceTimersByTime(999);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(1000);
    expect(sent.map(x => x.length)).toEqual([50, 50, 20]);
    expect(sent.flat().map(s => s.seq)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(3);
  });

  it("beyond maxPending the oldest fold into one 'skipped' step — a runaway loop cannot grow the daemon", () => {
    const { b, sent } = batcher({ maxBatch: 50, maxPending: 10 });
    for (let i = 0; i < 25; i++) b.tool("Bash", `$ step ${i}`);
    vi.advanceTimersByTime(1000);
    expect(sent[0]![0]).toMatchObject({ kind: "skipped", text: "15 steps skipped (too many at once)" });
    expect(sent[0]!.slice(1).map(s => s.text)).toEqual(Array.from({ length: 10 }, (_, i) => `$ step ${i + 15}`));
  });

  it("empty assistant text is no step; clear() drops what waits and the stream stays usable; dispose() ends it", () => {
    const { b, sent } = batcher();
    b.text("   ");
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual([]);
    b.tool("Bash", "$ a");
    b.clear();
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual([]);
    b.tool("Bash", "$ b");
    vi.advanceTimersByTime(1000);
    expect(sent.flat().map(s => s.text)).toEqual(["$ b"]);
    b.dispose();
    b.tool("Bash", "$ c");
    vi.advanceTimersByTime(5000);
    expect(sent.flat().map(s => s.text)).toEqual(["$ b"]);
  });
});

describe("InstanceStepLog: the fleet's recent steps", () => {
  const st = (seq: number, text = `s${seq}`): Step => ({ seq, ts: seq, kind: "tool", text });

  it("appends in order, drops repeats, starts over on a new boot, keeps the newest N, forgets a deleted instance", () => {
    const log = new InstanceStepLog(5);
    expect(log.append("w", "b1", [st(1), st(2)]).map(s => s.seq)).toEqual([1, 2]);
    expect(log.append("w", "b1", [st(2), st(3)]).map(s => s.seq), "a repeat is dropped").toEqual([3]);
    log.append("w", "b1", [st(4), st(5), st(6), st(7)]);
    expect(log.list("w")).toEqual({ boot: "b1", steps: [st(3), st(4), st(5), st(6), st(7)] });
    log.append("w", "b2", [st(1, "after restart")]);
    expect(log.list("w")).toEqual({ boot: "b2", steps: [st(1, "after restart")] });
    expect(log.list("other")).toEqual({ boot: null, steps: [] });
    log.forget("w");
    expect(log.list("w")).toEqual({ boot: null, steps: [] });
  });
});

describe("the fleet: an instance's steps go to the dashboard", () => {
  async function fleet() {
    const dir = mkdtempSync(join(tmpdir(), "agend-1218-")); dirs.push(dir);
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(dir);
    const events: Array<{ event: string; data: any }> = [];
    vi.spyOn(fm, "emitSseEvent").mockImplementation((event: string, data: unknown) => { events.push({ event, data }); });
    return { fm, any: fm as unknown as Record<string, any>, events };
  }

  it("kept and sent on; a repeat is not sent twice; junk is dropped, never repaired", async () => {
    const { fm, any, events } = await fleet();
    const steps = [{ seq: 1, ts: 1, kind: "tool", name: "Bash", text: "$ npm test" }, { seq: 2, ts: 2, kind: "result", name: "t1", text: "ok" }];
    any.receiveInstanceSteps("w", "boot-1", steps);
    any.receiveInstanceSteps("w", "boot-1", steps);
    any.receiveInstanceSteps("w", "boot-1", [{ seq: 3, kind: "evil", text: "x" }, { seq: "4", kind: "tool", text: "x" }, { seq: 5, kind: "tool", text: 5 }, null]);
    any.receiveInstanceSteps("w", 7, steps);
    any.receiveInstanceSteps("w", "boot-1", "not a list");
    expect(events).toEqual([{ event: "steps", data: { instance: "w", boot: "boot-1", steps } }]);
    expect(fm.instanceSteps.list("w").steps).toEqual(steps);
  });

  it("a batch is capped at 100 steps however many the message claims", async () => {
    const { fm, any } = await fleet();
    any.receiveInstanceSteps("w", "b", Array.from({ length: 250 }, (_, i) => ({ seq: i + 1, ts: 0, kind: "tool", text: "x" })));
    expect(fm.instanceSteps.list("w").steps).toHaveLength(100);
  });
});

describe("GET /ui/steps", () => {
  const TOKEN = "u".repeat(48);
  function call(url: string, ctx: WebApiContext, headers: Record<string, string> = { "x-agend-token": TOKEN }) {
    const req = Object.assign(new EventEmitter(), { method: "GET", url, headers, destroy() {}, resume() {} });
    const res = Object.assign(new EventEmitter(), {
      status: 0, body: "", setHeader() {}, writeHead(s: number) { res.status = s; return res; }, write() { return true; },
      end(chunk?: unknown) { if (chunk) res.body = String(chunk); return res; },
    });
    handleWebRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL(url, "http://localhost"), ctx);
    return { status: res.status, body: res.body ? JSON.parse(res.body) : {} };
  }
  const log = new InstanceStepLog();
  log.append("w", "b1", [{ seq: 1, ts: 1, kind: "tool", text: "$ ls" }]);
  const ctx = { webToken: TOKEN, sseClients: new Set(), instanceSteps: log, logger: { info() {}, debug() {}, error() {} } } as unknown as WebApiContext;

  it("one instance's recent steps; the instance is required; the /ui credential is", () => {
    expect(call("/ui/steps?instance=w", ctx)).toEqual({ status: 200, body: { boot: "b1", steps: [{ seq: 1, ts: 1, kind: "tool", text: "$ ls" }] } });
    expect(call("/ui/steps?instance=nobody", ctx)).toEqual({ status: 200, body: { boot: null, steps: [] } });
    expect(call("/ui/steps", ctx).status).toBe(400);
    expect(call("/ui/steps?instance=w", ctx, {}).status).toBe(401);
  });
});

describe("the dashboard (the real page script)", () => {
  const PAGE = readFileSync(join(process.cwd(), "src", "ui", "dashboard.html"), "utf8").match(/<script>\n([\s\S]*?)<\/script>/)![1]!;
  function el(tag = "div") {
    const node: any = { tag, className: "", dataset: {}, children: [] as any[], attrs: {} as Record<string, string>, style: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
      append(...k: any[]) { node.children.push(...k); }, setAttribute(k: string, v: string) { node.attrs[k] = v; } };
    let text = "";
    Object.defineProperty(node, "textContent", { get: () => text, set: (v: string) => { text = v; if (v === "") node.children = []; } });
    return node;
  }
  function page() {
    const nodes: Record<string, any> = { stepsView: el(), uptime: {} };
    const sse: Record<string, (e: { data: string }) => void> = {};
    const c = vm.createContext({
      localStorage: { getItem: () => null }, navigator: { language: "en" },
      document: { getElementById: (n: string) => nodes[n] ?? null, createElement: (t: string) => el(t), body: { appendChild() {} } },
      setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      EventSource: class { addEventListener(k: string, f: (e: { data: string }) => void) { sse[k] = f; } },
    });
    vm.runInContext(PAGE, c);
    vm.runInContext('renderList=()=>{};mode="instance";cur="w";curTab="steps";', c);
    return { nodes, sse, read: (s: string) => vm.runInContext(s, c) };
  }
  const send = (p: ReturnType<typeof page>, boot: string, steps: unknown[], instance = "w") =>
    p.sse.steps!({ data: JSON.stringify({ instance, boot, steps }) });
  const rows = (p: ReturnType<typeof page>) => p.nodes.stepsView.children.map((r: any) => [r.className, ...r.children.map((k: any) => k.textContent).slice(1)]);

  it("shows each step as text — a loop collapses to one row with its count", () => {
    const p = page();
    send(p, "b", [
      { seq: 1, ts: 0, kind: "tool", name: "Bash", text: "$ git push" },
      { seq: 2, ts: 0, kind: "result", name: "t1", text: "rejected" },
      { seq: 3, ts: 0, kind: "tool", name: "Bash", text: "$ git push" },
      { seq: 4, ts: 0, kind: "tool", name: "Bash", text: "$ git push" },
      { seq: 5, ts: 0, kind: "result", name: "t2", text: "" },
      { seq: 6, ts: 0, kind: "text", text: "<img src=x onerror=alert(1)>" },
    ]);
    expect(rows(p)).toEqual([
      ["step step-tool", "🔧", "$ git push"],
      ["step step-result", "↳", "rejected"],
      ["step step-tool", "🔧", "$ git push", "×2"],
      ["step step-text", "💬", "<img src=x onerror=alert(1)>"],
    ]);
    expect(p.nodes.stepsView.innerHTML).toBeUndefined();
  });

  it("a repeating cycle — push, rejected, push, rejected… — is one block with its count", () => {
    const p = page();
    const cyc: unknown[] = [];
    let seq = 1;
    cyc.push({ seq: seq++, ts: 0, kind: "text", text: "pushing" });
    for (let i = 0; i < 4; i++) {
      cyc.push({ seq: seq++, ts: 0, kind: "tool", text: "$ git push" });
      cyc.push({ seq: seq++, ts: 0, kind: "result", text: "" });              // a source that reports no output
      cyc.push({ seq: seq++, ts: 0, kind: "result", text: "rejected" });
    }
    cyc.push({ seq: seq++, ts: 0, kind: "text", text: "giving up" });
    send(p, "b", cyc);
    expect(rows(p)).toEqual([
      ["step step-text", "💬", "pushing"],
      ["step step-tool", "🔧", "$ git push"],
      ["step step-result", "↳", "rejected", "↻ ×4 (last 2 steps)"],
      ["step step-text", "💬", "giving up"],
    ]);
  });

  it("cycles of up to four steps fold; a counted block is never folded into a different-length cycle", () => {
    const p = page();
    const c = (texts: string[]) => p.read(`collapseSteps(${JSON.stringify(texts.map((text, i) => ({ seq: i + 1, ts: 0, kind: "tool", text })))})`)
      .map((r: { text: string; rep: number; span: number }) => `${r.text}${r.rep > 1 ? `×${r.rep}/${r.span}` : ""}`);
    expect(c(["a", "b", "c", "d", "a", "b", "c", "d"])).toEqual(["a", "b", "c", "d×2/4"]);
    expect(c(["a", "b", "c", "d", "e", "a", "b", "c", "d", "e"]), "five is not a cycle here").toEqual(["a", "b", "c", "d", "e", "a", "b", "c", "d", "e"]);
    expect(c(["a", "a", "a", "b", "a", "a"]), "a run, then something else").toEqual(["a×3/1", "b", "a×2/1"]);
    expect(c(["x", "a", "a", "a", "a"]), "a run is a run, not a cycle of two").toEqual(["x", "a×4/1"]);
    expect(c(["a", "b", "b", "a", "b"]), "a counted run does not become the end of a two-step cycle").toEqual(["a", "b×2/1", "a", "b"]);
  });

  it("another instance's steps are kept, not shown here; a new boot starts the list over", () => {
    const p = page();
    send(p, "b", [{ seq: 1, ts: 0, kind: "tool", text: "$ a" }], "other");
    expect(p.read("steps.other.list.length")).toBe(1);
    expect(p.read("cur")).toBe("w");
    expect(p.nodes.stepsView.children, "nothing of another instance is drawn here").toEqual([]);
    send(p, "b", [{ seq: 1, ts: 0, kind: "tool", text: "$ a" }, { seq: 2, ts: 0, kind: "tool", text: "$ b" }]);
    send(p, "b", [{ seq: 2, ts: 0, kind: "tool", text: "$ b" }]);
    expect(rows(p).map((r: string[]) => r[2])).toEqual(["$ a", "$ b"]);
    send(p, "b2", [{ seq: 1, ts: 0, kind: "text", text: "restarted" }]);
    expect(rows(p).map((r: string[]) => r[2])).toEqual(["restarted"]);
  });
});
