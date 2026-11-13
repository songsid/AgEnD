import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, it, vi } from "vitest";
import { Daemon } from "../src/daemon.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { outboundHandlers } from "../src/outbound-handlers.js";

vi.mock("../src/backend/types.js", async original => ({ ...await original<any>(), resolveBinary: (name: string) => name }));
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "agend-model-daemon-")); dirs.push(dir);
  const launch = { id: "launch-current", startedAt: Date.now() - 1000 };
  const backend: any = { binaryName: "claude", modelObservationLaunch: () => launch };
  const d: any = new Daemon("worker", { backend: "claude-code", model: "claude-opus-5-5", working_directory: dir, log_level: "silent" } as any,
    dir, false, backend, undefined, pino({ level: "silent" }) as any);
  const m = d.buildTranscriptMonitor(null); d.transcriptMonitor = m;
  writeFileSync(join(dir, "statusline.json"), JSON.stringify({ _agendLaunchId: launch.id, session_id: "session-A", transcript_path: join(dir, "session-A.jsonl"), model: { id: "claude-opus-4-8" } }));
  const record = { type: "system", subtype: "model_refusal_fallback", sessionId: "session-A", uuid: "notice-A", timestamp: new Date().toISOString(),
    originalModel: "claude-opus-5-5", fallbackModel: "claude-opus-4-8", scope: "session" };
  return { dir, launch, backend, d, m, record };
}
it("the actual daemon wires metadata to read-only presentation, persists it, and fences replaced monitors/launches", () => {
  const { d, m, record, dir } = rig(); const attention = vi.fn(), pty = vi.fn();
  d.on("model_observation", attention); d.on("pty_error", pty);
  expect(d.modelObservation()).toBeNull(); m.processEntry(record);
  expect(d.modelObservation()).toMatchObject({ configured: "claude-opus-5-5", active: { cause: "safeguards" } });
  expect(attention).toHaveBeenCalledTimes(1); expect(pty).not.toHaveBeenCalled(); expect(d.modelOverride).toBeUndefined();
  expect(JSON.parse(readFileSync(join(dir, "claude-model-observation.json"), "utf8")).active.original).toBe("claude-opus-5-5");
  d.launchFenceEpoch++; m.processEntry({ ...record, uuid: "stale-generation", fallbackModel: "claude-haiku-4-5" });
  expect(attention).toHaveBeenCalledTimes(1); expect(d.modelObservation().active.served).toBe("claude-opus-4-8");
  d.launchFenceEpoch--; d.transcriptMonitor = {}; m.processEntry({ ...record, uuid: "stale-monitor", fallbackModel: "claude-haiku-4-5" });
  expect(attention).toHaveBeenCalledTimes(1);
});
it("the generated hook stamps the inherited launch owner even when an older process runs the rewritten script", () => {
  const { dir } = rig(); const b = new ClaudeCodeBackend(dir) as any;
  const path = b.writeStatusLineScript();
  const input = JSON.stringify({ session_id: "session-A", transcript_path: join(dir, "session-A.jsonl"), model: { id: "claude-opus-5-5" } });
  execFileSync(process.execPath, [path], { input, env: { ...process.env, AGEND_CLAUDE_LAUNCH_ID: "old-owner" } });
  expect(JSON.parse(readFileSync(join(dir, "statusline.json"), "utf8"))).toMatchObject({ _agendLaunchId: "old-owner", session_id: "session-A" });
  execFileSync(process.execPath, [path], { input, env: { ...process.env, AGEND_CLAUDE_LAUNCH_ID: b.modelObservationLaunch().id } });
  expect(JSON.parse(readFileSync(join(dir, "statusline.json"), "utf8"))).toMatchObject({ _agendLaunchId: b.modelObservationLaunch().id });
});
it("describe_instance keeps the switch compact by default and exposes the bounded observation only on detail", async () => {
  const { d, m, record } = rig(); m.processEntry(record);
  const ctx: any = { fleetConfig: { instances: { worker: { backend: "claude-code", model: "claude-opus-5-5", working_directory: "/fixture" } } },
    lifecycle: { isPaused: () => false, daemons: new Map([["worker", d]]), getLastPausedAt: () => null },
    lastActivityMs: () => 0, modelObservationForInstance: () => d.modelObservation() };
  const handler = outboundHandlers.get("describe_instance")!;
  let compact: any, detail: any;
  await handler(ctx, { name: "worker" }, value => { compact = value; }, {} as any);
  await handler(ctx, { name: "worker", detail: true }, value => { detail = value; }, {} as any);
  expect(compact.model_switch).toEqual({ original: "claude-opus-5-5", served: "claude-opus-4-8", cause: "safeguards", scope: "session" });
  expect(compact).not.toHaveProperty("model_observation"); expect(JSON.stringify(compact)).not.toContain("notice-A");
  expect(detail.model_observation).toMatchObject({ configured: "claude-opus-5-5", session: "claude-opus-4-8", active: { scope: "session" } });
  expect(detail).not.toHaveProperty("model_switch");
});
it.each(["opus", "", "claude-sonnet-5-5"])("the actual daemon preserves unconfirmed /model %s through disk restore and replay", requested => {
  const { d, m, dir, backend } = rig();
  const intent = { type: "user", uuid: "pending-intent", sessionId: "session-A", timestamp: new Date().toISOString(),
    message: { role: "user", content: `<command-message>model</command-message>\n<command-name>/model</command-name>${requested ? `<command-args>${requested}</command-args>` : ""}` } };
  const served = (id: string) => ({ type: "assistant", sessionId: "session-A", uuid: `record-${id}`, timestamp: new Date().toISOString(),
    message: { id, role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: "end_turn" } });
  m.processEntry(intent); m.processEntry(served("before-resume"));
  expect(d.modelObservation().active).toBeNull();
  const checkpoint = JSON.parse(readFileSync(join(dir, "claude-model-observation.json"), "utf8"));
  expect(checkpoint.seen.some((id: string) => id.includes("pending-intent"))).toBe(true);
  const resumed: any = new Daemon("worker", { backend: "claude-code", model: "claude-opus-5-5", working_directory: dir, log_level: "silent" } as any,
    dir, false, backend, undefined, pino({ level: "silent" }) as any);
  const monitor = resumed.buildTranscriptMonitor(null); resumed.transcriptMonitor = monitor;
  monitor.processEntry(intent); monitor.processEntry(served("after-resume"));
  expect(resumed.modelObservation().active).toBeNull();
  expect(resumed.modelObservation()).toMatchObject({ lastServed: "claude-sonnet-5-5" });
});
