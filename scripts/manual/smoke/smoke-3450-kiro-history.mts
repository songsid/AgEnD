/** #3450: synthetic classic/TUI stores only, no CLI, daemon, account or vendor endpoint.
 * Run from the checkout: OUT=.artifacts/kiro-3450/rig npx tsx scripts/manual/smoke/smoke-3450-kiro-history.mts
 * Exercises the production worker and automatic CacheService path. Scratch is removed; JSON evidence remains.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { CacheService } from "../../../src/cache-service.js";
import { buildUsageReport } from "../../../src/usage-report.js";

const out = resolve(process.env.OUT ?? ".artifacts/kiro-3450/rig"); mkdirSync(out, { recursive: true });
const root = mkdtempSync(join(out, "scratch-")), home = join(root, "kiro"), cwd = join(root, "work"), own = join(root, "instance");
const DAY = 86_400_000, now = Date.UTC(2026, 10, 8, 12), dbPath = join(root, "kiro.sqlite3");
let service: CacheService | null = null, heartbeat = 0;
const timer = setInterval(() => { heartbeat++; }, 5);
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
try {
  mkdirSync(cwd); mkdirSync(own); mkdirSync(join(home, "sessions", "cli"), { recursive: true });
  const db = new Database(dbPath);
  db.exec("CREATE TABLE conversations_v2 (key TEXT, conversation_id TEXT, value TEXT, created_at INTEGER, updated_at INTEGER, PRIMARY KEY(key,conversation_id))");
  for (let c = 0; c < 100; c++) {
    const history = Array.from({ length: 50 }, (_, n) => ({ user: { content: { Prompt: { prompt: "abcd" } } },
      request_metadata: { request_start_timestamp_ms: now - (40 + n) * DAY, response_size: 8, context_usage_percentage: 1, model_id: "claude-sonnet-4.6" } }));
    db.prepare("INSERT INTO conversations_v2 VALUES (?,?,?,?,?)").run(cwd, `c${String(c).padStart(3, "0")}`,
      JSON.stringify({ history, model_info: { context_window_tokens: 200_000 } }), now - 90 * DAY, now);
  }
  for (let n = 0; n < 20; n++) {
    const start = now - (45 + n) * DAY, path = join(home, "sessions", "cli", `t${n}.json`);
    writeFileSync(path, JSON.stringify({ cwd, session_id: `t${n}`, session_state: { rts_model_state: { model_info: { model_id: "claude-sonnet-4.6" } },
      conversation_metadata: { user_turn_metadatas: [{ message_ids: ["a"], user_prompt_length: 4, assistant_response_length: 8,
        context_usage_percentage: 1, end_timestamp: new Date(start + 1000).toISOString(), turn_duration: { secs: 1, nanos: 0 } }] } } }));
    writeFileSync(path.replace(/json$/, "jsonl"), [
      { kind: "Prompt", data: { message_id: "p", content: [{ kind: "text", data: "abcd" }], meta: { timestamp: start / 1000 } } },
      { kind: "AssistantMessage", data: { message_id: "a", content: [{ kind: "text", data: "abcdefgh" }] } },
    ].map(x => JSON.stringify(x)).join("\n"));
  }
  db.close(); const before = hash(dbPath);
  const make = () => new CacheService({
    instances: () => [{ name: "kiro", backend: "kiro-cli", workingDirectory: cwd, ledgerPath: join(own, "cache-ledger.json"), profile: "synthetic" }],
    claudeProjectsDir: () => join(root, "claude"), claudeKey: x => x, codexSessionsDir: () => join(root, "codex"),
    listRollouts: () => [], metaPath: join(root, "meta.json"), now: () => now, zone: () => "UTC", pauseMs: 5,
    kiroDbPath: () => dbPath, kiroHome: () => home,
    log: (level, message, detail) => { if (level === "warn") throw new Error(`${message}: ${JSON.stringify(detail)}`); },
  });
  service = make(); await service.kick();
  const levels = await service.officeLevels(now), data = (await service.usageData()).instances[0]!;
  const expected = 5020 * 2002;
  assert.equal(levels.kiro!.workTokens, expected); assert.equal(levels.kiro!.estimated, true);
  assert.equal(levels.kiro!.firstSeen, "2026-08-11");
  const report = buildUsageReport({ now, zone: "UTC", range: { kind: "custom", from: "2026-08-01", to: "2026-10-01" },
    group: "instance", scanning: service.scanning(), messages: [],
    instances: [{ name: "kiro", backend: "kiro-cli", team: null, status: "ok", ledger: data.ledger, days: data.days }] });
  assert.equal(report.rows[0]!.requests, 5020); assert.equal(report.rows[0]!.estimated, true);
  assert.equal(report.rows[0]!.input, 5020); assert.equal(report.rows[0]!.cacheRead, 5020 * 1999);
  assert.ok(heartbeat > 0); // the main event loop ran while workers did the historical reads/parsing
  await service.stop(); service = make(); await service.kick();
  assert.deepEqual(await service.officeLevels(now), levels); assert.equal(hash(dbPath), before);
  const marker = JSON.parse(readFileSync(join(own, "kiro-history-v1.json"), "utf8")); assert.equal(marker.phase, "done");
  const result = { scope: "synthetic classic/TUI; production worker; no real CLI/store/fleet", requests: 5020,
    expectedWorkTokens: expected, level: levels.kiro, mainLoopHeartbeats: heartbeat, restartIdempotent: true,
    storeSha256Before: before, storeSha256After: hash(dbPath), marker: marker.phase, scratchRemoved: true };
  writeFileSync(join(out, "results.json"), JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
} finally { clearInterval(timer); await service?.stop(); rmSync(root, { recursive: true, force: true }); }
