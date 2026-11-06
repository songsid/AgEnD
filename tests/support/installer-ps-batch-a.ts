/**
 * Batch helpers for the Windows installer tests (#3110 / #3117 / #3128 family). Test-only.
 *
 * - `sliceFunctions` / `sliceAssignments`: only what the cases call, sliced out of install-agend.ps1 as text. The
 *   function set is the closure of the roots over names the installer's own function bodies call. No Parser::ParseFile,
 *   no AST walk, no whole-file dotsource.
 * - `runPwshBatch`: every case of a file in ONE pwsh process. Each case is a scriptblock run through `Invoke-Case`, so
 *   the stubs a case defines are seen only by that case. Its stdout sits between `AGEND_BEGIN <name>` and a one-line JSON
 *   `AGEND_CASE` record (error, and the stubs' recorded calls), so a child process that writes straight to the console
 *   still lands in its own case.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractPsFunction } from "./installer-ps-extract.js";

export interface CaseRecord {
  case: string;
  error: string | null;
  opened: string[];
  clipped: string[];
  started: string[];
}
export interface CaseResult {
  out: string;
  record: CaseRecord;
}

/** A PowerShell single-quoted literal. */
export function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Each case runs in its own scope; its stdout and its JSON record are delimited for the Node side. */
export const CASE_RUNNER = `function Invoke-Case([string]$name, [scriptblock]$body) {
  $script:Opened = @(); $script:Clipped = @(); $script:Started = @()
  $err = $null
  Write-Output ('AGEND_BEGIN ' + $name)
  try { & $body } catch { $err = [string]$_ }
  $record = [ordered]@{ case = $name; error = $err; opened = @($script:Opened); clipped = @($script:Clipped); started = @($script:Started) }
  Write-Output ('AGEND_CASE ' + (ConvertTo-Json -InputObject $record -Compress))
}`;

/**
 * The functions named by `roots`, and the functions their bodies call by name (transitively), exactly as written in
 * `src`. A name defined twice takes its last definition, as dotsourcing the whole file would.
 */
export function sliceFunctions(src: string, roots: readonly string[]): string {
  const text = src.replace(/^﻿/, "");
  const last = new Map<string, { name: string; at: number }>();
  for (const m of text.matchAll(/\bfunction ([A-Za-z][\w-]*)\s*[({]/g)) {
    last.set(m[1]!.toLowerCase(), { name: m[1]!, at: m.index! });
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const key = queue.shift()!.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const def = last.get(key);
    if (!def) throw new Error(`installer defines no function ${key}`);
    const body = extractPsFunction(text.slice(def.at), def.name);
    out.push(body);
    for (const m of body.matchAll(/(?<![\w$.:-])([A-Za-z]\w*(?:-[A-Za-z]\w*)+)/g)) {
      const callee = m[1]!.toLowerCase();
      if (last.has(callee) && !seen.has(callee)) queue.push(last.get(callee)!.name);
    }
  }
  return out.join("\n");
}

/** Top-level `$NAME = ...` assignments: a single-quoted, double-quoted or here-string value, or one line. */
export function sliceAssignments(src: string, names: readonly string[]): string {
  const text = src.replace(/^﻿/, "");
  return names
    .map(name => {
      const m = new RegExp(`^\\$${name} *=`, "m").exec(text);
      if (!m) throw new Error(`installer has no top-level $${name}`);
      return sliceValue(text, m.index);
    })
    .join("\n");
}

function sliceValue(text: string, start: number): string {
  let i = text.indexOf("=", start) + 1;
  while (text[i] === " " || text[i] === "\t") i += 1;
  if (text.startsWith("@'", i) || text.startsWith('@"', i)) {
    const term = `\n${text[i + 1]}@`;
    const end = text.indexOf(term, i + 2);
    if (end < 0) throw new Error("unclosed here-string");
    return text.slice(start, end + term.length);
  }
  if (text[i] === "'" || text[i] === '"') return text.slice(start, skipQuoted(text, i));
  const nl = text.indexOf("\n", i);
  return text.slice(start, nl < 0 ? text.length : nl);
}

function skipQuoted(text: string, i: number): number {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j += 1) {
    if (quote === '"' && text[j] === "`") { j += 1; continue; }
    if (text[j] !== quote) continue;
    if (quote === "'" && text[j + 1] === "'") { j += 1; continue; }
    return j + 1;
  }
  throw new Error("unclosed string");
}

/** Runs one pwsh for the whole batch and returns each case's output and record, by name. */
export function runPwshBatch(dir: string, script: string, opts: { input?: string; env?: Record<string, string>; timeout?: number } = {}): Map<string, CaseResult> {
  const file = join(dir, "batch.ps1");
  writeFileSync(file, script);
  const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", file], {
    encoding: "utf8",
    timeout: opts.timeout ?? 10_000,
    input: opts.input ?? "",
    env: { ...process.env, TMPDIR: dir, ...opts.env },
  });
  if (r.error || r.signal || r.status !== 0) throw new Error(`pwsh batch ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  return parseCases(r.stdout);
}

export function parseCases(stdout: string): Map<string, CaseResult> {
  const cases = new Map<string, CaseResult>();
  for (const m of stdout.matchAll(/AGEND_BEGIN (\S+)\r?\n([\s\S]*?)AGEND_CASE (\{.*\})\r?\n/g)) {
    cases.set(m[1]!, { out: m[2]!, record: JSON.parse(m[3]!) as CaseRecord });
  }
  return cases;
}

/** One case's result; a case that threw in pwsh fails here with its message. */
export function caseOf(cases: Map<string, CaseResult>, name: string): CaseResult {
  const c = cases.get(name);
  if (!c) throw new Error(`pwsh batch printed no case ${name}`);
  if (c.record.error) throw new Error(`case ${name} threw: ${c.record.error}\n${c.out}`);
  return c;
}
