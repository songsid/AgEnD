export const SMOKE_DIR: string;
export interface UiGateSmoke { file: string; name: string; hp: number }
/** Every smoke under scripts/manual/smoke/ with a `// ui-gate:` line, checked; throws naming what is wrong. */
export function discover(root?: string): UiGateSmoke[];
/** The CLI: run them (or `--list`, `--only <file>…`); the exit code. */
export function main(argv: string[]): number;
