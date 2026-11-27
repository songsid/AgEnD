/**
 * #4506: Antigravity's quota backstop used to be /RESOURCE_EXHAUSTED|quota/i.
 * The monitor reports the first new pattern and breaks, and the account-cap
 * pattern does not rebase its siblings (skipRecoveryWait). Five seconds later
 * the same pane still contained "quota", so the backstop emitted a second
 * "Quota exhausted". Chat such as "prior to quota exhaustion" matched too.
 *
 * The backstop is the CLI error code only. These scans use the real patterns
 * and Daemon.evaluateErrorPatterns, five seconds apart, the monitor's interval.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityBackend } from "../src/backend/antigravity.js";
import { Daemon } from "../src/daemon.js";

const CAP_4H = "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h46m38s.";
const CAP_139H = "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 139h12m12s.";
const CHAT_PRIOR = "The image was successfully generated prior to quota exhaustion.";
const CHAT_QUESTION = "how do I handle quota exceeded?";

const backend = new AntigravityBackend("/tmp");
const patterns = backend.getErrorPatterns();
const ready = backend.getReadyPattern();
const dirs: string[] = [];

afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function monitor() {
  const dir = mkdtempSync(join(tmpdir(), "agend-4506-"));
  dirs.push(dir);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("agy-4506", {
    working_directory: dir,
    backend: "antigravity",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
  } as any, dir, false, backend, undefined, { child: () => logger } as any) as any;
  const errors: Array<{ type: string; message: string }> = [];
  daemon.on("pty_error", (error: { type: string; message: string }) => errors.push({ type: error.type, message: error.message }));
  let now = 10 * 60_000;
  const scan = (pane: string, advanceMs = 5_000) => {
    now += advanceMs;
    daemon.evaluateErrorPatterns(pane, patterns, ready, now, null);
  };
  return { errors, scan };
}

function quotaHits(pane: string): string[] {
  return patterns.filter(p => p.type === "quota" && p.pattern.test(pane)).map(p => p.message);
}

describe("#4506 chat text is not a quota error", () => {
  it("an agent step that mentions quota exhaustion matches nothing", () => {
    expect(quotaHits(CHAT_PRIOR)).toEqual([]);
    const { errors, scan } = monitor();
    scan(CHAT_PRIOR);
    scan(CHAT_PRIOR);
    expect(errors).toEqual([]);
  });

  it("a question about quota exceeded matches nothing", () => {
    expect(quotaHits(CHAT_QUESTION)).toEqual([]);
    const { errors, scan } = monitor();
    scan(`> ${CHAT_QUESTION}`);
    scan(`> ${CHAT_QUESTION}`);
    expect(errors).toEqual([]);
  });
});

describe("#4506 a real account cap is reported once", () => {
  it.each([CAP_4H, CAP_139H])("reports %s on the first scan only", (line) => {
    expect(quotaHits(line)).toEqual(["Antigravity quota reached"]);
    const { errors, scan } = monitor();
    const pane = `${CHAT_PRIOR}\n${line}\n> `;
    scan(pane);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.type).toBe("quota");
    expect(errors[0]!.message).toContain("Individual quota reached");
    expect(errors[0]!.message).toContain("Resets in");
    expect(errors[0]!.message).not.toContain("Quota exhausted");
    scan(pane);
    expect(errors).toHaveLength(1);
  });

  it("reports an organization cap once, with its reset", () => {
    const line = "Organization quota reached. Resets in 2h15m.";
    const { errors, scan } = monitor();
    scan(line);
    scan(line);
    expect(errors.map(e => e.message)).toEqual([line]);
  });
});

describe("#4506 RESOURCE_EXHAUSTED still notifies once", () => {
  it("matches the error code and not a second time five seconds later", () => {
    const pane = "Error: RESOURCE_EXHAUSTED\n> ";
    expect(quotaHits(pane)).toEqual(["Quota exhausted"]);
    const { errors, scan } = monitor();
    scan(pane);
    scan(pane);
    expect(errors.map(e => e.message)).toEqual(["Quota exhausted"]);
  });
});
