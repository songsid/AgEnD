/** Rollback-safe UI preference; never part of fleet.yaml or monitoring history. */
import { openSync, closeSync, fstatSync, readSync, constants, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { noteSettingsWrite } from './settings-transaction.js';
import { atomicWriteFileSync } from './atomic-write.js';

export const hostMonitoringSettingsPath = (dir: string) => join(dir, 'host-monitoring-settings.json');
export const validMonitoringDrive = (value: unknown): value is string => typeof value === 'string' && /^[A-Z]?$/.test(value);
export function parseHostMonitoringDrive(bytes: Buffer | string | null): string | undefined {
  if (bytes === null || Buffer.byteLength(bytes) > 512) return undefined;
  try {
    const data = JSON.parse(bytes.toString());
    return data && typeof data === 'object' && !Array.isArray(data) && data.version === 1
      && Object.keys(data).length === 2 && validMonitoringDrive(data.wsl_drive) ? data.wsl_drive || undefined : undefined;
  } catch { return undefined; }
}
export function readHostMonitoringDrive(dir: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(hostMonitoringSettingsPath(dir), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > 512) return undefined;
    const bytes = Buffer.alloc(513);
    let size = 0, part: number;
    while (size < bytes.length && (part = readSync(fd, bytes, size, bytes.length - size, null))) size += part;
    return parseHostMonitoringDrive(bytes.subarray(0, size));
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function writeHostMonitoringDrive(dir: string, value: string): void {
  if (!validMonitoringDrive(value)) throw Error('invalid_monitoring_drive');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const previous = readHostMonitoringDrive(dir);
  atomicWriteFileSync(hostMonitoringSettingsPath(dir), JSON.stringify({ version: 1, wsl_drive: value }) + '\n', { mode: 0o600 });
  noteSettingsWrite(hostMonitoringSettingsPath(dir), { wsl_drive: previous }, { wsl_drive: value || undefined });
}
