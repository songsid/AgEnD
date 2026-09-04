/** Backends whose TUI has been live-verified to accept mid-turn input. */
const STEER_SUPPORTED_BACKENDS = new Set(["claude-code", "codex", "grok", "mock"]);

export function backendSupportsSteer(backend: string): boolean {
  return STEER_SUPPORTED_BACKENDS.has(backend);
}
