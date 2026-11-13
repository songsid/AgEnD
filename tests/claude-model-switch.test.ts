import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { TranscriptMonitor } from "../src/transcript-monitor.js";
import { ClaudeModelObserver, normalizeClaudeModel, parseClaudeModelRecord } from "../src/claude-model-observation.js";
import { deriveNeedsYou } from "../src/needs-you.js";
import { ClaudeStepParser } from "../src/log-steps.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const notice = () => ({ type: "system", subtype: "model_refusal_fallback", sessionId: "session-A", uuid: "notice-A",
  timestamp: new Date().toISOString(), isSidechain: false, originalModel: "claude-opus-5-5", fallbackModel: "claude-opus-4-8",
  trigger: "refusal", scope: "session", apiRefusalCategory: "cyber", content: "NEVER EXPOSE THIS CONTENT" });

it("observes a typed main-thread fallback only through this launch's hook, without copying content", () => {
  const dir = mkdtempSync(join(tmpdir(), "agend-switch-")); dirs.push(dir);
  writeFileSync(join(dir, "statusline.json"), JSON.stringify({ _agendLaunchId: "launch-A", session_id: "session-A",
    transcript_path: join(dir, "session-A.jsonl"), model: { id: "claude-opus-5-5" } }));
  const monitor = new (TranscriptMonitor as any)(dir, pino({ level: "silent" }), null, () => ({ id: "launch-A", startedAt: Date.now() - 1000 }));
  const observations: any[] = []; monitor.on("model_observation", (value: unknown) => observations.push(value));
  monitor.processEntry(notice());
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({ kind: "switch", original: "claude-opus-5-5", served: "claude-opus-4-8", cause: "safeguards", scope: "session" });
  expect(JSON.stringify(observations)).not.toContain("NEVER EXPOSE");
});

const served = (model = "claude-opus-4-8", id = "response-A") => ({ type: "assistant", sessionId: "session-A", uuid: `record-${id}`,
  timestamp: new Date().toISOString(), isSidechain: false, requestedModel: "claude-opus-4-8",
  message: { id, role: "assistant", model, content: [], stop_reason: "end_turn" } });
const parse = (record: any) => parseClaudeModelRecord(record)!;

describe("redacted Claude Code 2.1.323 record shapes", () => {
  it("retains typed originalModel even though requestedModel already names the fallback", () => {
    const observer = new ClaudeModelObserver("claude-opus-5-5", "claude-opus-5-5");
    observer.observe(parse(notice()), "claude-opus-4-8"); observer.observe(parse(served()), "claude-opus-4-8");
    expect(observer.snapshot()).toMatchObject({ configured: "claude-opus-5-5", session: "claude-opus-4-8", lastServed: "claude-opus-4-8",
      active: { original: "claude-opus-5-5", served: "claude-opus-4-8", cause: "safeguards", scope: "session" } });
  });
  it.each([
    ["local", "turn"], ["turn", "turn"], ["session", "session"], [undefined, "session"], ["unsupported", "unknown"],
  ])("refusal scope %s is %s", (scope, expected) => expect(parse({ ...notice(), scope }).scope).toBe(expected));
  it("availability is distinct, with an unknown scope when the producer omits it", () => {
    const e = parse({ ...notice(), subtype: "model_fallback", trigger: "availability", scope: undefined });
    expect(e).toMatchObject({ cause: "availability", scope: "unknown" });
  });
  it.each([
    ["no fallback", { ...notice(), subtype: "model_refusal_no_fallback" }],
    ["same model", { ...notice(), fallbackModel: "CLAUDE-OPUS-5-5[1m]" }],
    ["synthetic", served("<synthetic>")],
    ["API error", { ...served(), isApiErrorMessage: true }],
    ["refused response", { ...served(), message: { ...served().message, stop_reason: "refusal" } }],
    ["sidechain notice", { ...notice(), isSidechain: true }],
    ["sidechain response", { ...served(), isSidechain: true }],
    ["agent id", { ...served(), agentId: "child-A" }],
    ["SDK agent", { ...served(), agent_id: "child-A" }],
    ["subagent type", { ...notice(), subagent_type: "Explore" }],
    ["meta", { ...served(), isMeta: true }],
    ["missing response id", { ...served(), message: { ...served().message, id: undefined } }],
    ["missing session", { ...notice(), sessionId: undefined }],
    ["contradictory session", { ...served(), session_id: "other" }],
    ["unreadable time", { ...notice(), timestamp: "invalid" }],
    ["SDK snake case", { ...notice(), originalModel: undefined, fallbackModel: undefined, original_model: "claude-opus-5-5", fallback_model: "claude-opus-4-8" }],
  ])("excludes %s", (_label, record) => expect(parseClaudeModelRecord(record)).toBeNull());
  it("main-thread Haiku is a valid served model", () => expect(parse(served("claude-haiku-4-5")).served).toBe("claude-haiku-4-5"));
  it("recognizes the producer's command-message prefix as intent, never as confirmation", () => {
    const e = { type: "user", uuid: "command-prefixed", sessionId: "session-A", timestamp: new Date().toISOString(),
      message: { role: "user", content: "<command-message>model</command-message>\n<command-name>/model</command-name>\n<command-args>claude-sonnet-5-5[1m]</command-args>" } };
    expect(parseClaudeModelRecord(e)).toMatchObject({ kind: "intent", served: "claude-sonnet-5-5[1m]" });
    expect(parseClaudeModelRecord({ ...e, message: { ...e.message, content: "Quoted XML: " + e.message.content } })).toBeNull();
    expect(parseClaudeModelRecord({ ...e, isMeta: true })).toBeNull();
  });
  it.each([
    ["CLAUDE-OPUS-5-5[1m]", "opus-5.5"], ["claude-sonnet-4-5-20250929", "sonnet-4.5"],
    ["claude-3-5-sonnet-20241022", "sonnet-3.5"], ["claude-opus-4", "opus-4.0"],
    ["default", null], ["opusplan", null], ["opus", null], ["best", null], ["arbitrary-unrecognized-model", null],
  ])("normalizes %s to %s", (value, expected) => expect(normalizeClaudeModel(value)).toBe(expected));
});

describe("incident lifecycle without a model/policy action", () => {
  it("one incident survives repeated notices and response blocks, recovers, then allows a new incident", () => {
    const o = new ClaudeModelObserver("claude-opus-5-5", "claude-opus-5-5");
    o.observe(parse(notice()), "claude-opus-4-8"); const first = o.snapshot().active!;
    o.observe(parse({ ...notice(), uuid: "notice-B" }), "claude-opus-4-8");
    o.observe(parse(served()), "claude-opus-4-8"); o.observe(parse(served()), "claude-opus-4-8");
    expect(o.snapshot().active?.id).toBe(first.id);
    o.observe(parse(served("claude-opus-5-5", "response-recovery")), "claude-opus-5-5"); expect(o.snapshot().active).toBeNull();
    o.observe(parse({ ...notice(), uuid: "notice-C" }), "claude-opus-4-8"); expect(o.snapshot().active?.id).not.toBe(first.id);
  });
  it("a local fallback does not rewrite session selection and is recovered by a later configured response", () => {
    const o = new ClaudeModelObserver("claude-opus-5-5", "claude-opus-5-5");
    o.observe(parse({ ...notice(), scope: "local" }), "claude-opus-5-5"); o.observe(parse(served()), "claude-opus-5-5");
    expect(o.snapshot()).toMatchObject({ session: "claude-opus-5-5", lastServed: "claude-opus-4-8", active: { scope: "turn" } });
    o.observe(parse(served("claude-opus-5-5", "next")), "claude-opus-5-5"); expect(o.snapshot().active).toBeNull();
  });
  it("serving a concrete unexpected model proves a difference, not its cause", () => {
    const o = new ClaudeModelObserver("claude-opus-5-5", "claude-opus-5-5"); o.observe(parse(served()), "claude-opus-5-5");
    expect(o.snapshot().active).toMatchObject({ cause: "observed", scope: "unknown" });
  });
  it("next-spawn failover is a launch selection, not a detected provider switch", () => {
    const o = new ClaudeModelObserver("claude-opus-5-5", "claude-opus-4-8"); o.observe(parse(served()), "claude-opus-4-8");
    expect(o.snapshot()).toMatchObject({ configured: "claude-opus-5-5", launch: "claude-opus-4-8", lastServed: "claude-opus-4-8", active: null });
  });
  it("unresolved default/plan selections cannot prove a mismatch", () => {
    for (const model of ["default", "opusplan", "best", "opus"]) {
      const o = new ClaudeModelObserver(model, model); o.observe(parse(served()), model); expect(o.snapshot().active).toBeNull();
      const concreteHook = new ClaudeModelObserver(model, model); concreteHook.observe(parse(served()), "claude-opus-5-5"); expect(concreteHook.snapshot().active).toBeNull();
    }
  });
  it("a resumed checkpoint keeps one quiet incident, dedupes old blocks, and still recovers", () => {
    const prior = new ClaudeModelObserver("claude-opus-5-5", "claude-opus-5-5");
    prior.observe(parse(notice()), "claude-opus-4-8"); prior.observe(parse(served()), "claude-opus-4-8");
    const resumed = new ClaudeModelObserver("claude-opus-5-5", "claude-opus-5-5", prior.checkpoint());
    resumed.bindSession("session-A", "claude-opus-4-8");
    expect(resumed.snapshot().active).toMatchObject({ id: prior.snapshot().active!.id, baseline: true });
    expect(resumed.observe(parse(served()), "claude-opus-4-8")).toBe(false);
    const items = deriveNeedsYou({ prompts: [], instances: [{ name: "worker", modelSwitch: resumed.snapshot().active }], deliveries: [], ownerOf: () => undefined });
    expect(items[0].quiet).toBe(true);
    resumed.observe(parse(served("claude-opus-5-5", "fresh-recovery")), "claude-opus-5-5"); expect(resumed.snapshot().active).toBeNull();
    resumed.bindSession("new-session", "claude-opus-5-5"); expect(resumed.snapshot().lastServed).toBeNull();
  });
  it("a corrupt or differently configured checkpoint is not adopted", () => {
    const prior = new ClaudeModelObserver("claude-opus-5-5", "claude-opus-5-5"); prior.observe(parse(notice()), "claude-opus-4-8");
    expect(new ClaudeModelObserver("claude-sonnet-5-5", "claude-sonnet-5-5", prior.checkpoint()).snapshot().active).toBeNull();
    expect(new ClaudeModelObserver("claude-opus-5-5", "claude-opus-5-5", { ...prior.checkpoint(), seen: ["secret path / invalid"] }).snapshot().active).toBeNull();
  });
  it("raw concrete intent needs both session and served confirmation before replacing an active switch", () => {
    const o = new ClaudeModelObserver("claude-opus-5-5", "claude-opus-5-5");
    o.observe(parse(notice()), "claude-opus-4-8"); const active = o.snapshot().active;
    o.observe({ kind: "intent", id: "model-intent", sessionId: "session-A", at: Date.now(), served: "claude-sonnet-5-5" }, "claude-opus-5-5");
    o.observe(parse(served("claude-sonnet-5-5", "unconfirmed")), "claude-opus-5-5");
    expect(o.checkpoint().expected).toBe("claude-opus-5-5"); expect(o.snapshot().active).toEqual(active);
    o.observe(parse(served("claude-sonnet-5-5", "confirmed")), "claude-sonnet-5-5");
    expect(o.checkpoint().expected).toBe("claude-sonnet-5-5"); expect(o.snapshot().active).toBeNull();
  });
  it("an unresolved alias intent keeps inference unconfirmed until a concrete selection or typed notice", () => {
    const o = new ClaudeModelObserver("claude-opus-5-5", "claude-opus-5-5");
    o.ownIntent("opus"); o.observe(parse(served("claude-sonnet-5-5", "alias-first")), "claude-sonnet-5-5");
    o.observe(parse(served("claude-haiku-4-5", "alias-next")), "claude-sonnet-5-5");
    expect(o.snapshot().active).toBeNull(); expect(o.checkpoint().expected).toBe("claude-opus-5-5");
    o.observe(parse(notice()), "claude-sonnet-5-5"); expect(o.snapshot().active?.cause).toBe("safeguards");
  });
  it("an owned applied switch changes the expected selection without creating an incident", () => {
    const o = new ClaudeModelObserver("claude-opus-5-5", "claude-opus-5-5"); o.ownIntent("claude-sonnet-5-5"); o.ownResult(true, "claude-sonnet-5-5");
    o.observe(parse(served("claude-sonnet-5-5")), "claude-sonnet-5-5"); expect(o.snapshot().active).toBeNull();
  });
  it("an unconfirmed command is not an applied switch; a typed provider notice still proves fallback", () => {
    const o = new ClaudeModelObserver("claude-opus-5-5", "claude-opus-5-5");
    const command = { type: "user", uuid: "command-A", sessionId: "session-A", timestamp: new Date().toISOString(), message: { content: "<command-name>/model</command-name><command-args>opus</command-args>" } };
    o.observe(parse(command), "claude-opus-5-5"); o.observe(parse(served()), "claude-opus-4-8"); expect(o.snapshot().active).toBeNull();
    o.observe(parse(notice()), "claude-opus-4-8"); expect(o.snapshot().active?.cause).toBe("safeguards");
  });
  it("an old copied response cannot overwrite a later observation", () => {
    const o = new ClaudeModelObserver("claude-opus-5-5", "claude-opus-5-5");
    o.observe(parse({ ...served("claude-opus-5-5"), timestamp: "2026-11-13T12:00:00Z" }), "claude-opus-5-5");
    o.observe(parse({ ...served(), timestamp: "2026-11-13T11:00:00Z" }), "claude-opus-5-5"); expect(o.snapshot().lastServed).toBe("claude-opus-5-5");
  });
  it("Needs you uses the incident identity for quiet updates, and removes it on recovery", () => {
    const o = new ClaudeModelObserver("claude-opus-5-5", "claude-opus-5-5"); o.observe(parse(notice()), "claude-opus-4-8");
    const inputs: any = { prompts: [], instances: [{ name: "worker", modelSwitch: o.snapshot().active }], deliveries: [], tasks: [], ownerOf: () => undefined, now: Date.now() };
    const first = deriveNeedsYou(inputs); expect(first).toHaveLength(1); expect(first[0].reason).toBe("model_switch");
    o.observe(parse(served()), "claude-opus-4-8"); inputs.instances[0].modelSwitch = o.snapshot().active;
    expect(deriveNeedsYou(inputs)[0].id).toBe(first[0].id);
    o.observe(parse(served("claude-opus-5-5", "recovered")), "claude-opus-5-5"); inputs.instances[0].modelSwitch = o.snapshot().active;
    expect(deriveNeedsYou(inputs)).toEqual([]);
  });
});

it("Log uses typed structured switches and bounded served metadata, excluding child and no-fallback records", () => {
  const p = new ClaudeStepParser();
  const steps = p.push(JSON.stringify(notice()), 100);
  expect(steps[0]).toMatchObject({ kind: "state", note: "Model switched: claude-opus-5-5 → claude-opus-4-8", modelSwitch: { original: "claude-opus-5-5", served: "claude-opus-4-8" } });
  expect(JSON.stringify(steps)).not.toContain("NEVER EXPOSE");
  expect(p.push(JSON.stringify({ ...notice(), isSidechain: true }), 200)).toEqual([]);
  expect(p.push(JSON.stringify({ ...notice(), subtype: "model_refusal_no_fallback" }), 300)).toEqual([]);
  const response = served(); response.message.content = [{ type: "text", text: "fixture answer" }] as any;
  expect(p.push(JSON.stringify(response), 400)[0]).toMatchObject({ servedModel: "claude-opus-4-8" });
});

describe("active hook + append source ownership", () => {
  function rig() {
    const dir = mkdtempSync(join(tmpdir(), "agend-switch-source-")); dirs.push(dir);
    const path = join(dir, "session-A.jsonl"), startedAt = Date.now() - 1000;
    const hook: any = { _agendLaunchId: "launch-A", session_id: "session-A", transcript_path: path, model: { id: "claude-opus-5-5" } };
    const save = () => writeFileSync(join(dir, "statusline.json"), JSON.stringify(hook)); save();
    const m = new TranscriptMonitor(dir, pino({ level: "silent" }) as any, null, () => ({ id: "launch-A", startedAt })) as any;
    const events: any[] = []; m.on("model_observation", (e: any) => events.push(e));
    return { dir, path, hook, save, m, events, startedAt };
  }
  it.each(["old marker", "other session", "child file", "other path", "missing marker"])("rejects %s", (kind) => {
    const r = rig();
    if (kind === "old marker") r.hook._agendLaunchId = "old-launch";
    if (kind === "other session") r.hook.session_id = "other";
    if (kind === "child file") r.hook.transcript_path = join(r.dir, "subagents", "session-A.jsonl");
    if (kind === "other path") r.m.transcriptPath = join(r.dir, "other.jsonl");
    if (kind === "missing marker") delete r.hook._agendLaunchId;
    r.save(); r.m.processEntry(notice()); expect(r.events).toEqual([]);
  });
  it("rejects bootstrap history even within the old 5-second alarm skew window", () => {
    const r = rig(); r.m.processEntry({ ...notice(), timestamp: new Date(r.startedAt - 1).toISOString() }); expect(r.events).toEqual([]);
  });
  it("baselines a resumed file, observes only appends, and does not replay after resetting", async () => {
    const r = rig(); writeFileSync(r.path, JSON.stringify({ ...notice(), timestamp: new Date(Date.now() - 60_000).toISOString() }) + "\n");
    await r.m.pollIncrement(); expect(r.events).toEqual([]);
    appendFileSync(r.path, JSON.stringify({ ...notice(), uuid: "appended" }) + "\n"); await r.m.pollIncrement(); expect(r.events).toHaveLength(1);
    r.m.resetOffset(); await r.m.pollIncrement(); expect(r.events).toHaveLength(1);
  });
  it("keeps first records written by this launch before the monitor was constructed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-switch-early-")); dirs.push(dir);
    const path = join(dir, "session-A.jsonl"), startedAt = Date.now() - 1000;
    writeFileSync(path, [notice(), { ...served(), message: { ...served().message, content: [{ type: "text", text: "not a new text event" }] } }].map(e => JSON.stringify(e)).join("\n") + "\n");
    await new Promise(resolve => setTimeout(resolve, 20));
    writeFileSync(join(dir, "statusline.json"), JSON.stringify({ _agendLaunchId: "launch-A", session_id: "session-A", transcript_path: path }));
    const m = new TranscriptMonitor(dir, pino({ level: "silent" }) as any, null, () => ({ id: "launch-A", startedAt }));
    const events: any[] = [], texts: string[] = []; m.on("model_observation", e => events.push(e)); m.on("assistant_text", text => texts.push(text));
    await m.pollIncrement(); await m.pollIncrement(); expect(events).toHaveLength(2);
    expect(texts).toEqual([]); // Adding observations must not replay the existing text/alarm path.
  });
});
