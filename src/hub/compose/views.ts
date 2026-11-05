/**
 * Where a member's approved data views come from (S-51 PR 2b). One interface, so the owner-approval flow decided under
 * #3095 §7 Q2 (the leader recommends: the owner picks files or folders in Settings, previews exactly what is included,
 * confirms; snapshotted immutable at approval, re-approved to change) plugs in later without touching composition.
 * Until then the registry is EMPTY: no exposure is publishable or askable (fail closed).
 */
import type { HubDocumentView } from "../execution/index.js";

export interface HubViewSource {
  /** The owner-approved, immutable views in force now. Called once per member mount. */
  load(): ReadonlyMap<string, HubDocumentView>;
}

export const EMPTY_VIEW_SOURCE: HubViewSource = Object.freeze({
  load: () => new Map<string, HubDocumentView>(),
});
