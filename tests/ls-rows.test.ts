import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectLsRows, type LsRowEnv, type LsRowInput } from "../src/ls-rows.js";

/**
 * #997: `agend ls` did one blocking 2s-timeout tmux capture per instance,
 * serially (N instances ≈ N×2s). Rows are now collected concurrently with a
 * per-row backstop, calling the real collector (not a reimplementation).
 */

function input(name: string, backend = "codex"): LsRowInput {
  return { name, isClassic: false, status: "running", teams: [], backend, source: "DC" };
}

function envWith(
  capturePane: (target: string) => Promise<string>,
  dataDir: string,
  rowTimeoutMs = 5_000,
): LsRowEnv {
  return { dataDir, pidByName: new Map(), capturePane, rowTimeoutMs };
}

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe("collectLsRows concurrency", () => {
  it("overlaps slow captures instead of stacking them serially", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-ls-rows-"));
    try {
      const env = envWith(async () => { await delay(300); return "8% ❯"; }, dir);
      const names = ["a", "b", "c", "d"];

      const started = Date.now();
      const rows = await collectLsRows(names.map(n => input(n)), env);
      const elapsed = Date.now() - started;

      expect(rows.map(r => r.name).sort()).toEqual(names);
      for (const row of rows) expect(row.context).toBe(8);
      // Serial would cost ≥1200ms; concurrent costs ~one capture.
      expect(elapsed, `four 300ms captures must overlap, not stack (was ${elapsed}ms)`).toBeLessThan(900);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failing or hung pane degrades its own row without stalling the list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-ls-rows-"));
    try {
      const env = envWith(target => {
        if (target === "ok") return Promise.resolve("8% ❯");
        if (target === "bad") return Promise.reject(new Error("no such pane"));
        return new Promise<string>(() => { /* hung pane never settles */ });
      }, dir, 200);

      const started = Date.now();
      const rows = await collectLsRows([input("ok"), input("bad"), input("hung")], env);
      const elapsed = Date.now() - started;

      expect(rows).toHaveLength(3);
      expect(rows.find(r => r.name === "ok")?.context).toBe(8);
      expect(rows.find(r => r.name === "bad")?.context).toBeNull();
      expect(rows.find(r => r.name === "hung")?.context).toBeNull();
      expect(elapsed, `a hung pane must hit the row backstop, not the list (was ${elapsed}ms)`).toBeLessThan(2_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads claude-code context from statusline.json without capturing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-ls-rows-"));
    try {
      const instDir = join(dir, "instances", "w");
      mkdirSync(instDir, { recursive: true });
      writeFileSync(join(instDir, "statusline.json"), JSON.stringify({ context_window: { used_percentage: 42 } }));
      let captured = 0;
      const env = envWith(async () => { captured++; return "8% ❯"; }, dir);

      const [row] = await collectLsRows([input("w", "claude-code")], env);

      expect(row.context).toBe(42);
      expect(captured, "statusline hit must skip the pane capture").toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
