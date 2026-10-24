/**
 * #2122 §10 step 4: Muse's usage, measured — `model_completed` usage in its session.jsonl (real counts, per model call),
 * attributed by the session's `workspace_root` (a subagent's by its parent session), with reasoning; cache writes "not
 * reported" (always 0 so far) and Meta's models not priced. Records in the shape muse 1.4.x wrote on the host.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { museLine, type FileCursor } from "../src/cache-ledger.js";
import { CacheService, type CacheInstance } from "../src/cache-service.js";
import { buildUsageReport } from "../src/usage-report.js";

const NOW = Date.UTC(2026, 9, 18, 12), T = (h: number) => Date.UTC(2026, 9, 17, h);
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-muse-usage-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const meta = (ws: string) => JSON.stringify({ schema_version: 1, stream: { kind: "session", id: "s" }, sequence: 1, recorded_at: T(8) * 1000, payload_type: "runtime.session.metadata",
  payload: { record: { model_id: "muse-spark-1.3", provider_id: "meta", workspace_root: ws } } });
const call = (t: number, u: Record<string, number> = {}, model = "muse-spark-1.3") => JSON.stringify({ schema_version: 1, stream: { kind: "session", id: "s" }, sequence: t, recorded_at: t * 1000,
  record_type: "event", payload_type: "runtime.session", payload: { kind: "run", event: { kind: "model_completed", model, duration_ms: 3838, finish_reason: "tool_calls",
    usage: { input_tokens: 51_170, output_tokens: 223, cached_tokens: 40_000, cache_read_tokens: 40_000, cache_write_tokens: 0, reasoning_tokens: 102, ...u } } } });
const line = (s: string) => { const whole = Buffer.from(s); return { whole, length: whole.length }; };

describe("a model_completed line", () => {
  const cur = (): FileCursor => ({ kind: "muse", ino: 1, offset: 0 });
  it("cache reads out of input, reasoning a part of output; the time is the call's start (recorded_at µs less duration_ms)", () => {
    expect(museLine(line(call(T(9))), cur())).toEqual({ t: T(9) - 3838, model: "muse-spark-1.3", prompt: 51_170, uncached: 11_170, read: 40_000, write5m: 0, write1h: 0, write: 0, output: 223, reasoning: 102 });
  });
  it("a call that ends just after midnight but started before it is the previous day's (Prism #2607)", () => {
    const midnight = Date.UTC(2026, 9, 17);
    expect(new Date(museLine(line(call(midnight + 1000)), cur())!.t).toISOString().slice(0, 10)).toBe("2026-10-16");
  });
  it("the older `cached_tokens` only when `cache_read_tokens` is absent — an explicit 0 is 0 (Prism #2607)", () => {
    const old = JSON.parse(call(T(9), { cached_tokens: 5000 }));
    delete old.payload.event.usage.cache_read_tokens;
    expect(museLine(line(JSON.stringify(old)), cur())).toMatchObject({ read: 5000, uncached: 46_170 });
    expect(museLine(line(call(T(9), { cache_read_tokens: 0, cached_tokens: 5000 })), cur())).toMatchObject({ read: 0, uncached: 51_170 });
  });
  it("a call replayed into the file is counted once; another sequence is another call (Prism #2607)", () => {
    const c = cur();
    expect(museLine(line(call(T(9))), c)).not.toBeNull();
    expect(museLine(line(call(T(9))), c)).toBeNull();
    const next = JSON.parse(call(T(9))); next.sequence += 1;
    expect(museLine(line(JSON.stringify(next)), c)).not.toBeNull();
  });
  it("other events are not usage", () => {
    expect(museLine(line(call(T(9)).replace('"model_completed"', '"workflow_completed"')), cur())).toBeNull();
    expect(museLine(line(meta("/w")), cur())).toBeNull();
    // A workflow's aggregate names its children's model_completed events: counting it would count them twice.
    const aggregate = JSON.parse(call(T(9)));
    aggregate.payload.event.kind = "workflow_completed"; aggregate.payload.event.children = ["model_completed"];
    expect(museLine(line(JSON.stringify(aggregate)), cur())).toBeNull();
  });
});

describe("in the usage report", () => {
  function setup() {
    const root = tmp(), sessions = join(root, "muse", "sessions"), cwd = join(root, "dev-muse"), other = join(root, "other");
    mkdirSync(cwd); mkdirSync(other);
    // As muse writes it: lock and marker files and a dot-directory beside the date tree (Fable #2606).
    mkdirSync(join(sessions, ".msp-view-v1", "01a0"), { recursive: true });
    writeFileSync(join(sessions, ".msp-view-v1", "01a0", "HEAD.json"), "{}");
    writeFileSync(join(sessions, ".msp-maintenance-owner.lock"), "");
    writeFileSync(join(sessions, ".prior-crash-telemetry-markers-v1"), "");
    const session = (day: string, id: string, lines: string[], sub?: { id: string; lines: string[] }) => {
      const dir = join(sessions, ...day.split("-"), id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "session.jsonl"), lines.join("\n") + "\n");
      if (sub) { mkdirSync(join(dir, "subagent", sub.id), { recursive: true }); writeFileSync(join(dir, "subagent", sub.id, "session.jsonl"), sub.lines.join("\n") + "\n"); }
      return dir;
    };
    const inst: CacheInstance = { name: "dev-muse", backend: "muse", workingDirectory: cwd, ledgerPath: join(root, "dev-muse", "cache-ledger.json"), profile: "default" };
    const svc = () => new CacheService({ instances: () => [inst], claudeProjectsDir: () => join(root, "c"), claudeKey: (d) => d, codexSessionsDir: () => join(root, "x"),
      listRollouts: () => [], metaPath: join(root, "m.json"), now: () => NOW, zone: () => "UTC", museSessionsDir: () => sessions });
    return { root, cwd, other, session, svc };
  }
  const report = (data: Awaited<ReturnType<CacheService["usageData"]>>) => buildUsageReport({ now: NOW, zone: "UTC", range: { kind: "7d" }, group: "instance", messages: [],
    scanning: data.scanning, instances: data.instances.map(d => ({ name: d.inst.name, backend: d.inst.backend, team: null, status: d.status, with: d.with, ledger: d.ledger, days: d.days })) });

  it("its sessions and their subagents' are measured; another workspace's are not; not priced, cache writes not reported", async () => {
    const s = setup();
    s.session("2026-10-17", "a", [meta(s.cwd), call(T(9))], { id: "sub", lines: [call(T(10), {}, "muse-spark-1.3-contributor")] });
    s.session("2026-10-17", "b", [meta(s.other), call(T(9))]);
    const svc = s.svc();
    await svc.pass();
    const r = report(await svc.usageData());
    expect(r.rows[0]).toMatchObject({ key: "dev-muse", backends: ["muse"], requests: 2, input: 22_340, cacheRead: 80_000, output: 242, reasoning: 204, reasoningReported: true,
      amount: null, priced: "none", models: ["muse-spark-1.3", "muse-spark-1.3-contributor"] });
    expect(r.rows[0]!.flags).toEqual(expect.arrayContaining(["cache_write_not_reported", "not_priced"]));
    expect((await svc.report("7d")).instances[0]).toMatchObject({ status: "unsupported" });
    await svc.kick();                                                     // read whole: covered, the stray entries no failure
    expect((await svc.usageData()).instances[0]!.days.coverage).not.toEqual([]);
  });
  it("a session that started before the read window but is still written is read; one untouched since is not", async () => {
    const s = setup();
    const old = s.session("2026-08-01", "old", [meta(s.cwd), call(T(9) - 70 * 86_400_000)]);
    utimesSync(join(old, "session.jsonl"), new Date(T(9) - 70 * 86_400_000), new Date(T(9) - 70 * 86_400_000));
    s.session("2026-08-02", "long", [meta(s.cwd), call(T(9))]);
    const svc = s.svc();
    await svc.pass();
    expect(report(await svc.usageData()).rows[0]!.requests).toBe(1);
    const files = Object.keys(JSON.parse(readFileSync(join(s.root, "dev-muse", "cache-ledger.json"), "utf8")).files);
    expect(files.map(f => f.split("/").slice(-2, -1)[0])).toEqual(["long"]);           // the untouched one is not even opened
  });
  it("read incrementally: a second pass adds only new calls", async () => {
    const s = setup();
    const dir = s.session("2026-10-17", "a", [meta(s.cwd), call(T(9))]);
    const svc = s.svc();
    await svc.pass();
    writeFileSync(join(dir, "session.jsonl"), [meta(s.cwd), call(T(9)), call(T(10))].join("\n") + "\n");
    await svc.pass(); await svc.pass();
    expect(report(await svc.usageData()).rows[0]!.requests).toBe(2);
  });
});
