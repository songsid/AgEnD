// Classify captured codex panes with the production CodexBackend predicates. `summary` run-length-encodes each
// directory of frames; otherwise one line per file. The backend reads the context-status-line config AgEnD writes, so
// pass the scratch instance dir of the run as CLASSIFY_INST (else a fresh nonexistent dir: the default layout).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CodexBackend } from "../../../src/backend/codex.js";
const b = new CodexBackend(process.env.CLASSIFY_INST || "/nonexistent-audit");
const ready = b.getReadyPattern(), busy = b.getBusyPattern();
const runtime = b.getRuntimeDialogs(), startup = b.getStartupDialogs(), errors = b.getErrorPatterns();
const transients = b.getInputUnavailableTransients();
const hit = (d: any, pane: string) => { if (d.pattern) d.pattern.lastIndex = 0; return d.isActive ? d.isActive(pane) : d.pattern.test(pane); };
const names = (ds: any[], pane: string) => ds.filter(d => hit(d, pane)).map(d => `${d.description.slice(0, 48)}${d.holdOnly ? "{hold}" : d.keys?.length ? `{${d.keys.join("+")}}` : ""}`);
export function classify(pane: string): string {
  const parts: string[] = [];
  parts.push(ready.test(pane) ? "ready" : "-");
  parts.push(busy.test(pane) ? "BUSY" : "idle");
  if (b.isDeliveryInputReadyPane(pane)) parts.push("deliver-ok");
  if (b.isStableUnknownLayoutIdlePane(pane)) parts.push("stable-idle");
  if (b.isPeriodicRedrawIdlePane(pane)) parts.push("redraw-idle");
  const t = transients.filter(x => x.isActive(pane)).map(x => x.description); if (t.length) parts.push("TRANSIENT[" + t.join("|") + "]");
  const r = names(runtime, pane); if (r.length) parts.push("RT[" + r.join(" | ") + "]");
  const s = names(startup, pane); if (s.length) parts.push("SU[" + s.join(" | ") + "]");
  const e = errors.filter(p => { p.pattern.lastIndex = 0; return p.pattern.test(pane); }).map(p => p.type); if (e.length) parts.push("ERR[" + [...new Set(e)].join("|") + "]");
  return parts.join(" ");
}
function walk(p: string): string[] { return statSync(p).isDirectory() ? readdirSync(p).sort().flatMap(f => walk(join(p, f))) : [p]; }
const mode = process.argv[2];
if (mode === "summary") {
  for (const dir of process.argv.slice(3)) {
    const files = walk(dir); let last = ""; let n = 0; const out: string[] = [];
    for (const f of files) { const c = classify(readFileSync(f, "utf8")); if (c === last) n++; else { if (last) out.push(`${n}× ${last}`); last = c; n = 1; } }
    if (last) out.push(`${n}× ${last}`);
    console.log(dir + ":\n   " + out.join("\n   "));
  }
} else {
  for (const f of process.argv.slice(3).flatMap(walk)) console.log(f.split("/").slice(-2).join("/").padEnd(44), classify(readFileSync(f, "utf8")));
}
