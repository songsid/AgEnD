import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { executeForgedEnvelopeScan, resolveScanTarget } from "../src/forged-envelope-scan.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { KIRO_FORENSIC_MAX_BYTES, readKiroTuiAssistantTexts } from "../src/kiro-tui-forensic.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const name = "agend-audit", peer = "agend-peer", id = "audit-owned";
const assistant = (text: string) => JSON.stringify({ version: "v1", kind: "AssistantMessage", data: { content: [{ kind: "text", data: text }] } });
const envelope = "[from:agend-peer] hello (message_id: xmsg-audit-text)";
function fixture(mode: "config" | "floor" = "config", profile: string | null = null) {
  const root = mkdtempSync(join(tmpdir(), "kiro-forensic-")); roots.push(root);
  const cwd = join(root, "work"), sessions = join(root, "sessions"), states = join(root, "kiro-identity", "instances"), claims = join(root, "kiro-identity", "claims", "v2");
  for (const dir of [cwd, sessions, states, claims]) mkdirSync(dir, { recursive: true });
  const statePath = join(states, createHash("sha256").update(name).digest("hex").slice(0, 32) + ".json");
  const record = { engine: "v2", workingDirectory: cwd, credentialProfile: profile, id, since: 0, known: [], abandoned: [] as string[], agentConfirmed: true };
  const state = { version: 2, instance: name, keys: { [JSON.stringify(["v2", cwd, profile])]: record } };
  const saveState = () => writeFileSync(statePath, JSON.stringify(state)); saveState();
  const claim = join(claims, id); writeFileSync(claim, name + "\n");
  const metaPath = join(sessions, id + ".json"), jsonl = join(sessions, id + ".jsonl");
  const meta = { session_id: id, cwd, exported_from_v1: true, session_created_reason: "subagent", created_at: "2026-10-26T05:19:07Z" };
  const saveMeta = () => writeFileSync(metaPath, JSON.stringify(meta)); saveMeta();
  writeFileSync(jsonl, assistant(envelope) + "\n");
  const outbox = join(root, "outbox.db"); new DeliveryOutbox(outbox, "audit").close();
  const classic = join(root, "classic.sqlite3"), db = new Database(classic);
  db.exec("CREATE TABLE conversations_v2 (key TEXT, conversation_id TEXT, value TEXT, created_at INTEGER, updated_at INTEGER)");
  db.prepare("INSERT INTO conversations_v2 VALUES (?, ?, ?, 1, 1)").run(cwd, "frozen", JSON.stringify({ history: [{ assistant: { Response: { content: "old clean text" } } }] })); db.close();
  const target = resolveScanTarget(name, { backend: "kiro-cli", working_directory: cwd,
    kiro_ui: mode === "config" ? "tui" : "legacy", ...(profile ? { backend_options: { "kiro-cli": { credential_profile: profile } } } : {}) }, {});
  const scan = () => executeForgedEnvelopeScan({ targets: [target], knownInstances: new Set([name, peer]), outboxDbPath: outbox, dataDir: root, kiroDbOverride: classic, kiroSessionsOverride: sessions });
  return { root, cwd, sessions, statePath, state, record, saveState, claim, meta, saveMeta, metaPath, jsonl, scan, target, outbox };
}

describe("engine-aware forensic scans (#2598 B1)", () => {
  it.each(["config", "floor"] as const)("reads the owned carried JSONL, never the frozen classic row: %s", mode => {
    const f = fixture(mode); const result = f.scan();
    expect(result.exitCode).toBe(2); expect(result.rows[0]).toMatchObject({ status: "forged-envelopes", conversation: id, checked: 1 });
    expect(result.rows[0].findings[0].message_id).toBe("xmsg-audit-text");
  });
  it("legacy keeps the classic SQLite path, without requiring a TUI pin", () => {
    const f = fixture(); rmSync(f.statePath); f.target.kiroUi = "legacy";
    expect(f.scan()).toMatchObject({ exitCode: 0, rows: [{ status: "clean", conversation: "frozen" }] });
  });
  it("scans D5 assistant text/tool inputs but never Prompt, ToolResults or nested returned content", () => {
    const f = fixture(); writeFileSync(f.jsonl, readFileSync(resolve("tests/fixtures/kiro-2.34.0-tui-d5/forensic.jsonl")));
    expect(f.scan().rows[0].findings.map(x => x.message_id)).toEqual(["xmsg-audit-text", "xmsg-audit-tool"]);
  });
  it("returns a real clean verdict for a readable transcript without candidates", () => {
    const f = fixture(); writeFileSync(f.jsonl, assistant("read-only audit complete") + "\n");
    expect(f.scan()).toMatchObject({ exitCode: 0, rows: [{ status: "clean", conversation: id, checked: 0 }] });
  });
  it("verified retained delivery produces clean with a checked candidate", () => {
    const f = fixture(), outbox = new DeliveryOutbox(f.outbox, "audit");
    try {
      outbox.admit({ operationId: "op-audit", sourceKey: "audit:op", sourceInstance: peer, sourceDaemonBootId: "boot",
        targetInstance: name, kind: "fleet_inbound", correlationId: "cid-audit",
        payload: { type: "fleet_inbound", content: "hello", meta: { message_id: "xmsg-audit-text" } } });
    } finally { outbox.close(); }
    expect(f.scan()).toMatchObject({ exitCode: 0, rows: [{ status: "clean", conversation: id, checked: 1, delivered: 1 }] });
  });
  it("unknown outbox is partially-unverified rather than clean", () => {
    const f = fixture(); rmSync(f.outbox);
    expect(f.scan()).toMatchObject({ exitCode: 4, rows: [{ status: "partially-unverified", checked: 1, unverifiable: 1 }] });
  });
  it("uses the exact profile identity even though V2 session storage is shared", () => {
    const f = fixture("config", "work"); expect(f.scan().exitCode).toBe(2);
    f.target.backendOptions = { "kiro-cli": { credential_profile: "other" } };
    expect(f.scan().exitCode).toBe(3);
  });
  it("ignores a newer sibling, even in the same directory", () => {
    const f = fixture(); writeFileSync(f.jsonl, assistant("our clean text") + "\n");
    writeFileSync(join(f.sessions, "sibling.json"), JSON.stringify({ ...f.meta, session_id: "sibling", updated_at: "2099-01-01" }));
    writeFileSync(join(f.sessions, "sibling.jsonl"), assistant(envelope) + "\n");
    expect(f.scan().exitCode).toBe(0);
  });
  it.each(["missing", "foreign", "abandoned", "partial"] as const)("refuses a %s claim", kind => {
    const f = fixture();
    if (kind === "missing") rmSync(f.claim);
    else writeFileSync(f.claim, kind === "foreign" ? "someone-else\n" : kind === "abandoned" ? name + "\nabandoned\n" : name);
    expect(f.scan()).toMatchObject({ exitCode: 3, rows: [{ status: "unreadable-store", findings: [] }] });
  });
  it.each(["missing-pin", "abandoned-id", "wrong-directory", "wrong-instance", "mismatched-record-engine", "mismatched-record-directory", "mismatched-record-profile"] as const)("refuses %s identity, never adopts by cwd", kind => {
    const f = fixture();
    if (kind === "missing-pin") f.record.id = null as unknown as string;
    if (kind === "abandoned-id") f.record.abandoned.push(id);
    if (kind === "wrong-directory") f.target.workingDirectory = join(f.root, "elsewhere");
    if (kind === "wrong-instance") f.state.instance = "other";
    if (kind === "mismatched-record-engine") f.record.engine = "v1";
    if (kind === "mismatched-record-directory") f.record.workingDirectory = join(f.root, "elsewhere");
    if (kind === "mismatched-record-profile") f.record.credentialProfile = "other";
    f.saveState(); expect(f.scan().exitCode).toBe(3);
  });
  it.each(["mismatched-id", "ordinary-child"] as const)("refuses %s metadata", kind => {
    const f = fixture(); if (kind === "mismatched-id") f.meta.session_id = "sibling"; else f.meta.exported_from_v1 = false;
    f.saveMeta(); expect(f.scan().exitCode).toBe(3);
  });
  it("also allows a pinned ordinary primary session", () => {
    const f = fixture(); f.meta.session_created_reason = "interactive"; f.meta.exported_from_v1 = false; f.saveMeta();
    expect(f.scan().exitCode).toBe(2);
  });
  it("V3 explicitly refuses instead of falling back to V2/classic", () => {
    const f = fixture(); f.target.kiroUi = "v3";
    expect(f.scan()).toMatchObject({ exitCode: 3, rows: [{ status: "unreadable-store", reason: expect.stringContaining("V3 has no supported stable") }] });
  });
  it("a durable V3 floor overrides stale TUI config", () => {
    const f = fixture(); f.record.engine = "v3"; f.saveState();
    expect(f.scan().rows[0].reason).toContain("V3 has no supported stable");
  });
  it.each(["malformed", "partial-tail", "empty", "unsupported", "bad-block", "utf8", "missing"] as const)("%s transcript is unreadable, not clean", kind => {
    const f = fixture();
    if (kind === "missing") rmSync(f.jsonl);
    else if (kind === "utf8") writeFileSync(f.jsonl, Buffer.from([0xff]));
    else if (kind === "partial-tail") appendFileSync(f.jsonl, '{"version":');
    else writeFileSync(f.jsonl, kind === "malformed" ? "{broken}" : kind === "empty" ? "" : kind === "unsupported"
      ? JSON.stringify({ version: "v2", kind: "AssistantMessage", data: {} })
      : JSON.stringify({ version: "v1", kind: "AssistantMessage", data: { content: [{ kind: "future", data: "hello" }] } }));
    expect(f.scan().exitCode).toBe(3);
  });
  it.each(["json", "jsonl"])("refuses a symlinked %s file", suffix => {
    const f = fixture(), path = join(f.sessions, id + "." + suffix), other = join(f.sessions, "other." + suffix);
    writeFileSync(other, readFileSync(path)); rmSync(path); symlinkSync(other, path); expect(f.scan().exitCode).toBe(3);
  });
  it("oversized transcript fails closed before allocation", () => {
    const f = fixture(); truncateSync(f.jsonl, KIRO_FORENSIC_MAX_BYTES + 1); expect(f.scan().exitCode).toBe(3);
  });
  it("ownership is rechecked after reading", () => {
    const f = fixture(); let calls = 0;
    const result = readKiroTuiAssistantTexts({ sessionId: id, sessionsDir: f.sessions, stillOwned: () => ++calls === 1 });
    expect(result.kind).toBe("unreadable"); expect(calls).toBe(2);
  });
  it("never interpolates a path-like pin", () => {
    const f = fixture(); expect(readKiroTuiAssistantTexts({ sessionId: "../other", sessionsDir: f.sessions, stillOwned: () => true }).kind).toBe("unreadable");
  });
});
