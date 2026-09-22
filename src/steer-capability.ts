/** Backends whose TUI has been live-verified to accept mid-turn input. */
// muse steers rather than queues: a message submitted while a turn is running
// is taken into that turn — the status bar says "steering the running turn".
// Verified live on muse 1.3.0.
const STEER_SUPPORTED_BACKENDS = new Set(["claude-code", "codex", "grok", "muse", "mock"]);

export function backendSupportsSteer(backend: string): boolean {
  return STEER_SUPPORTED_BACKENDS.has(backend);
}
