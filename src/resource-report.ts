import { readFileSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import yaml from "js-yaml";
import { classicInstanceName } from "./classic-channel-manager.js";
import { sanitizeInstanceName } from "./topic-commands.js";
import { t } from "./locale.js";

import { readHostMemory, type HostMemory } from "./host-memory.js";
export { readHostMemory, type HostMemory } from "./host-memory.js";

export interface DirectoryUsage {
  path: string;
  names: string[];
  bytes: number | null;
}

export interface ResourceReport {
  memory: HostMemory;
  workspaces: DirectoryUsage[];
  /** null means classification is unavailable, not that there are no unregistered directories. */
  orphans: DirectoryUsage[] | null;
  notes: string[];
}

interface ResourceDeps {
  memory: () => HostMemory;
  diskUsage: (path: string, timeoutMs: number) => Promise<number | null>;
  now: () => number;
  budgetMs: number;
}

/** Allocated disk space. No shell, no descendant symlink traversal; kill slow scans. */
export function probeDiskUsage(path: string, timeoutMs: number, binary = "du"): Promise<number | null> {
  return new Promise(resolveResult => {
    execFile(binary, ["-sk", "-x", path], {
      encoding: "utf8", timeout: Math.max(1, Math.floor(timeoutMs)), killSignal: "SIGKILL", maxBuffer: 64 * 1024,
    }, (err, stdout) => {
      // du can print a partial total and still fail (permissions / concurrent removal).
      if (err) { resolveResult(null); return; }
      const match = stdout.match(/^(\d+)\s/);
      const bytes = match ? Number(match[1]) * 1024 : NaN;
      resolveResult(Number.isSafeInteger(bytes) ? bytes : null);
    });
  });
}

function mapping(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRegistry(path: string, optional: boolean): { raw: Record<string, any>; text: string | null } {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (err) {
    if (optional && (err as NodeJS.ErrnoException).code === "ENOENT") return { raw: {}, text: null };
    throw err;
  }
  // Same ID-preserving parse as loadRawFleetConfig, without loadFleetConfig's mkdir/git-init.
  const parsed = yaml.load(text.replace(/(?<=:\s+|[-]\s+)(\d{16,})(?=\s*$)/gm, (_, id) => `"${id}"`));
  if (parsed != null && !mapping(parsed)) throw new Error("invalid registry");
  return { raw: parsed ?? {}, text };
}

/** A bounded, read-only snapshot. Shared directories are measured once, never summed twice. */
export async function collectResourceReport(dataDir: string, overrides: Partial<ResourceDeps> = {}): Promise<ResourceReport> {
  const deps: ResourceDeps = { memory: readHostMemory, diskUsage: probeDiskUsage, now: () => performance.now(), budgetMs: 5_000, ...overrides };
  const deadline = deps.now() + deps.budgetMs;
  const report: ResourceReport = { memory: deps.memory(), workspaces: [], orphans: null, notes: [] };
  const known = new Set<string>();
  const candidates = new Map<string, Set<string>>();
  const addWorkspace = (path: string, name?: string) => {
    const absolute = resolve(path);
    const names = candidates.get(absolute) ?? new Set<string>();
    if (name) names.add(name);
    candidates.set(absolute, names);
  };
  const snapshots: Array<{ path: string; text: string | null }> = [];
  let registryComplete = true;
  let fleet: Record<string, any> = {};
  for (const [filename, optional] of [["fleet.yaml", false], ["classicBot.yaml", true]] as const) {
    const path = join(dataDir, filename);
    try {
      const snapshot = readRegistry(path, optional);
      snapshots.push({ path, text: snapshot.text });
      const raw = snapshot.raw;
      const entries = raw[filename === "fleet.yaml" ? "instances" : "channels"] ?? {};
      if (!mapping(entries) || Object.values(entries).some(entry => !mapping(entry))) throw new Error("invalid entries");
      if (filename === "fleet.yaml") {
        fleet = raw;
        for (const [name, config] of Object.entries(entries)) {
          known.add(name);
          const workDir = config.working_directory ?? raw.defaults?.working_directory;
          if (workDir != null && typeof workDir !== "string") throw new Error("invalid workspace");
          addWorkspace(workDir || join(dataDir, "workspaces", name), name);
        }
      } else {
        const firstChannel = Array.isArray(fleet.channels) && fleet.channels.length > 0 ? fleet.channels[0] : fleet.channel;
        const primaryAdapter = firstChannel?.id ?? firstChannel?.type;
        for (const [key, entry] of Object.entries(entries)) {
          const channelId = entry.channelId ?? key;
          if (typeof channelId !== "string" || (entry.name != null && typeof entry.name !== "string")
            || (entry.instanceName != null && typeof entry.instanceName !== "string")
            || (entry.adapterId != null && typeof entry.adapterId !== "string")) throw new Error("invalid classic identity");
          const adapterSuffix = entry.adapterId && entry.adapterId !== primaryAdapter ? entry.adapterId : undefined;
          const name = entry.instanceName ?? classicInstanceName(sanitizeInstanceName(entry.name ?? channelId), channelId, adapterSuffix);
          known.add(name);
          addWorkspace(join(dataDir, "workspaces", name), name);
        }
      }
    } catch {
      registryComplete = false;
      report.notes.push(t("resources.registry_unknown", filename));
    }
  }

  // Include retained managed workspaces, even when no configured instance uses them.
  try {
    for (const entry of await readdir(join(dataDir, "workspaces"), { withFileTypes: true })) {
      if (entry.isDirectory()) addWorkspace(join(dataDir, "workspaces", entry.name));
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") report.notes.push(t("resources.scan_unknown", join(dataDir, "workspaces")));
  }
  const canonical = new Map<string, Set<string>>();
  for (const [path, names] of candidates) {
    let key = path;
    try { key = await realpath(path); } catch { /* missing workspace remains visible as unknown */ }
    const merged = canonical.get(key) ?? new Set<string>();
    for (const name of names) merged.add(name);
    canonical.set(key, merged);
  }
  report.workspaces = [...canonical].map(([path, names]) => ({ path, names: [...names].sort(), bytes: null })).sort((a, b) => a.path.localeCompare(b.path));
  if (registryComplete) {
    try {
      report.orphans = (await readdir(join(dataDir, "instances"), { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && !known.has(entry.name))
        .map(entry => ({ path: join(dataDir, "instances", entry.name), names: [entry.name], bytes: null }))
        .sort((a, b) => a.path.localeCompare(b.path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") report.orphans = [];
      else report.notes.push(t("resources.scan_unknown", join(dataDir, "instances")));
    }
  }

  // Small retained state directories get a measurement before potentially large repos.
  const rows = [...(report.orphans ?? []), ...report.workspaces];
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      const remaining = deadline - deps.now();
      if (remaining <= 0) continue;
      try { row.bytes = await deps.diskUsage(row.path, Math.min(2_000, remaining)); } catch { /* unknown, not zero */ }
    }
  };
  await Promise.all([worker(), worker()]);
  // A registry changed during the scan: do not present a stale orphan verdict.
  for (const snapshot of snapshots) {
    try {
      if (readRegistry(snapshot.path, snapshot.text === null).text !== snapshot.text) throw new Error("changed");
    } catch {
      report.orphans = null;
      report.notes.push(t("resources.registry_changed"));
      break;
    }
  }
  return report;
}

export function formatResourceBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log2(bytes || 1) / 10)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

// Filenames/config labels must not inject terminal control sequences into the report.
function display(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function resourceChecks(report: ResourceReport): Array<{ status: "ok" | "warn"; label: string; detail: string }> {
  const size = (bytes: number | null) => bytes === null ? t("resources.size_unknown") : formatResourceBytes(bytes);
  const memory = report.memory;
  const checks: ReturnType<typeof resourceChecks> = [{
    status: "ok", label: t("resources.memory"),
    detail: memory.availableKind === "unknown" ? t("resources.memory_unknown", size(memory.totalBytes))
      : t(memory.availableKind === "available" ? "resources.memory_available" : "resources.memory_free", size(memory.availableBytes), size(memory.totalBytes)),
  }, {
    status: "ok", label: t("resources.swap"),
    detail: memory.swapTotalBytes === null ? t("resources.swap_unknown") : t("resources.swap_free", size(memory.swapFreeBytes), size(memory.swapTotalBytes)),
  }];
  for (const row of report.workspaces) checks.push({
    status: row.bytes === null ? "warn" : "ok", label: `${t("resources.workspace")} ${display(row.path)}`,
    detail: `${size(row.bytes)}${row.names.length ? ` (${row.names.map(display).join(", ")})` : ""}`,
  });
  checks.push({
    status: report.orphans === null || report.orphans.length > 0 ? "warn" : "ok", label: t("resources.orphans"),
    detail: report.orphans === null ? t("resources.orphans_unknown") : t("resources.orphans_count", report.orphans.length),
  });
  for (const row of report.orphans ?? []) checks.push({ status: "warn", label: display(row.path), detail: size(row.bytes) });
  for (const note of report.notes) checks.push({ status: "warn", label: t("resources.note"), detail: display(note) });
  return checks;
}

export function formatResourceReport(report: ResourceReport): string {
  return ["", t("resources.title"), ...resourceChecks(report).map(check => `  ${check.status === "warn" ? "⚠" : "•"} ${check.label}: ${check.detail}`)].join("\n");
}
