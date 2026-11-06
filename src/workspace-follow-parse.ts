/** Pure, conservative CLI file metadata extraction; no filesystem reads or command execution. */
export const FOLLOW_LIMITS = Object.freeze({ steps: 40, pathsPerStep: 8, pathChars: 1024 });

export type FollowKind = "read" | "edit" | "search" | "list";
/** One step as recorded: the CLI's own paths (absolute, or relative to the agent's folder). */
export interface FollowStep {
  seq: number;
  at: number;
  kind: FollowKind;
  tool: string;
  paths: string[];
  /** 1-based, inclusive, when the CLI said which lines it read. */
  range?: { from: number; to: number };
  /** false: read from a shell command line, best-effort. */
  exact: boolean;
  /** CLI call identity, for completion updates; no argument or result text is retained. */
  id?: string;
  phase?: "running" | "done" | "failed";
  /** Internal only: explicit shell cwd. Never projected to the browser. */
  cwd?: string;
  /** Exact changed new-file line numbers, when a recorded tool result supplies its structured patch. */
  editLines?: number[];
}
export type FollowStepInput = Omit<FollowStep, "seq" | "at">;

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= FOLLOW_LIMITS.pathChars && !/[\u0000-\u001f]/.test(v) ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);

/** The file paths a Codex `apply_patch` touches (`*** Add|Update|Delete File: <path>`, `*** Move to: <path>`). */
export function applyPatchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm)) {
    const p = str(m[1]); if (p && !out.includes(p)) out.push(p);
    if (out.length >= FOLLOW_LIMITS.pathsPerStep) break;
  }
  return out;
}

/** A shell command line split into words, quotes honoured, stopping at the first `|`, `;`, `&&`, `||` or redirect. */
function firstCommandWords(line: string): string[] {
  if (line.length > 64 * 1024 || /[$`\\\r\n]/.test(line)) return [];
  const words: string[] = [];
  let cur = "", quote: string | null = null, has = false;
  for (let i = 0; i < line.length && words.length < 64; i++) {
    const c = line[i]!;
    if (quote) { if (c === quote) quote = null; else cur += c; continue; }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === "#" && !has && !cur) break; // An unquoted comment starts only at a word boundary.
    if (c === "|" || c === ";" || c === "&" || c === ">" || c === "<") break;
    if (/\s/.test(c)) { if (has || cur) { words.push(cur); cur = ""; has = false; } continue; }
    cur += c;
  }
  if (quote) return [];
  if (has || cur) words.push(cur);
  return words;
}
/** The command line a Codex shell call ran: `["bash","-lc","<line>"]`, a `cmd` string, or plain argv. */
function shellWords(input: unknown): string[] {
  const o = input as Record<string, unknown> | null;
  const c = o && (o.command ?? o.cmd);
  if (typeof c === "string") return firstCommandWords(c);
  if (Array.isArray(c) && c.every((x) => typeof x === "string")) {
    const a = c as string[];
    const executable = a[0]?.split("/").pop();
    if (["sh", "bash", "dash", "zsh", "ksh"].includes(executable ?? "")) {
      // A literal argv's -c may be grep's count option. Only admit the simple, proven shell wrapper shapes.
      return (a[1] === "-c" || a[1] === "-lc") && a[2] ? firstCommandWords(a[2]) : [];
    }
    return a;
  }
  return [];
}

/** Consume option values as well as flags. Unknown options are ambiguous, so produce no guessed paths. */
function operands(words: string[], flags: Set<string>, values = new Set<string>(), seen = new Set<string>()): string[] | null {
  const out: string[] = [];
  let literal = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (!literal && w === "--") { literal = true; continue; }
    if (!literal && w.startsWith("-")) {
      const [key] = w.split("=", 1);
      if (values.has(key!)) { seen.add(key!); if (!w.includes("=") && ++i >= words.length) return null; continue; }
      if (!w.startsWith("--") && w.length > 2 && values.has(w.slice(0, 2))) { seen.add(w.slice(0, 2)); continue; }
      if (!flags.has(w) && !(w.length > 2 && !w.startsWith("--") && [...w.slice(1)].every(c => flags.has(`-${c}`)))) return null;
      for (const flag of flags.has(w) ? [w] : [...w.slice(1)].map(c => `-${c}`)) seen.add(flag);
    } else out.push(w);
  }
  return out;
}
const set = (s: string) => new Set(s.split(" "));

/** A shell read / search / listing, best-effort (`exact: false`). */
export function shellStep(line: string): FollowStepInput | null {
  return shellStepWords(firstCommandWords(line.trim()));
}
function shellStepWords(input: string[]): FollowStepInput | null {
  let words = input;
  // `cd dir && …` changes the folder the rest is read in: don't guess past it.
  if (words[0] === "cd") return null;
  if (words[0] === "command") words = words.slice(1);
  const cmd = words[0] ?? "";
  const paths = (list: string[]) => list.map(str).filter((p): p is string => !!p && !/[$`*?\[\]\\]/.test(p)).slice(0, FOLLOW_LIMITS.pathsPerStep);
  if (cmd === "sed") {
    const ops = operands(words, set("-n --quiet --silent"));
    if (!ops || !/^\d+(?:,\d+)?p$/.test(ops[0] ?? "")) return null;
    const script = ops[0], files = ops.slice(1);
    if (!files.length) return null;
    const m = script ? /^(\d+)(?:,(\d+))?p$/.exec(script) : null;
    const from = m ? Number(m[1]) : null, to = m ? Number(m[2] ?? m[1]) : null;
    return { kind: "read", tool: "shell", paths: paths(files), exact: false, ...(from && to && Number.isSafeInteger(to) && to >= from ? { range: { from, to } } : {}) };
  }
  if (["cat", "head", "tail", "nl", "bat", "less", "more", "wc"].includes(cmd)) {
    const files = operands(words, set("-n -b -E -T -s -v -A -q -c -l -w -m -L -u --number --number-nonblank"),
      cmd === "head" || cmd === "tail" ? set("-n -c --lines --bytes") : cmd === "nl" ? set("-b -d -f -h -i -l -n -s -v -w") : new Set());
    if (!files) return null;
    return files.length ? { kind: "read", tool: "shell", paths: paths(files), exact: false } : null;
  }
  if (cmd === "rg" || cmd === "grep" || cmd === "git" && words[1] === "grep") {
    const args = cmd === "git" ? words.slice(1) : words;
    const options = new Set<string>();
    const ops = operands(args, set("-n -l -L -i -S -s -w -x -F -P -v -c -r -R -h -H -o --files --line-number --files-with-matches --files-without-match --hidden --no-ignore --no-heading --heading --no-messages --count --fixed-strings --ignore-case"),
      set("-e --regexp -f --file -g --glob --iglob -t --type -T --type-not -m --max-count -C --context -B --before-context -A --after-context --encoding --max-filesize -j --threads --sort --sortr --color --colors --ignore-file"), options);
    if (!ops) return null;
    const explicitPattern = ["-e", "-f", "--regexp", "--file"].some(flag => options.has(flag));
    const filesOnly = options.has("--files");
    if (filesOnly && cmd !== "rg") return null; // grep/git grep do not have rg's pattern-free mode.
    const where = filesOnly || explicitPattern ? ops : ops.slice(1);
    return { kind: filesOnly ? "list" : "search", tool: "shell", paths: paths(where.length ? where : ["."]), exact: false };
  }
  if (cmd === "ls" || cmd === "find" || cmd === "tree") {
    const ops = cmd === "find" ? words.slice(1, words.findIndex((w,i) => i > 0 && w.startsWith("-")) < 0 ? undefined : words.findIndex((w,i) => i > 0 && w.startsWith("-")))
      : operands(words, set("-l -a -A -h -t -r -S -d -F -R -1 --all --almost-all --directory"));
    if (!ops) return null;
    return { kind: "list", tool: "shell", paths: paths(ops.length ? ops : ["."]), exact: false };
  }
  return null;
}

/** One tool call → a step, or null when it says nothing about a file. Pure. */
export function followStepOf(tool: string, input: unknown): FollowStepInput | null {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  switch (tool) {
    case "Read": {
      const p = str(o.file_path); if (!p) return null;
      const off = int(o.offset), lim = int(o.limit);
      return { kind: "read", tool, paths: [p], exact: true, ...(off || lim ? { range: { from: off ?? 1, to: (off ?? 1) + (lim ?? 1) - 1 } } : {}) };
    }
    case "Edit": case "MultiEdit": case "Write": {
      const p = str(o.file_path); return p ? { kind: "edit", tool, paths: [p], exact: true } : null;
    }
    case "NotebookEdit": {
      const p = str(o.notebook_path); return p ? { kind: "edit", tool, paths: [p], exact: true } : null;
    }
    case "Grep": case "Glob": { const p = str(o.path); return { kind: "search", tool, paths: p ? [p] : ["."], exact: true }; }
    case "LS": { const p = str(o.path); return p ? { kind: "list", tool, paths: [p], exact: true } : null; }
    case "apply_patch": {
      const text = typeof input === "string" ? input : typeof o.input === "string" ? o.input : typeof o.patch === "string" ? o.patch : null;
      const paths = text ? applyPatchPaths(text) : [];
      return paths.length ? { kind: "edit", tool, paths, exact: true } : null;
    }
    case "Bash": case "shell": case "exec_command": case "local_shell": case "container.exec": {
      const step = shellStepWords(shellWords(input));
      const cwd = o.workdir ?? o.cwd ?? o.working_directory;
      if (cwd !== undefined && !str(cwd)) return null;
      return step ? { ...step, ...(typeof cwd === "string" ? { cwd } : {}) } : null;
    }
    default: return null;
  }
}
