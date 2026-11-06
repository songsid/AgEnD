/** Types for `toolchain.mjs`. Node16 resolves a `.mjs` import to `.d.mts`. */
export function parseApkInfo(text: string): Record<string, string>;
export function lockMismatches(lock: Record<string, string>, installed: Record<string, string>): string[];
export function toolchainEnv(target: string, sources?: unknown): Record<string, string>;
export function toolchainIdentity(target: string, sources?: unknown): Record<string, unknown>;
