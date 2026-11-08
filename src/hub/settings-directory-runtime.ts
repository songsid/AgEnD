/** Private mounted-generation seam, not an HTTP capability or an authorization proof. */
import type { HubDirectorySettingsDecision } from "./settings-directory-decision.js";
import type { HubDirectoryProofSource } from "./settings-directory-proof.js";
import type { HubSessions } from "./sessions.js";
import type { PersonKey } from "./types.js";

export type HubDirectoryBrowserSessions = Pick<HubSessions, "recentAuthentication" | "prepareDirectoryRotation" | "completeDirectoryRotation">;

export interface HubMountedDirectory {
  readonly decision: HubDirectorySettingsDecision;
  current(): boolean;
  source(): HubDirectoryProofSource;
  /** Bound to this exact HTTP/session generation; absent entries refuse rather than fabricate a handoff. */
  sessions(): HubDirectoryBrowserSessions;
  /** Same physical-promise pool as membership/welcome reads in this mounted generation. */
  withDirectoryRead<T>(person: PersonKey, work: () => Promise<T>): Promise<T>;
}
