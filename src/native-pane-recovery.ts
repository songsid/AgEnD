import { t } from "./locale.js";
/** A retained pane needs a person or a newer host; blindly retrying cannot supply the missing proof. */
export interface NativePaneRecovery {
  kind: "host-upgrade" | "exit-unconfirmed";
  launchId?: string;
  hostBootId?: string;
}
export class NativePaneRecoveryError extends Error {
  constructor(readonly recovery: NativePaneRecovery) {
    super(t(recovery.kind === "host-upgrade" ? "native_pane.host_upgrade" : "native_pane.exit_unconfirmed"));
    this.name = "NativePaneRecoveryError";
  }
}
