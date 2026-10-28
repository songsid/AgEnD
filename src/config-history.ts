/** #2829: private last-good source history; fallback is exclusively a startup YAML-syntax recovery. */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { LineCounter, parseDocument } from "yaml";
import yaml from "js-yaml";
import { ensureAgendHome } from "./agend-home.js";
import { validateClassicBotConfig, validateFleetConfig } from "./config-validator.js";
import { unshareParsed } from "./yaml-shared-nodes.js";
import { t } from "./locale.js";

export type ConfigFile = "fleet.yaml" | "classicBot.yaml";
export interface ConfigIssue {
  file: ConfigFile; line: number; column: number; reason: string;
  mode: "edit" | "fallback"; time?: string; since: number;
}
export interface ConfigSource { source: string; fallback: boolean; canonicalPath?: string }
type HistoryReason = "absent" | "unreadable" | "checksum" | "invalid";
interface Stored { source: string; time: string }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const pathKey = (path: string) => realpathSync(path);

export class ConfigStartupError extends Error {}

export class ConfigSyntaxError extends Error {
  constructor(readonly file: ConfigFile, readonly line: number, readonly column: number, readonly reason: string) {
    super(`Invalid ${file}: ${reason} at line ${line}, column ${column}`);
    this.name = "ConfigSyntaxError";
  }
}
/** Parser messages may interpolate source-derived aliases, tags or directives, even without an excerpt. */
function safeYamlReason(code?: string, reason = ""): string {
  const categories: Record<string, string> = {
    DUPLICATE_KEY: "Map keys must be unique",
    BAD_ALIAS: "Invalid YAML alias", ALIAS_PROPS: "Invalid YAML alias properties",
    BAD_DIRECTIVE: "Invalid YAML directive", BAD_DQ_ESCAPE: "Invalid YAML escape sequence",
    BAD_INDENT: "Invalid YAML indentation", TAB_AS_INDENT: "Tabs cannot be used for YAML indentation",
    BAD_PROP_ORDER: "Invalid YAML property order", BAD_SCALAR_START: "Invalid YAML scalar",
    TAG_RESOLVE_FAILED: "Invalid YAML tag", MULTIPLE_TAGS: "Multiple YAML tags",
    MULTIPLE_ANCHORS: "Multiple YAML anchors", MULTIPLE_DOCS: "Multiple YAML documents",
    MISSING_CHAR: "Missing YAML punctuation", UNEXPECTED_TOKEN: "Unexpected YAML token",
    NON_STRING_KEY: "Invalid YAML mapping key", KEY_OVER_1024_CHARS: "YAML mapping key is too long",
    MULTILINE_IMPLICIT_KEY: "Invalid multiline YAML key", BLOCK_AS_IMPLICIT_KEY: "Invalid block YAML key",
    BLOCK_IN_FLOW: "Invalid YAML collection", BAD_COLLECTION_TYPE: "Invalid YAML collection",
    RESOURCE_EXHAUSTION: "YAML resource limit exceeded",
  };
  if (code) return categories[code] ?? "Invalid YAML syntax";
  if (reason.startsWith('unidentified alias ') || reason.startsWith('name of an alias ')) return "Invalid YAML alias";
  if (reason.startsWith('unknown tag ') || reason.startsWith('undeclared tag handle ') || reason.startsWith('tag ') ||
      reason.startsWith('cannot resolve a node with ') || reason.startsWith('unacceptable node kind for ')) return "Invalid YAML tag";
  return "Invalid YAML syntax"; // Never forward an unclassified parser string.
}
/** Never include a YAML source excerpt (it can contain tokens). Both production parsers must accept the source. */
export function checkConfigSyntax(source: string, file: ConfigFile): unknown {
  const counter = new LineCounter();
  const doc = parseDocument(source, { prettyErrors: false, lineCounter: counter });
  const error = doc.errors[0];
  if (error) {
    const where = counter.linePos(error.pos[0]);
    throw new ConfigSyntaxError(file, where.line, where.col, safeYamlReason(error.code));
  }
  try {
    const safe = file === "fleet.yaml" ? source.replace(/(?<=:\s+|[-]\s+)(\d{16,})(?=\s*$)/gm, (_, d) => `"${d}"`) : source;
    return unshareParsed(yaml.load(safe), file);
  } catch (error) {
    if (error instanceof yaml.YAMLException) throw new ConfigSyntaxError(file, (error.mark?.line ?? 0) + 1,
      (error.mark?.column ?? 0) + 1, safeYamlReason(undefined, error.reason));
    throw error; // alias-expansion/loader/security failures are not syntax fallback candidates
  }
}
function valid(file: ConfigFile, raw: unknown): boolean {
  return (file === "fleet.yaml" ? validateFleetConfig(raw) : validateClassicBotConfig(raw)).valid;
}
export function configIssueText(issue: ConfigIssue, translate: (key: string, ...args: Array<string | number>) => string): string {
  return translate(`config_history.${issue.mode === "fallback" ? "fallback" : issue.time ? "edit" : "no_history"}`,
    issue.file, issue.line, issue.column, issue.reason, issue.time ?? "");
}

/** One instance per running fleet. No global load hooks: CLI validate must always inspect disk, not a backup. */
export class ConfigHistory {
  private issues = new Map<string, ConfigIssue>();
  private observed = new Map<string, string>();
  private paths = new Map<string, ConfigFile>();
  private fallback = new Set<string>();
  readonly dbPath: string;
  constructor(private home: string, private changed: () => void = () => {}, private warn: (message: string) => void = () => {}) {
    this.dbPath = join(home, "config-history.db");
  }
  track(file: ConfigFile, path: string): void { this.paths.set(resolve(path), file); }
  isFallback(path: string): boolean { return this.fallback.has(resolve(path)); }
  currentIssues(): ConfigIssue[] { return [...this.issues.values()]; }

  private database(create: boolean): Database.Database {
    if (create) {
      ensureAgendHome(this.home);
      try { closeSync(openSync(this.dbPath, "wx", 0o600)); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    }
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      try {
        const side = lstatSync(this.dbPath + suffix);
        if (!side.isFile() || (process.getuid && side.uid !== process.getuid()) || (side.mode & 0o077) !== 0) throw new Error("private history journal required");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const st = lstatSync(this.dbPath);
    if (!st.isFile() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077) !== 0) throw new Error("private history database required");
    const db = new Database(this.dbPath, { fileMustExist: true, readonly: !create, timeout: 250 });
    try {
      // DELETE journals inherit the private DB mode; FULL commits survive an abrupt fleet death.
      if (create) {
        db.pragma("journal_mode = DELETE");
        db.pragma("synchronous = FULL");
        db.exec(`CREATE TABLE IF NOT EXISTS config_versions (
          id INTEGER PRIMARY KEY, file TEXT NOT NULL, path TEXT NOT NULL,
          loaded_at TEXT NOT NULL, hash TEXT NOT NULL, content TEXT NOT NULL
        ); CREATE INDEX IF NOT EXISTS config_versions_source ON config_versions(file,path,id);`);
      }
      return db;
    } catch (err) { db.close(); throw err; }
  }
  private newest(file: ConfigFile, path: string): Stored | HistoryReason {
    try { lstatSync(this.dbPath); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable"; }
    let db: Database.Database | undefined;
    try {
      db = this.database(false);
      const row = db.prepare("SELECT content,hash,loaded_at FROM config_versions WHERE file=? AND path=? ORDER BY id DESC LIMIT 1")
        .get(file, path) as { content: string; hash: string; loaded_at: string } | undefined;
      if (!row) return "absent";
      if (typeof row.content !== "string" || hash(row.content) !== row.hash) return "checksum";
      if (!Number.isFinite(Date.parse(row.loaded_at))) return "invalid";
      try { if (!valid(file, checkConfigSyntax(row.content, file))) return "invalid"; } catch { return "invalid"; }
      return { source: row.content, time: row.loaded_at };
    } catch { return "unreadable"; } finally { db?.close(); }
  }
  private problem(path: string, error: ConfigSyntaxError, stored: Stored | HistoryReason, mode: ConfigIssue["mode"]): void {
    const key = resolve(path), previous = this.issues.get(key);
    const issue: ConfigIssue = { file: error.file, line: error.line, column: error.column, reason: error.reason,
      mode: this.fallback.has(key) ? "fallback" : mode, since: previous?.since ?? Date.now(),
      ...(typeof stored === "object" ? { time: stored.time } : previous?.mode === "fallback" ? { time: previous.time } : {}) };
    if (JSON.stringify(previous) !== JSON.stringify(issue)) { this.issues.set(key, issue); this.changed(); }
  }
  read(file: ConfigFile, path: string, startup = false): ConfigSource {
    const key = resolve(path); this.paths.set(key, file);
    const canonicalPath = pathKey(path);
    const source = readFileSync(canonicalPath, "utf8"); // IO/permission/missing files never select history
    if (pathKey(path) !== canonicalPath) throw new Error("Configuration path changed while being read");
    try { checkConfigSyntax(source, file); return { source, fallback: false, canonicalPath }; }
    catch (error) {
      if (!(error instanceof ConfigSyntaxError)) throw error;
      const stored = this.newest(file, canonicalPath);
      if (pathKey(path) !== canonicalPath) throw new Error("Configuration path changed while checking history");
      if (startup && typeof stored === "object") {
        this.fallback.add(key); this.problem(path, error, stored, "fallback");
        return { source: stored.source, fallback: true, canonicalPath };
      }
      this.problem(path, error, stored, "edit");
      if (startup) throw new ConfigStartupError(t("config_history.startup_failed", file, error.line, error.column, error.reason,
        t(`config_history.history_${stored as HistoryReason}`)));
      throw error;
    }
  }
  /** Call only after the source's real loader accepted it; never timestamp a fallback as a fresh disk load. */
  accepted(file: ConfigFile, path: string, selected: ConfigSource): void {
    const key = resolve(path); this.paths.set(key, file);
    if (selected.fallback) return;
    this.fallback.delete(key);
    if (this.issues.delete(key)) this.changed();
    let db: Database.Database | undefined;
    try {
      if (!valid(file, checkConfigSyntax(selected.source, file))) return; // keep existing schema policy, not in history
      const canonical = selected.canonicalPath ?? pathKey(path), digest = hash(selected.source);
      db = this.database(true);
      const store = db;
      store.transaction(() => {
        const newest = store.prepare("SELECT hash,content FROM config_versions WHERE file=? AND path=? ORDER BY id DESC LIMIT 1").get(file, canonical) as { hash: string; content: string } | undefined;
        if (newest?.hash === digest && newest.content === selected.source) return;
        store.prepare("INSERT INTO config_versions(file,path,loaded_at,hash,content) VALUES (?,?,?,?,?)")
          .run(file, canonical, new Date().toISOString(), digest, selected.source);
        store.prepare("DELETE FROM config_versions WHERE file=? AND path=? AND id NOT IN (SELECT id FROM config_versions WHERE file=? AND path=? ORDER BY id DESC LIMIT 5)")
          .run(file, canonical, file, canonical);
      }).immediate();
    } catch { this.warn("Could not store valid configuration history; the current disk settings remain usable"); }
    finally { db?.close(); }
  }
  /** Passive: observe edits without applying Fleet settings. Stable state means no work and no repeated notice. */
  check(): void {
    for (const [path, file] of this.paths) {
      try {
        const st = statSync(path), stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
        if (this.observed.get(path) === stamp) continue;
        this.observed.set(path, stamp);
        this.read(file, path);
        if (!this.fallback.has(path) && this.issues.delete(path)) this.changed();
      } catch { /* parse errors are represented by read(); IO errors retain the existing load policy */ }
    }
  }
}
