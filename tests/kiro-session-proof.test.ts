/**
 * M-2025: `/session-id` and `/title` on kiro tui/V3, read off live 2.34.0 panes (#2683).
 * The pin is compared with kiro's own pane text. A mismatch is never repaired
 * by listing session files.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KiroBackend, readKiroCommandComposer, readKiroSessionIdAlert } from "../src/backend/kiro.js";
import {
  KIRO_SESSION_ID_COMMAND,
  clearKiroSessionProof,
  kiroTitleCommand,
  proveKiroSessionId,
  readKiroSessionProof,
  recordKiroSessionProof,
} from "../src/kiro-session-proof.js";
import { TEST_KIRO_COMPAT } from "./helpers/kiro-compat.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const fx = (rel: string) => readFileSync(join(import.meta.dirname, "fixtures", rel), "utf8");
const sid = (name: string) => fx(`kiro-session-id-2681/${name}.pane.txt`);
/** Replace one row of a captured pane, verbatim. */
const swap = (pane: string, from: string, to: string) => {
  expect(pane.split("\n")).toContain(from);
  return pane.split("\n").map(row => row === from ? to : row).join("\n");
};

describe("#2683 readKiroSessionIdAlert: only kiro's alert right above the footer", () => {
  it("reads the live 2.34.0 alert on tui and V3", () => {
    expect(readKiroSessionIdAlert(sid("tui-session-id-alert"))).toBe("mock-session-id");
    expect(readKiroSessionIdAlert(sid("v3-session-id-alert"))).toBe("mock-session-id");
  });

  it("no alert: ready, the menu, the alert gone, /title's answer, a quoted user turn", () => {
    for (const name of ["tui-ready", "v3-ready", "tui-session-id-menu", "v3-session-id-menu", "tui-session-id-alert-gone",
      "tui-title-disabled", "v3-quoted-history", "v3-draft"]) {
      expect(readKiroSessionIdAlert(sid(name)), name).toBeNull();
    }
  });

  it("Session ID: none alone, right above the divider (derived from the live alert)", () => {
    const rows = sid("tui-session-id-alert").split("\n");
    rows.splice(rows.indexOf("• Session ID: mock-session-id"), 2, "• Session ID: none");
    expect(readKiroSessionIdAlert(rows.join("\n"))).toBe("none");
    rows.splice(rows.indexOf("• Session ID: none") + 1, 0, "");
    expect(readKiroSessionIdAlert(rows.join("\n"))).toBeNull();
  });

  it("the two lines must name the same id, verbatim", () => {
    const alert = sid("tui-session-id-alert");
    expect(readKiroSessionIdAlert(swap(alert, "• Session ID: mock-session-id", "• Session ID: other-id"))).toBeNull();
    expect(readKiroSessionIdAlert(swap(alert, "• Session ID: mock-session-id", "  › • Session ID: mock-session-id"))).toBeNull();
    expect(readKiroSessionIdAlert(swap(alert, "  Resume with: kiro-cli --resume-id mock-session-id",
      "  Resume with: kiro-cli --resume-id mock-session-id extra"))).toBeNull();
  });

  it("the same lines higher up the chat are not the alert", () => {
    const rows = sid("tui-session-id-alert").split("\n");
    const at = rows.indexOf("• Session ID: mock-session-id");
    rows.splice(at + 2, 0, "• a later answer");
    expect(readKiroSessionIdAlert(rows.join("\n"))).toBeNull();
  });

  it("no footer divider within 8 rows of the box: no alert is read", () => {
    const pane = ["• Session ID: conv-1", "  Resume with: kiro-cli --resume-id conv-1", "x",
      ...Array(8).fill("filler"), "›  ask a question or describe a task ↵", ""].join("\n");
    expect(readKiroSessionIdAlert(pane)).toBeNull();
  });

  it("without the trust banner, the footer's only divider is the anchor", () => {
    const rows = sid("tui-session-id-alert").split("\n");
    const banner = rows.findIndex(row => row.startsWith(" Trust All Tools active"));
    rows.splice(banner, 2);
    expect(readKiroSessionIdAlert(rows.join("\n"))).toBe("mock-session-id");
  });

  it("hold panes (question, MCP, trust) and a takeover are never an alert", () => {
    expect(readKiroSessionIdAlert(fx("kiro-question-2592/2.34.0-120-40-question.pane.txt"))).toBeNull();
    expect(readKiroSessionIdAlert(fx("kiro-2.34.0-audit/mcp-120-10-form-2.34.0.pane.txt"))).toBeNull();
    expect(readKiroSessionIdAlert(fx("kiro-2.34.0-audit/t2-trust-120-2.34.0.pane.txt"))).toBeNull();
    expect(readKiroSessionIdAlert(fx("kiro-2.34.0-takeover-2682/tui-editor-vi.pane.txt"))).toBeNull();
  });
});

describe("#2683 readKiroCommandComposer: empty, a one-row draft, or unreadable", () => {
  it("empty only on the idle placeholder", () => {
    for (const name of ["tui-ready", "v3-ready", "tui-session-id-alert", "v3-session-id-alert", "tui-title-disabled", "v3-quoted-history"]) {
      expect(readKiroCommandComposer(sid(name)), name).toBe("");
    }
  });

  it("reads our command past kiro's command menu, and a command with an argument", () => {
    expect(readKiroCommandComposer(sid("tui-session-id-menu"))).toBe("/session-id");
    expect(readKiroCommandComposer(sid("v3-session-id-menu"))).toBe("/session-id");
    expect(readKiroCommandComposer(sid("tui-title-typed"))).toBe("/title agend-x");
  });

  it("a person's draft is its own text, never empty", () => {
    expect(readKiroCommandComposer(sid("v3-draft"))).toBe("draft from the person");
    expect(readKiroCommandComposer(sid("v3-menu-partial"))).toBe("/se");
  });

  it("a busy composer, a wrapped draft, a takeover, a dialog: unreadable", () => {
    expect(readKiroCommandComposer(fx("kiro-2.34.0-takeover-2682/tui-bang-running.pane.txt"))).toBeNull();
    expect(readKiroCommandComposer(fx("kiro-2.34.0-takeover-2682/tui-editor-vi.pane.txt"))).toBeNull();
    expect(readKiroCommandComposer(fx("kiro-2.34.0-audit/t2-trust-120-2.34.0.pane.txt"))).toBeNull();
    const wrapped = swap(sid("v3-draft"), "› draft from the person", "› draft from the person\n  and its second row");
    expect(readKiroCommandComposer(wrapped)).toBeNull();
  });

  it("a menu without the box row above it is not read", () => {
    const rows = sid("v3-session-id-menu").split("\n");
    rows[rows.indexOf("› /session-id")] = "  › /session-id";
    expect(readKiroCommandComposer(rows.join("\n"))).toBeNull();
  });
});

describe("tui.js contract", () => {
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
        readComposer: readKiroCommandComposer,
        readSessionIdAlert: readKiroSessionIdAlert,
      });
      (b as unknown as { activePlan: { mode: string; id: string } }).activePlan = { mode: "resume", id: "sess_abc" };
      expect(b.sessionProof()?.pinned).toBe("sess_abc");
    });
  }
});
