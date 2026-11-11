/** The interlock returns the unchanged plan, or throws. It does not itself establish authorization. */
export function requireWindow<T>(plan: T, sha: string, now: number, stopped?: boolean): T;
export const phases: readonly string[];
