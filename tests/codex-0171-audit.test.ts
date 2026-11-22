import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";

const home = mkdtempSync(join(tmpdir(), "codex-0171-fixtures-"));
writeFileSync(join(home, "config.toml"), '[tui]\nstatus_line = ["session-id", "context-remaining", "model-with-reasoning", "current-dir", "git-branch"]\n');
const backend = new CodexBackend(join(home, "missing-instance"));
(backend as any).isolatedCodexHome = home;
(backend as any).sharedCodexHome = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
const versions = ["01700", "01710"];
const frame = (v: string, name: string) => readFileSync(new URL(`./fixtures/codex-audit-0171/${v}/${name}.pane.txt`, import.meta.url), "utf8");
const active = (d: any, pane: string) => {
  if (d.isActive) return d.isActive(pane);
  d.pattern.lastIndex = 0;
  return d.pattern.test(pane);
};
function reading(pane: string) {
  const dialogs = (ds: readonly any[]) => ds.filter(d => active(d, pane)).map(d => ({ description: d.description, keys: d.keys, hold: !!d.holdOnly }));
  return {
    ready: backend.getReadyPattern().test(pane), busy: backend.getBusyPattern().test(pane),
    deliverable: backend.isDeliveryInputReadyPane(pane), redraw: backend.isPeriodicRedrawIdlePane(pane),
    stable: backend.isStableUnknownLayoutIdlePane(pane),
    resume: backend.getInputUnavailableTransients().some(d => d.isActive(pane)),
    runtime: dialogs(backend.getRuntimeDialogs()), startup: dialogs(backend.getStartupDialogs()),
    errors: [...new Set(backend.getErrorPatterns().filter(p => { p.pattern.lastIndex = 0; return p.pattern.test(pane); }).map(p => p.type))].sort(),
  };
}
const surfaces = ["idle", "turn-idle", "busy", "near-suppressed", "usage", "ws-credits", "ws-credits-dismissed", "ws-spend", "ws-spend-dismissed",
  "e401", "e500", "capacity", "model-not-found", "compact", "resume-loading", "resumed", "resumed-turn", "trust", "plain-dir", "rate-picker", "rate-dismissed", "rate-picker-80",
  "signin-menu", "signin-other-selected", "signin-another-way"];
const statusStates = ["production-150", "production-80", "production-50", "workspace-production-flag", "owned-main-150", "owned-unfocused-150",
  "owned-refocused-150", "owned-main-110", "owned-unfocused-110", "owned-main-95", "owned-sidebar-only-95", "owned-refocused-95"];

describe("Codex 0.170 versus 0.171: captured mock-provider surfaces", () => {
  it("keeps session identities and profile paths synthetic even inside ANSI styling", () => {
    let checked = 0;
    for (const v of versions) {
      const dir = new URL(`./fixtures/codex-audit-0171/${v}/`, import.meta.url);
      for (const name of readdirSync(dir).filter(n => n.endsWith(".txt"))) {
        const raw = readFileSync(new URL(name, dir), "utf8");
        const visible = stripVTControlCharacters(raw);
        for (const match of visible.matchAll(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/giu)) {
          expect(match[0], `${v}/${name}`).toBe((name.startsWith("rollback-") ? "00000000-0000-7000-8000-000000000171" : `00000000-0000-7000-8000-000000000${v === "01700" ? "170" : "171"}`));
        }
        expect(visible, `${v}/${name}`).not.toMatch(/\/(?:home|Users)\/[^\s/]+|[A-Za-z]:\\Users\\|~\/Projects/);
        expect(visible.replace(/\s/g, ""), `${v}/${name}`).not.toContain("AgEnD-agend-");
        expect(raw, `${v}/${name}`).not.toContain("\u001b]"); // OSC targets need separate redaction before publication.
        checked++;
      }
    }
    expect(checked).toBe(107);
  });

  it("resumes a 0.171-written session with 0.170 (migrations 63-64) and retains positive input proof", () => {
    expect(reading(frame("01700", "rollback-from-01710"))).toMatchObject({ ready: true, busy: false, deliverable: true, redraw: true, resume: false });
  });

  it.each(surfaces)("%s retains the same detector reading", name => {
    expect(reading(frame("01710", name))).toEqual(reading(frame("01700", name)));
  });

  it("has positive idle proof while busy and loading keep their own guards", () => {
    for (const v of versions) {
      expect(reading(frame(v, "idle"))).toMatchObject({ ready: true, busy: false, deliverable: true, redraw: true, resume: false });
      expect(reading(frame(v, "busy")).busy).toBe(true);
      expect(reading(frame(v, "resume-loading"))).toMatchObject({ ready: false, deliverable: false, resume: true });
    }
  });

  it("classifies the captured error frames by AgEnD error type", () => {
    // The scenarios share one session, so a later frame keeps earlier errors in its scrollback (usage's quota line is
    // still visible at e401). Each error frame must add its own type on top of what came before.
    for (const v of versions) {
      expect(reading(frame(v, "idle")).errors).toEqual([]);
      expect(reading(frame(v, "busy")).errors).toEqual([]);
      expect(reading(frame(v, "usage")).errors).toEqual(["quota"]);
      expect(reading(frame(v, "e401")).errors).toEqual(["auth_error", "quota"]);
      expect(reading(frame(v, "model-not-found")).errors).toEqual(["auth_error", "model_error", "quota"]);
    }
  });

  for (const order of ["context-first", "model-first"]) {
    it.each(statusStates)(`${order} %s keeps its readiness ownership`, state => {
      const name = `${order}-${state}`;
      expect(reading(frame("01710", name))).toEqual(reading(frame("01700", name)));
      for (const v of versions) {
        const result = reading(frame(v, name));
        if (state.startsWith("production-") || state === "workspace-production-flag") {
          expect(result).toMatchObject({ ready: true, busy: false, deliverable: true, redraw: true });
        } else {
          // Removing --no-alt-screen is an explicit lab deviation; the unfamiliar owned layout stays held.
          expect(result).toMatchObject({ ready: false, deliverable: false, redraw: false });
          if (state.includes("unfocused") || state.includes("sidebar-only")) expect(result.stable).toBe(false);
        }
      }
    });
  }

  it.each(["signin-menu", "signin-other-selected", "signin-another-way"])("%s never proves delivery or offers automatic sign-in", name => {
    for (const v of versions) {
      const pane = frame(v, name);
      expect(reading(pane)).toMatchObject({ ready: false, deliverable: false, stable: false });
      const automatic = [...backend.getStartupDialogs(), ...backend.getRuntimeDialogs()]
        .filter(d => active(d, pane) && d.keys.length > 0 && !d.holdOnly);
      expect(automatic).toEqual([]);
    }
  });
});

describe("Codex 0.171 precheck strings", () => {
  // The precheck flagged these on detector surfaces. Each already exists in 0.170 (analytics view, rate-limit reset
  // diagnostics, the /statusline item description, the approval overlay) or comes from a library log ("rate limit
  // exceeded; sleeping."). None is an error event, so none may raise an AgEnD error even if it ever reaches a pane.
  it.each([
    "Press R to refresh Analytics.",
    "rate limit exceeded; sleeping.",
    "rate limit reset credit detail request timed out; falling back to the usage response",
    "usage limit (omitted when unavailable)",
    "Yes, and allow these permissions for this session",
  ])("%s matches no error pattern", line => {
    const pane = `› hello\n\n${line}\n\n› Ask Codex to do anything\n`;
    const hits = backend.getErrorPatterns().filter(p => { p.pattern.lastIndex = 0; return p.pattern.test(pane); });
    expect(hits).toEqual([]);
  });
});
