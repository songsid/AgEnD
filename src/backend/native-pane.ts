/** Native panes reuse the ordinary pure detectors, while all provider filesystem state stays on the runner. */
import { CodexPaneDetectors } from "./codex.js";
import { ClaudePaneDetectors } from "./claude-code.js";
import type { CliBackend, CliBackendConfig } from "./types.js";
export interface NativePaneBackendState {
  sessionId: string | null;
  contextPercentage: number | null;
  statusLineItems: readonly string[] | null;
  resumes: boolean;
}
export function createNativePaneBackend(provider: "codex" | "claude-code", snapshot: () => NativePaneBackendState): CliBackend {
  const forbidden = (): never => { throw Error("Native pane launch preparation must run on its owned Windows host"); };
  const detectors = provider === "codex"
    ? new CodexPaneDetectors({ statusLineItems: () => snapshot().statusLineItems, launchMayResume: () => snapshot().resumes })
    : new ClaudePaneDetectors();
  const originalStartup = detectors.getStartupDialogs.bind(detectors);
  const backend = Object.assign(detectors, {
    buildCommand: (_config: CliBackendConfig): string => forbidden(),
    writeConfig: (_config: CliBackendConfig): void => forbidden(),
    getSessionId: (): string | null => snapshot().sessionId,
    getContextUsage: (): number | null => snapshot().contextPercentage,
    getStartupDialogs: () => originalStartup().map(dialog => {
      // A pinned native resume may never answer the provider's generic picker by creating a fresh conversation.
      if (provider === "claude-code" && snapshot().resumes && dialog.description === "Claude resume session picker — start fresh") {
        return { ...dialog, keys: [], holdOnly: true, blocksDelivery: true };
      }
      return dialog;
    }),
  });
  return backend;
}
