export const SMOKE_DIR: string;
export interface UiGateSmoke { file: string; name: string; hp: number }
/** Every smoke under scripts/manual/smoke/ with a `// ui-gate:` line, checked; throws naming what is wrong. */
export function discover(root?: string): UiGateSmoke[];
/** M-3332: shard k of n ("k/n", 1-based): every n-th smoke from the k-th, in the given order; throws on a bad spec. */
export function shardOf<T>(smokes: T[], spec: string): T[];
/** The CLI: run them (or `--list`, `--only <file>…`, `--shard k/n`); the exit code. */
export function main(argv: string[]): number;
