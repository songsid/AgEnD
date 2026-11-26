// Types for install-admission.cjs (the postinstall's process-identity probes), for the TypeScript that bundles it —
// the update recovery kit's recover.cjs (M-3770 2.1c), which must not load anything from the package at run time.
export declare const LOCK: string;
export declare const TOKEN_ENV: string;
export declare function processStart(pid: number): string | null;
export declare function startTicks(pid: number): string | null;
export declare function bootId(): string | null;
export declare function exists(pid: number): boolean;
