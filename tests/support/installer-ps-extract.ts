/** Slice installer PowerShell in Node so tests never Parser::ParseFile the whole AST. */

const PRELUDE_ASSIGNMENTS = [
  "WSL_COMMAND_FN",
  "RESTART_FN",
  "ALL_BACKENDS",
  "BACKEND_PROBE",
  "BACKEND_PATH",
  "UNATTENDED_INSTALL",
] as const;

const DOWNLOAD_CLOCK_INIT = "$clock = [Diagnostics.Stopwatch]::StartNew()";

function isLineStart(src: string, i: number): boolean {
  return i === 0 || src[i - 1] === "\n";
}

function skipHereString(src: string, i: number): number {
  const quote = src[i + 1];
  if (quote !== "'" && quote !== '"') throw new Error("not a here-string");
  const term = `\n${quote}@`;
  const end = src.indexOf(term, i + 2);
  if (end < 0) throw new Error("unclosed here-string");
  return end + term.length;
}

function skipQuoted(src: string, i: number): number {
  const quote = src[i];
  i += 1;
  while (i < src.length) {
    if (quote === '"' && src[i] === "`") {
      i += 2;
      continue;
    }
    if (quote === "'" && src[i] === "'" && src[i + 1] === "'") {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i += 1;
  }
  throw new Error("unclosed string");
}

/** Body of `function Name ... { ... }`, skipping strings and here-strings. */
export function extractPsFunction(src: string, name: string): string {
  const token = `function ${name}`;
  let from = 0;
  while (from < src.length) {
    const start = src.indexOf(token, from);
    if (start < 0) throw new Error(`missing function ${name}`);
    const after = start + token.length;
    if (after < src.length && /[A-Za-z0-9_-]/.test(src[after]!)) {
      from = after;
      continue;
    }
    return sliceBalanced(src, start, "{", "}");
  }
  throw new Error(`missing function ${name}`);
}

function sliceBalanced(src: string, start: number, open: string, close: string): string {
  let i = src.indexOf(open, start);
  if (i < 0) throw new Error(`no ${open} after ${src.slice(start, start + 40)}`);
  let depth = 0;
  while (i < src.length) {
    if (src.startsWith("<#", i)) {
      const end = src.indexOf("#>", i + 2);
      if (end < 0) throw new Error("unclosed block comment");
      i = end + 2;
      continue;
    }
    if (src[i] === "#" && (i === 0 || !/[A-Za-z0-9_$]/.test(src[i - 1]!))) {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (src.startsWith("@'", i) || src.startsWith('@"', i)) {
      i = skipHereString(src, i);
      continue;
    }
    const c = src[i]!;
    if (c === "'" || c === '"') {
      i = skipQuoted(src, i);
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
    i += 1;
  }
  throw new Error("unbalanced");
}

function sliceAssignment(src: string, start: number): string {
  let i = src.indexOf("=", start) + 1;
  while (src[i] === " " || src[i] === "\t") i += 1;
  if (src.startsWith("@'", i) || src.startsWith('@"', i)) return src.slice(start, skipHereString(src, i));
  if (src[i] === "'" || src[i] === '"') return src.slice(start, skipQuoted(src, i));
  if (src.startsWith("@{", i)) return sliceBalanced(src, start, "{", "}");
  if (src.startsWith("@(", i)) return sliceBalanced(src, start, "(", ")");
  const literal = src.slice(i).match(/^(?:\[[A-Za-z0-9_.]+\])?(?:'[^'\n]*'|[0-9]+(?:MB|GB)?|\$true|\$false)(?=\s*(?:\n|$))/);
  if (literal) return src.slice(start, i + literal[0].length);
  throw new Error(`unsupported assignment at ${src.slice(start, start + 40)}`);
}

/**
 * Top-level functions plus the installer assignments the recovery tests dotsource.
 * Functions inside here-strings arrive by dotsourcing $WSL_COMMAND_FN / $RESTART_FN.
 */
export function extractInstallerPrelude(src: string): string {
  const text = src.replace(/^\uFEFF/, "");
  const chunks: string[] = [];
  const found = new Set<string>();
  let i = 0;
  while (i < text.length) {
    if (isLineStart(text, i) && text.startsWith("function ", i)) {
      const sliced = sliceBalanced(text, i, "{", "}");
      chunks.push(sliced);
      i += sliced.length;
      continue;
    }
    if (isLineStart(text, i)) {
      let matched = false;
      for (const name of PRELUDE_ASSIGNMENTS) {
        const prefix = `$${name} =`;
        if (text.startsWith(prefix, i)) {
          const sliced = sliceAssignment(text, i);
          chunks.push(sliced);
          found.add(name);
          i += sliced.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }
    if (text.startsWith("@'", i) || text.startsWith('@"', i)) {
      i = skipHereString(text, i);
      continue;
    }
    i += 1;
  }
  for (const name of PRELUDE_ASSIGNMENTS) {
    if (!found.has(name)) throw new Error(`prelude missing $${name}`);
  }
  chunks.push(". ([scriptblock]::Create($WSL_COMMAND_FN))");
  chunks.push(". ([scriptblock]::Create($RESTART_FN))");
  return chunks.join("\n");
}

/** Download helpers with an injected elapsed clock. Production Stopwatch stays in install-agend.ps1. */
export function extractDownloadHelpers(src: string): { production: string; injected: string } {
  const production = src.slice(
    src.indexOf("function New-InstallDownloadRequest"),
    src.indexOf("\n}\n", src.indexOf("function Invoke-InstallDownload(")) + 3,
  );
  if (!production.includes(DOWNLOAD_CLOCK_INIT)) throw new Error("download clock init missing");
  if (!production.includes("$operation.Wait([int][Math]::Max(1, $left * 1000))")) {
    throw new Error("download Wait call missing");
  }
  const injected = production.replace(
    DOWNLOAD_CLOCK_INIT,
    "$clock = @{ Elapsed = @{ TotalSeconds = [double]$script:DownloadElapsed } }",
  );
  return { production, injected };
}

/** `if (...) { ... } else { ... }` starting at `marker`, strings and here-strings skipped. */
export function extractLeadingStatement(src: string, marker: string): string {
  const text = src.replace(/^\uFEFF/, "");
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`missing ${marker}`);
  const ifBlock = sliceBalanced(text, start, "{", "}");
  let end = start + ifBlock.length;
  const elseMatch = text.slice(end).match(/^\s*else\b\s*/);
  if (!elseMatch) return ifBlock;
  const elseStart = end + elseMatch[0].length;
  const elseBlock = sliceBalanced(text, elseStart, "{", "}");
  return text.slice(start, elseStart + elseBlock.length);
}

/** Explicit top-level constants only; no installer body or syntax-tree traversal. */
export function extractPsAssignments(src: string, names: readonly string[]): string {
  return names.map(name => {
    const match = new RegExp("^\\$" + name + " =", "m").exec(src);
    if (!match) throw new Error(`missing $${name}`);
    return sliceAssignment(src, match.index);
  }).join("\n");
}

/** Functions only, for the bootstrap (which has no installer-specific tables). */
export function extractPsFunctions(src: string): string {
  const chunks: string[] = [];
  let i = 0;
  while (i < src.length) {
    const fn = isLineStart(src, i) ? /^[ \t]*function /.exec(src.slice(i)) : null;
    if (fn) {
      const start = i + fn[0].indexOf("function");
      const sliced = sliceBalanced(src, start, "{", "}");
      chunks.push(sliced); i = start + sliced.length; continue;
    }
    if (src.startsWith("@'", i) || src.startsWith('@"', i)) { i = skipHereString(src, i); continue; }
    i += 1;
  }
  if (!chunks.length) throw new Error("no functions");
  return chunks.join("\n");
}

export { DOWNLOAD_CLOCK_INIT, PRELUDE_ASSIGNMENTS };
