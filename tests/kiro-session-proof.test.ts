/**
 * M-2025: `/session-id` announcement and `/title` confirmation on kiro tui/V3.
 * The pin is compared with kiro's own pane text. A mismatch is never repaired
 * by listing session files.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KiroBackend } from "../src/backend/kiro.js";
import {
  KIRO_SESSION_ID_COMMAND,
  kiroTitleCommand,
  proveKiroSessionId,
  readKiroSessionIdAnnouncement,
  readKiroTitleSetAlert,
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
