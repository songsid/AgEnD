/** Private mounted-generation seam, not an HTTP capability or an authorization proof. */
import type { HubDirectorySettingsDecision } from "./settings-directory-decision.js";
import type { HubDirectoryProofSource } from "./settings-directory-proof.js";
import type { PersonKey } from "./types.js";

export interface HubMountedDirectory {
  readonly decision: HubDirectorySettingsDecision;
  current(): boolean;
  source(): HubDirectoryProofSource;
  /** Same physical-promise pool as membership/welcome reads in this mounted generation. */
  withDirectoryRead<T>(person: PersonKey, work: () => Promise<T>): Promise<T>;
}
