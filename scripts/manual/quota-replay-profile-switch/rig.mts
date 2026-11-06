// Quota-notice replay rig (2026-11-06 spam): a REAL claude conversation carried across a profile switch by the production
// carryClaudeConversation, resumed by the real claude in the new profile (mock API, scratch dirs, nothing leaves the host),
// followed by the production TranscriptMonitor (statusline.json → transcript_path) wired to a production Daemon as the
// daemon wires them. Old usage-limit notes and an old credit error (October) sit in the conversation's history; after
// the switch the resumed turn asks the mock for BILLING → a live 400 billing_error that real claude records.
//   scripts/manual/quota-replay-profile-switch/run.sh [repo] [port]
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const { REPO, CLAUDE_BIN, PORT, R } = process.env as Record<string, string>;
const { TranscriptMonitor } = await import(join(REPO, "src/transcript-monitor.ts"));
const { Daemon } = await import(join(REPO, "src/daemon.ts"));
const { carryClaudeConversation } = await import(join(REPO, "src/backend/claude-carry.ts"));
const pino = (await import(join(REPO, "node_modules/pino/pino.js"))).default;
const logger = pino({ level: "silent" });
for (const d of ["home", "A", "B", "work", "inst", "dd"]) mkdirSync(join(R, d), { recursive: true });
const claude = (config: string, prompt: string, ...args: string[]) => {
  try {
    return execFileSync(CLAUDE_BIN, ["-p", ...args], { cwd: join(R, "work"), input: prompt, encoding: "utf8", timeout: 90_000,
      env: { HOME: join(R, "home"), PATH: "/usr/bin:/bin", TERM: "dumb", CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
        ANTHROPIC_API_KEY: "dummy-key-aaaa", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } }).trim();
  } catch (e: any) { return `(exit ${e.status}) ${String(e.stdout ?? "").trim()} ${String(e.stderr ?? "").trim()}`.slice(0, 300); }
};
const version = execFileSync(CLAUDE_BIN, ["--version"], { encoding: "utf8" }).trim();
console.log(`claude ${version}; repo ${execFileSync("git", ["-C", REPO, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()}${execFileSync("git", ["-C", REPO, "status", "--porcelain", "src"], { encoding: "utf8" }).trim() ? " + working tree" : ""}`);

// 1. Profile A: a real first turn.
console.log("A turn 1:", claude(join(R, "A"), "remember the word PELICAN"));
const key = readdirSync(join(R, "A", "projects"))[0]!;
const sid = readdirSync(join(R, "A", "projects", key)).find(f => f.endsWith(".jsonl"))!.replace(/\.jsonl$/, "");
const fileA = join(R, "A", "projects", key, `${sid}.jsonl`);
// Its October history: Claude's own usage-limit notes (the leader's times) and a credit error, in claude's record shape.
const local = (m: number, d: number, h: number, mi: number) => new Date(2026, m - 1, d, h, mi).toISOString();
const base = { isSidechain: false, userType: "external", entrypoint: "cli", cwd: join(R, "work"), sessionId: sid, version: "2.1.292", gitBranch: "" };
const old: object[] = [];
const noteAt = (when: string, ts: string, again = false) => old.push({ parentUuid: null, ...base, type: "system", subtype: "informational", isMeta: false, level: "notice",
  content: `Usage limit reached${again ? " again" : ""} · continuing automatically ${when} · esc to cancel`, timestamp: ts, uuid: randomUUID() });
noteAt("at 7:10pm", local(10, 7, 18, 43)); for (const mi of [46, 47, 48]) noteAt("at 7:10pm", local(10, 7, 18, mi), true);
noteAt("at 9:20pm", local(10, 8, 20, 42)); noteAt("at 1:40am", local(10, 18, 1, 38)); noteAt("at 10pm", local(10, 21, 21, 44));
noteAt("at 2pm", local(10, 22, 12, 55)); noteAt("at 7pm", local(10, 22, 17, 28));
old.push({ parentUuid: null, ...base, type: "assistant", isApiErrorMessage: true, apiErrorStatus: 400, error: "billing_error", timestamp: local(10, 20, 9, 0), uuid: randomUUID(),
  message: { id: randomUUID(), role: "assistant", model: "<synthetic>", type: "message", content: [{ type: "text", text: "Credit balance is too low" }] } });
appendFileSync(fileA, old.map(e => JSON.stringify(e) + "\n").join(""));
console.log(`A transcript: ${sid}.jsonl + ${old.length} October alarm records (9 usage notes, 1 credit error)`);

// 2. The instance follows A (statusline.json → transcript_path), monitor + daemon wired as Daemon wires them.
const inst = join(R, "inst");
const statusline = (p: string) => writeFileSync(join(inst, "statusline.json"), JSON.stringify({ transcript_path: p }));
statusline(fileA);
const daemon = new Daemon("rig", { working_directory: join(R, "work"), log_level: "silent" } as any, join(R, "dd"), false, undefined, undefined, logger) as any;
const monitor = new TranscriptMonitor(inst, logger) as any;
monitor.on("api_error", (text: string, status: number | null, _at: number | null, kind: string | null) => daemon.noteClaudeApiError(text, status, kind));
monitor.on("system_informational", (text: string, at: number | null) => daemon.noteClaudeInformational(text, at));
const notices: string[] = [];
daemon.on("pty_error", (e: any) => notices.push(`${e.type}/${e.action}: ${e.message}`));
const poll = async (n = 3) => { for (let i = 0; i < n; i++) await monitor.pollIncrement(); };
await poll();
console.log(`following A: ${notices.length} notices`);

// 3. The switch: the production carry A → B, then the real claude resumes it in B (and hits the live billing error).
console.log("carry:", JSON.stringify(await carryClaudeConversation({ sessionId: sid, workingDirectory: join(R, "work"), fromConfigDir: join(R, "A"), toConfigDir: join(R, "B") })));
const fileB = join(R, "B", "projects", key, `${sid}.jsonl`);
console.log("B turn (--continue):", claude(join(R, "B"), "which word did I ask you to remember?", "--continue"));
statusline(fileB);                                       // the resumed claude's statusline names the new profile's file
await poll();
const afterSwitch = notices.length;
console.log(`after the switch (resumed, replacement read from the top): ${afterSwitch} notices`);
for (const n of notices) console.log("  ", n);
console.log("B turn (live BILLING):", claude(join(R, "B"), "BILLING now", "--continue"));
await poll();
console.log(`after a live billing error: ${notices.length - afterSwitch} new notice(s)`);
for (const n of notices.slice(afterSwitch)) console.log("  ", n);
const recs = (await import("node:fs")).readFileSync(fileB, "utf8").trim().split("\n").map(l => JSON.parse(l));
console.log(`B transcript: ${recs.length} records; same session id: ${recs.every(r => !r.sessionId || r.sessionId === sid)}; live api errors: ${recs.filter(r => r.isApiErrorMessage && Date.parse(r.timestamp) > Date.now() - 600_000).map(r => `${r.apiErrorStatus}/${r.error}`).join(",")}`);
console.log(`RESULT replayed_notices=${afterSwitch} live_notices=${notices.length - afterSwitch}`);
monitor.stop?.();
process.exit(0);
