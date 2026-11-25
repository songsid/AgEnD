/**
 * what files on task cards may be. Constants only — the agent's own side (agend-agent, the instance's daemon) and the
 * fleet's store (scheduler/task-files.ts) both read them, and the small CLI client must not pull in the fleet's modules to do it.
 */
const MiB = 1024 * 1024;

/** The most a card holds, and the most one file may be. Small enough for a fleet's disk, large enough for a prototype. */
export const TASK_FILE_LIMITS = {
  /** One file. */
  fileBytes: 10 * MiB,
  /** Files on one card. */
  files: 20,
  /** All files on one card together. */
  cardBytes: 50 * MiB,
  /** Files one write may bring. */
  perWrite: 10,
} as const;

/** Raw bytes per part: its base64 (480 KiB) plus the envelope fits the fleet IPC's 1 MiB line and the agent endpoint's 512 KiB body. */
export const TASK_FILE_PART_BYTES = 360 * 1024;
/** The most parts one file may come in (the largest file, in parts, plus one). */
export const TASK_FILE_MAX_PARTS = Math.ceil(TASK_FILE_LIMITS.fileBytes / TASK_FILE_PART_BYTES) + 1;
