/**
 * Backends AgEnD no longer runs, with the backend to use instead (#1280). A config that still names one fails at
 * validation and the instance refuses to start with this message. Never a silent fallback to another backend:
 * that would change which CLI and which account the instance runs on without anyone choosing it.
 */
export const REMOVED_BACKENDS: Readonly<Record<string, { removedIn: string; replacement: string }>> = {
  "gemini-cli": { removedIn: "2.1.12", replacement: "antigravity" },
};

export function isRemovedBackend(name: string | undefined): name is string {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(REMOVED_BACKENDS, name);
}

/** "backend gemini-cli was removed in AgEnD 2.1.12 — set `backend: antigravity`", optionally naming the instance. */
export function removedBackendMessage(name: string, instance?: string): string {
  const removed = REMOVED_BACKENDS[name]!;
  const who = instance ? `instance "${instance}": ` : "";
  return `${who}backend ${name} was removed in AgEnD ${removed.removedIn} — set \`backend: ${removed.replacement}\``;
}
