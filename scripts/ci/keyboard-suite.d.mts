export interface KeyboardRevert { file: string; from: string; to: string }
export interface KeyboardCase { id: string; refs: string[]; what: string; tests: Record<string, string[]>; smokes: Array<{ file: string; cases?: string[] }>; revert: KeyboardRevert }
/** The keyboard's code: a change to one of these runs the whole suite. */
export const KEYBOARD_PATHS: RegExp[];
/** M-3357: every past iPhone keyboard case, its tests, smokes and the fix undone. */
export const CASES: KeyboardCase[];
export const SMOKES: Array<{ file: string; hp: number }>;
/** Problems with the manifest against the tree at `root` (empty: fine). */
export function check(root?: string): string[];
/** Whether any of `files` is keyboard code. */
export function touches(files: string[]): boolean;
export function runUnit(root?: string): Promise<string[]>;
export function runReverts(root?: string, only?: string[]): Promise<string[]>;
export function runSmokes(root?: string, only?: string[]): string[];
