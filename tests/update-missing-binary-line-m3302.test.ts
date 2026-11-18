/**
 * M-3302 (#4146): the restart/update completion says WHY failed instances did not come back when their AI CLI is not
 * installed. Before, it said "⚠️ Failed (11): …" and nothing else. Now there is one line per missing binary, naming it, its
 * instances and the install command, and saying they start by themselves once it is back (#4149's hold). The line comes
 * from FleetManager.missingBinarySummary, built from the same holds Needs you shows.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatRestartProgressCompletion } from "../src/restart-progress.js";
import { FleetManager } from "../src/fleet-manager.js";
import { BACKEND_INSTALLATION_INFO } from "../src/instance-lifecycle.js";
import { setLocale, t } from "../src/locale.js";

const dirs: string[] = [];
afterEach(() => { setLocale("en"); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const INSTALL = BACKEND_INSTALLATION_INFO["claude-code"]!.install;

describe("M-3302: the completion names a missing AI CLI", () => {
  it("update mode: the failed line, then one line per missing binary with its instances and install command", () => {
    const text = formatRestartProgressCompletion("update", {
      running: 1, total: 3, version: "2.4.0", pausedNames: [], failedNames: ["a", "b"],
      missingBinaries: [{ binary: "claude", fix: INSTALL, names: ["a", "b"] }],
    }, Date.now() - 5_000);
    const lines = text.split("\n");
    expect(lines[1]).toBe("⚠️ Failed (2): a, b");
    expect(lines[2]).toBe(t("restart.progress.missing_binary", "claude", 2, "a, b", INSTALL));
    expect(lines[2]).toContain("`claude` is not installed");
  });

  it("control: no missing binaries — the completion is exactly as before", () => {
    const base = { running: 1, total: 2, version: "2.4.0", pausedNames: [], failedNames: ["a"] };
    expect(formatRestartProgressCompletion("restart", { ...base, missingBinaries: [] }, 0, 1_000)).toBe(formatRestartProgressCompletion("restart", base, 0, 1_000));
  });

  it("missingBinarySummary groups the failed instances by their held binary; others are left out", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-3302-sum-")); dirs.push(dir);
    const fm = new FleetManager(dir) as any;
    fm.missingBinaryHolds.set("a", { backend: "claude-code", binary: "claude", since: 1 });
    fm.missingBinaryHolds.set("b", { backend: "claude-code", binary: "claude", since: 2 });
    expect(fm.missingBinarySummary(["a", "b", "c"])).toEqual({ missingBinaries: [{ binary: "claude", fix: INSTALL, names: ["a", "b"] }] });
    expect(fm.missingBinarySummary(["c"])).toEqual({});
  });

  it("zh-TW", () => {
    setLocale("zh-TW");
    expect(t("restart.progress.missing_binary", "claude", 2, "a, b", INSTALL)).toContain("找不到 `claude`");
  });
});
