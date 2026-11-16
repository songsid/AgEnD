export function safeRuntimeOrigin(server: unknown): string;
export function runtimeConnectCommand(server: unknown): string;
export function runtimeInstallCommand(server: unknown, scriptSha256: unknown, mode?: "personal"): string;
export function runtimeEnrollCommand(server: unknown, scriptSha256: unknown, token: unknown, fingerprint: unknown, mode?: "personal"): string;
export function runtimeInstallOnlyCommand(server: unknown, scriptSha256: unknown, mode?: "personal"): string;
export function runtimeWindowsConnectCommand(server: unknown): string;
