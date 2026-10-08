import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import type { FleetConfig } from "./types.js";
import type { SettingsBaseline } from "./settings-http-confirmation.js";
import type { SettingsEffectContext } from "./settings-effect.js";
import { SettingsConfirmationError } from "./settings-confirmation.js";
import { performance } from "node:perf_hooks";
import { withinBudget } from "./monotonic-budget.js";
import { settingsFingerprint, settingsRevision } from "./settings-transaction.js";

const MAX_FILE_BYTES = 512 * 1024;
async function read(path: string | null): Promise<Buffer | null> {
  if (!path) return null;
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new SettingsConfirmationError(413, "settings_baseline_too_large");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let bytes = 0;
    while (bytes <= MAX_FILE_BYTES) {
      const part = await file.read(buffer, bytes, buffer.length - bytes, null);
      if (!part.bytesRead) return buffer.subarray(0, bytes);
      bytes += part.bytesRead;
    }
    throw new SettingsConfirmationError(413, "settings_baseline_too_large");
  } finally { await file.close(); }
}

/** Only the synchronous commit receipt uses this bounded no-follow read; polling stays async. */
function readCommitted(path: string | null): Buffer | null {
  if (!path) return null;
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new SettingsConfirmationError(413, "settings_baseline_too_large");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1); let bytes = 0, part: number;
    while (bytes <= MAX_FILE_BYTES && (part = readSync(fd, buffer, bytes, buffer.length - bytes, null))) bytes += part;
    if (bytes > MAX_FILE_BYTES) throw new SettingsConfirmationError(413, "settings_baseline_too_large");
    return buffer.subarray(0, bytes);
  } finally { closeSync(fd); }
}

/** The private hash includes disk and runtime state. Neither bytes nor hashes are logged. */
export class SettingsBaselines {
  constructor(private readonly options: {
    dataDir: string; configPath(): string | null; config(): FleetConfig | null;
    current(): unknown; proof?: SettingsEffectContext["proof"];
  }) {}
  snapshot(): unknown {
    const files = [this.options.configPath(), join(this.options.dataDir, "classicBot.yaml"), join(this.options.dataDir, ".env")];
    return { runtime: this.options.config(), owner: this.options.current(),
      revisions: files.map(path => path ? settingsRevision(path) : null) };
  }
  captureCommitted(): string {
    const before = settingsFingerprint(this.snapshot());
    const files = [this.options.configPath(), join(this.options.dataDir, "classicBot.yaml"), join(this.options.dataDir, ".env")];
    const bytes = files.map(readCommitted);
    return settingsFingerprint([before, ...bytes.map(item => item === null ? null : settingsFingerprint(item.toString("utf8")))]);
  }
  async read(): Promise<SettingsBaseline> {
    const before = settingsFingerprint(this.snapshot());
    const files = [this.options.configPath(), join(this.options.dataDir, "classicBot.yaml"), join(this.options.dataDir, ".env")];
    const bytes = await withinBudget(Promise.all(files.map(read)), performance.now() + 5000);
    if (settingsFingerprint(this.snapshot()) !== before) throw new SettingsConfirmationError(409, "settings_changed");
    let classic: Record<string, any> = {};
    if (bytes[1]) {
      const parsed = yaml.load(bytes[1].toString("utf8"));
      if (parsed && (typeof parsed !== "object" || Array.isArray(parsed))) throw new SettingsConfirmationError(409, "invalid_classic_baseline");
      classic = (parsed ?? {}) as Record<string, any>;
    }
    return { config: structuredClone(this.options.config()), classic, proof: this.options.proof,
      fingerprint: settingsFingerprint([before, ...bytes.map(item => item === null ? null : settingsFingerprint(item.toString("utf8")))]) };
  }
}
