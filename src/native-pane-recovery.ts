/** A retained pane needs a person or a newer host; blindly retrying cannot supply the missing proof. */
export interface NativePaneRecovery {
  kind: "host-upgrade" | "exit-unconfirmed";
  launchId?: string;
  hostBootId?: string;
}
export class NativePaneRecoveryError extends Error {
  constructor(readonly recovery: NativePaneRecovery) {
    super(recovery.kind === "host-upgrade"
      ? "The Windows pane host uses an older adapter. Stop its Windows agents, restart Windows, then choose Start. Saved conversations are kept."
      : "The previous Windows pane exit is unconfirmed. Stop its Windows processes, then use the administrator recovery action. The saved conversation is kept; no input was replayed.");
    this.name = "NativePaneRecoveryError";
  }
}
