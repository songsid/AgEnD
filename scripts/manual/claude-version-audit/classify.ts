// Classify captured panes with the production ClaudeCodeBackend predicates.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeBackend, claudeBackgroundWorkExitActive } from "../../../src/backend/claude-code.js";
const b = new ClaudeCodeBackend("/nonexistent-audit");
const ready = b.getReadyPattern(), busy = b.getBusyPattern();
const runtime = b.getRuntimeDialogs(), startup = b.getStartupDialogs(), errors = b.getErrorPatterns();
const dialogHit = (ds: any[], pane: string) => ds.filter(d => d.isActive ? d.isActive(pane) : d.pattern.test(pane)).map(d => d.description.slice(0, 60));
export function classify(pane: string): string {
  const parts: string[] = [];
  parts.push(ready.test(pane) ? "ready" : "-");
  parts.push(busy.test(pane) ? "BUSY" : "idle");
  const r = dialogHit(runtime, pane); if (r.length) parts.push("RT[" + r.join(" | ") + "]");
  const s = dialogHit(startup, pane); if (s.length) parts.push("SU[" + s.join(" | ") + "]");
  const e = errors.filter(p => p.pattern.test(pane)).map(p => p.type + ":" + p.message.slice(0, 40)); if (e.length) parts.push("ERR[" + e.join(" | ") + "]");
  if (b.resumeMissingPattern().test(pane)) parts.push("RESUME-MISSING");
  if (b.quitBlockedByDialog(pane)) parts.push("QUIT-BLOCKED");
  return parts.join(" ");
}
function walk(p: string): string[] { return statSync(p).isDirectory() ? readdirSync(p).sort().flatMap(f => walk(join(p, f))) : [p]; }
const mode = process.argv[2];
if (mode === "summary") {
  // per directory: run-length of classifications
  for (const dir of process.argv.slice(3)) {
    const files = walk(dir); let last = ""; let n = 0; const out: string[] = [];
    for (const f of files) { const c = classify(readFileSync(f, "utf8")); if (c === last) n++; else { if (last) out.push(`${n}× ${last}`); last = c; n = 1; } }
    if (last) out.push(`${n}× ${last}`);
    console.log(dir.split("/cap/")[1] + ":\n   " + out.join("\n   "));
  }
} else {
  for (const f of process.argv.slice(3).flatMap(walk)) console.log((f.split("/cap/")[1] ?? f.split("/").pop()!).padEnd(34), classify(readFileSync(f, "utf8")));
}
