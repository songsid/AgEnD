/** #1235: fixture-only 23-instance / 6-tick minute. Run after npm run build.
 * The old 8cc5a858 scrape's boundary executes our private printf-only fake tmux.
 * The new boundary uses a connected inert control transport through the real lane/manager.
 * No tmux server, fleet, backend CLI, account or user store is opened.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { setImmediate as yieldTurn } from "node:timers/promises";

const require = createRequire(import.meta.url);
const guard = require("../tests/support/process-guard.cjs").install();
const nativeExec = require("node:child_process").execFile;
const { PaneContextCache } = await import("../dist/pane-context-cache.js");
const { TmuxReadLane, tmuxReadArgs } = await import("../dist/tmux-read.js");
const { TmuxManager } = await import("../dist/tmux-manager.js");
const { parseContextPercent, parseTokenContextRatio } = await import("../dist/context-percent.js");
const root = mkdtempSync(join(tmpdir(), "agend-pane-context-bench-"));
const fake = join(root, "tmux"), socket = "agend-test-context-benchmark";
writeFileSync(fake, "#!/bin/sh\nprintf 'Context 33%% left\\n'\n"); chmodSync(fake, 0o700);
const env = { HOME: root, AGEND_HOME: root, PATH: "/usr/bin:/bin", LANG: "C" };
let spawns = 0, turnCost = 0, longestNativeBurst = 0, resetQueued = false;
const boundary = (file, args, options, callback) => {
  assert.equal(file, "tmux"); assert.equal(args[0], "-L"); assert.equal(args[1], socket);
  if (!resetQueued) {
    resetQueued = true;
    setImmediate(() => { turnCost = 0; resetQueued = false; });
  }
  const start = performance.now(); spawns++;
  const child = nativeExec(fake, args, { ...options, env }, callback);
  turnCost += performance.now() - start; longestNativeBurst = Math.max(longestNativeBurst, turnCost);
  return child;
};
boundary[promisify.custom] = (...args) => new Promise((resolve, reject) => boundary(...args,
  (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));

// Same arguments, parser and error policy as scrapePaneContextAsync at 8cc5a858;
// only the executable/environment boundary is replaced with the private inert fixture.
async function before(instanceName, backend) {
  try {
    const tmuxArgs = ["-L", socket, "capture-pane", "-t", `context-fixture:${instanceName}`, "-p", "-S", "-60"];
    const { stdout } = await promisify(boundary)("tmux", tmuxArgs, { encoding: "utf-8", timeout: 2000 });
    const pane = stdout.toString();
    const tokenRatio = backend === "grok" ? parseTokenContextRatio(pane) : null;
    return { context: tokenRatio?.percentage ?? parseContextPercent(pane), tokenRatio };
  } catch { return { context: null, tokenRatio: null }; }
}

async function measure(action) {
  await yieldTurn(); let beats = 0, previous = performance.now(), maxGapMs = 0;
  const timer = setInterval(() => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - previous); previous = now; beats++; }, 1);
  spawns = 0; turnCost = 0; longestNativeBurst = 0;
  const start = performance.now();
  try { await action(); }
  finally { maxGapMs = Math.max(maxGapMs, performance.now() - previous); clearInterval(timer); }
  return { ms: performance.now() - start, spawnsPerModeledMinute: spawns, longestNativeInvocationBurstMs: longestNativeBurst, maxHeartbeatGapMs: maxGapMs, beats };
}

const results = { fixture: { instances: 23, ticks: 6, virtualPeriodMs: 10_000, paneLines: 60 }, before: [], after: [] };
try {
  for (let repeat = 0; repeat < 3; repeat++) results.before.push(await measure(async () => {
    for (let tick = 0; tick < 6; tick++) {
      const values = await Promise.all(Array.from({ length: 23 }, (_, i) => before(`@${i + 1}`, "codex")));
      assert.ok(values.every(value => value.context === 67)); await yieldTurn();
    }
  }));
  TmuxManager.setSocketName(socket);
  for (let repeat = 0; repeat < 3; repeat++) {
    let clock = 0, reads = 0;
    const cache = new PaneContextCache(() => clock);
    const lane = new TmuxReadLane(socket, { ready: () => true,
      execute: async () => { reads++; return "Context 33% left\n"; }, retire: () => {} });
    const port = { isFor: (session, name) => session === "context-fixture" && name === socket,
      read: (query, budget) => lane.read(tmuxReadArgs(query), budget) };
    const owners = Array.from({ length: 23 }, (_, i) => {
      const manager = new TmuxManager("context-fixture", `@${i + 1}`, undefined, port);
      return { owner: manager, generation: "fixture", isCurrent: () => true, capture: () => manager.capturePaneWithHistory(60, 2_000) };
    });
    try {
      const result = await measure(async () => {
        for (let tick = 0; tick < 6; tick++) {
          clock = tick * 10_000;
          for (let i = 0; i < 23; i++) cache.resolve(root, String(i), "codex", owners[i]);
          // Flush the real lane's sequential promise pipeline without advancing virtual TTL.
          await yieldTurn();
          for (let i = 0; i < 23; i++) assert.equal(cache.resolve(root, String(i), "codex", owners[i]).context, 67);
        }
      });
      assert.equal(reads, 138); assert.equal(result.spawnsPerModeledMinute, 0);
      results.after.push({ ...result, controlReadsPerModeledMinute: reads });
    } finally { lane.stop(); }
  }
  assert.ok(results.before.every(value => value.spawnsPerModeledMinute === 138));
  assert.deepEqual(guard.takeViolations(), []);
  results.note = "Native execFile of a printf-only fake tmux versus an inert already-connected transport. A virtual 60s workload, not a new live profile or production latency guarantee. Native-invocation burst sums synchronous call costs in one event-loop turn; heartbeat gap also includes scheduling/IO. Disconnected control still has the existing bounded fallback.";
  console.log(JSON.stringify(results, null, 2));
} finally { TmuxManager.setSocketName(null); rmSync(root, { recursive: true, force: true }); }
