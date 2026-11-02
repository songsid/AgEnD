import { TmuxManager } from "./tmux-manager.js";
import type { PaneHost, PaneObservation, PaneSize } from "./pane-port.js";
import type { TmuxReadPort } from "./tmux-read.js";

/** The control-mode read optimization is local to tmux, not part of a terminal transport. */
function readPort(observation?: PaneObservation): TmuxReadPort | undefined {
  const candidate = observation as (PaneObservation & Partial<TmuxReadPort>) | undefined;
  return typeof candidate?.read === "function" && typeof candidate.isFor === "function"
    ? candidate as TmuxReadPort : undefined;
}

/** Delegation preserves native handle identity, optional read lanes and all existing defaults. */
export class TmuxPaneHost implements PaneHost {
  bind(session: string, id: string, size?: PaneSize, observation?: PaneObservation) {
    return new TmuxManager(session, id, size, readPort(observation));
  }
  ensureSession(session: string) { return TmuxManager.ensureSession(session); }
  sessionExists(session: string) { return TmuxManager.sessionExists(session); }
  sessionExistsStrict(session: string) { return TmuxManager.sessionExistsStrict(session); }
  killSession(session: string) { return TmuxManager.killSession(session); }
  getServerPid(session: string) { return TmuxManager.getServerPid(session); }
  listWindows(session: string, observation?: PaneObservation) { return TmuxManager.listWindows(session, readPort(observation)); }
  listWindowsStrict(session: string, observation?: PaneObservation) { return TmuxManager.listWindowsStrict(session, readPort(observation)); }
  getPanePid(session: string, id: string, timeoutMs?: number) { return TmuxManager.getPanePid(session, id, timeoutMs); }
  listPanePids(session: string, timeoutMs?: number) { return TmuxManager.listPanePids(session, timeoutMs); }
}

export const tmuxPaneHost: PaneHost = new TmuxPaneHost();
