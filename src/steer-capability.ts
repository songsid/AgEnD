/** Backends whose TUI has been live-verified to accept mid-turn input. */
// muse steers rather than queues: a message submitted while a turn is running
// is taken into that turn — the status bar says "steering the running turn".
// Verified live on muse 1.3.0.
const STEER_SUPPORTED_BACKENDS = new Set(["claude-code", "codex", "grok", "muse", "mock"]);

export function backendSupportsSteer(backend: string): boolean {
  return STEER_SUPPORTED_BACKENDS.has(backend);
}

/**
 * Whether a steer can go to this instance (#1405). A backend whose capability depends on how the instance was launched
 * answers for its own launch (kiro: only its TUI front-ends, on a verified version — CliBackend.supportsSteer); every
 * other backend, and an instance with no running launch to ask, falls back to the name table above.
 */
export function instanceSupportsSteer(backend: string, launchSupportsSteer: boolean | undefined): boolean {
  return launchSupportsSteer ?? backendSupportsSteer(backend);
}
