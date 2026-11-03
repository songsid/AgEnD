import { t } from "./locale.js";
/** A retained pane needs a person or a newer host; blindly retrying cannot supply the missing proof. */
export interface NativePaneRecovery {
  kind: "host-upgrade" | "exit-unconfirmed" | "session-unconfirmed";
  launchId?: string;
  hostBootId?: string;
  sessionId?: string;
}
export class NativePaneRecoveryError extends Error {
  constructor(readonly recovery: NativePaneRecovery) {
    super(t(recovery.kind === "host-upgrade" ? "native_pane.host_upgrade" : recovery.kind === "session-unconfirmed" ? "native_pane.session_unconfirmed" : "native_pane.exit_unconfirmed"));
    this.name = "NativePaneRecoveryError";
  }
}
