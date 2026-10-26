/**
 * M-2025: `/session-id` announcement and `/title` confirmation on kiro tui/V3.
 * The pin is compared with kiro's own pane text. A mismatch is never repaired
 * by listing session files.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KiroBackend } from "../src/backend/kiro.js";
import {
  KIRO_SESSION_ID_COMMAND,
  clearKiroSessionProof,
  kiroTitleCommand,
  proveKiroSessionId,
  readKiroSessionIdAnnouncement,
  readKiroSessionProof,
  readKiroTitleSetAlert,
  recordKiroSessionProof,
} from "../src/kiro-session-proof.js";
import { TEST_KIRO_COMPAT } from "./helpers/kiro-compat.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const idle = "›  ask a question or describe a task ↵";
const pane = (body: string) => `${body}\n\n${idle}\n`;

describe("readKiroSessionIdAnnouncement", () => {
  it("reads the id kiro announces", () => {
    expect(readKiroSessionIdAnnouncement(pane(
      "Session ID: conv-owned-1\nResume with: kiro-cli --resume-id conv-owned-1",
    ))).toBe("conv-owned-1");
  });

  it("reads none", () => {
    expect(readKiroSessionIdAnnouncement(pane("Session ID: none"))).toBe("none");
  });

  it("takes the last announcement when an older one is still in view", () => {
    expect(readKiroSessionIdAnnouncement(pane(
      "Session ID: old-id\nResume with: kiro-cli --resume-id old-id\nSession ID: new-id",
    ))).toBe("new-id");
  });

  it("returns null when the announcement is not on the pane", () => {
    expect(readKiroSessionIdAnnouncement(pane("kiro_default · Claude Opus 4.7"))).toBeNull();
  });

  it("hold panes (question, MCP, trust) are not a session-id announcement", () => {
    const fx = (rel: string) => readFileSync(join(import.meta.dirname, "fixtures", rel), "utf8");
    expect(readKiroSessionIdAnnouncement(fx("kiro-question-2592/2.34.0-120-40-question.pane.txt"))).toBeNull();
    expect(readKiroSessionIdAnnouncement(fx("kiro-2.34.0-audit/mcp-120-10-form-2.34.0.pane.txt"))).toBeNull();
    expect(readKiroSessionIdAnnouncement(fx("kiro-2.34.0-audit/t2-trust-120-2.34.0.pane.txt"))).toBeNull();
    expect(readKiroSessionIdAnnouncement(fx("kiro-2.34.0-audit/t2-ready-120-2.34.0.pane.txt"))).toBeNull();
  });

  it("2.34.0 composed panes: last Session ID: line, none, and Title set:", () => {
    const fx = (rel: string) => readFileSync(join(import.meta.dirname, "fixtures", "kiro-session-id-2681", rel), "utf8");
    expect(readKiroSessionIdAnnouncement(fx("tui-session-id.pane.txt"))).toBe("conv-owned-1");
    expect(readKiroSessionIdAnnouncement(fx("tui-session-id-none.pane.txt"))).toBe("none");
    expect(readKiroSessionIdAnnouncement(fx("tui-session-id-last.pane.txt"))).toBe("conv-owned-1");
    expect(readKiroTitleSetAlert(fx("tui-title-set.pane.txt"))).toBe("agend-dev-grok-t1");
    expect(readKiroSessionIdAnnouncement(fx("tui-title-set.pane.txt"))).toBeNull();
  });

  it("2.34.0 tui.js: /session-id and /title are alerts, not chat turns", () => {
    const src = readFileSync(join(import.meta.dirname, "fixtures/kiro-session-id-2681/tui.js-showSessionId-updateTitle.txt"), "utf8");
    expect(src).toContain("announceSystem(r,!0,1e4)");
    expect(src).toContain("Session ID: ${n}");
    expect(src).toContain("Session ID: none");
    expect(src).toContain("showAlert(`Title set: ${a.title}`");
    expect(src).not.toMatch(/Prompt|AssistantMessage|user_turn_metadatas/);
  });
});

describe("proveKiroSessionId", () => {
  it("match: the pin and the pane agree", () => {
    expect(proveKiroSessionId("conv-1", "conv-1")).toEqual({ kind: "match", id: "conv-1" });
  });

  it("fresh: no pin, kiro named an id — still not a file-store guess", () => {
    expect(proveKiroSessionId(null, "conv-fresh")).toEqual({ kind: "fresh", id: "conv-fresh" });
  });

  it("mismatch: pinned resume id is not the one kiro printed", () => {
    expect(proveKiroSessionId("pinned-a", "other-b")).toEqual({
      kind: "mismatch", pinned: "pinned-a", observed: "other-b",
    });
  });

  it("mismatch: pin exists and kiro said none", () => {
    expect(proveKiroSessionId("pinned-a", "none")).toEqual({
      kind: "mismatch", pinned: "pinned-a", observed: "none",
    });
  });

  it("unread: no announcement — do not invent an id from files", () => {
    expect(proveKiroSessionId("pinned-a", null)).toEqual({ kind: "unread" });
    expect(proveKiroSessionId(null, null)).toEqual({ kind: "unread" });
  });

  it("none with no pin is just none", () => {
    expect(proveKiroSessionId(null, "none")).toEqual({ kind: "none" });
  });

  it("mutation: unread is never filled from a file-store id the caller happens to have", () => {
    // proveKiroSessionId has no store argument. Passing a pin and a null pane
    // stays unread — the pin is not adopted as proven.
    expect(proveKiroSessionId("file-guessed-id", null)).toEqual({ kind: "unread" });
  });
});

describe("recordKiroSessionProof", () => {
  it("writes match and fresh; none and unsafe ids are refused; clear drops the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiro-proof-rec-"));
    dirs.push(dir);
    expect(recordKiroSessionProof(dir, { sessionId: "conv-1", kind: "match", provenAt: 1 })).toEqual({
      version: 1, sessionId: "conv-1", kind: "match", source: "/session-id", provenAt: 1,
    });
    expect(readKiroSessionProof(dir)?.sessionId).toBe("conv-1");
    recordKiroSessionProof(dir, { sessionId: "fresh-2", kind: "fresh", provenAt: 2 });
    expect(readKiroSessionProof(dir)).toMatchObject({ sessionId: "fresh-2", kind: "fresh" });
    expect(() => recordKiroSessionProof(dir, { sessionId: "none", kind: "fresh" })).toThrow();
    expect(readKiroSessionProof(dir)?.sessionId).toBe("fresh-2");
    clearKiroSessionProof(dir);
    expect(readKiroSessionProof(dir)).toBeNull();
  });

  it("mutation: the proof file is not an identity claim and is the only file written", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiro-proof-only-"));
    dirs.push(dir);
    recordKiroSessionProof(dir, { sessionId: "conv-1", kind: "match", provenAt: 1 });
    expect(readdirSync(dir)).toEqual(["kiro-session-proof.json"]);
    const rec = JSON.parse(readFileSync(join(dir, "kiro-session-proof.json"), "utf8")) as Record<string, unknown>;
    expect(rec).toEqual({
      version: 1, sessionId: "conv-1", kind: "match", source: "/session-id", provenAt: 1,
    });
    expect(rec).not.toHaveProperty("agentConfirmed");
    expect(rec).not.toHaveProperty("keys");
    expect(rec).not.toHaveProperty("instance");
  });
});

describe("title command", () => {
  it("is /title plus the instance name", () => {
    expect(kiroTitleCommand("agend-dev-grok-t1")).toBe("/title agend-dev-grok-t1");
    expect(KIRO_SESSION_ID_COMMAND).toBe("/session-id");
  });

  it("refuses an empty or multiline name", () => {
    expect(kiroTitleCommand("  ")).toBeNull();
    expect(kiroTitleCommand("a\nb")).toBeNull();
  });

  it("reads kiro's Title set alert", () => {
    expect(readKiroTitleSetAlert(pane("Title set: agend-dev-grok-t1"))).toBe("agend-dev-grok-t1");
    expect(readKiroTitleSetAlert(pane(idle))).toBeNull();
  });
});

describe("KiroBackend.sessionProof", () => {
  function backend(ui: "legacy" | "tui" | "v3", instanceName = "agend-dev-grok-t1") {
    const instanceDir = mkdtempSync(join(tmpdir(), "kiro-proof-i-"));
    const workingDirectory = mkdtempSync(join(tmpdir(), "kiro-proof-w-"));
    dirs.push(instanceDir, workingDirectory);
    const b = new KiroBackend(instanceDir, TEST_KIRO_COMPAT);
    b.buildCommand({ workingDirectory, instanceDir, instanceName, mcpServers: {}, kiroUi: ui });
    return b;
  }

  it("legacy: null — the commands do not exist", () => {
    expect(backend("legacy").sessionProof()).toBeNull();
  });

  for (const ui of ["tui", "v3"] as const) {
    it(`${ui}: /session-id and /title <name>; pin is the resume id only`, () => {
      const b = backend(ui);
      expect(b.sessionProof()).toEqual({
        pinned: null,
        sessionIdCommand: "/session-id",
        titleCommand: "/title agend-dev-grok-t1",
      });
      (b as unknown as { activePlan: { mode: string; id: string } }).activePlan = { mode: "resume", id: "sess_abc" };
      expect(b.sessionProof()?.pinned).toBe("sess_abc");
    });
  }
});
