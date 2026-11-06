/** Native panes reuse the ordinary pure detectors, while all provider filesystem state stays on the runner. */
import { CodexPaneDetectors } from "./codex.js";
import { win32 } from "node:path";
import { ClaudePaneDetectors, claudeTrustDialogState } from "./claude-code.js";
import type { CliBackend, CliBackendConfig, StartupDialog } from "./types.js";
import { selectionCard } from "../selection-card.js";
export interface NativePaneBackendState {
  sessionId: string | null;
  contextPercentage: number | null;
  statusLineItems: readonly string[] | null;
  resumes: boolean;
  cwd?: string;
}
export function createNativePaneBackend(provider: "codex" | "claude-code", snapshot: () => NativePaneBackendState, admission: { contextlessResume?: boolean } = {}): CliBackend {
  const forbidden = (): never => { throw Error("Native pane launch preparation must run on its owned Windows host"); };
  const detectors = provider === "codex"
    ? new CodexPaneDetectors({ statusLineItems: () => snapshot().statusLineItems, launchMayResume: () => snapshot().resumes, windowsConpty: true, contextlessResume: admission.contextlessResume === true })
    : new ClaudePaneDetectors();
  const originalStartup = detectors.getStartupDialogs.bind(detectors);
  const originalRuntime = detectors.getRuntimeDialogs.bind(detectors);
  const trustScope = <T extends StartupDialog>(dialog: T): T => {
    if (provider !== "claude-code" || !dialog.description.startsWith("Claude workspace trust dialog")) return dialog;
    const matchesCwd = (pane: string): boolean => {
      const cwd = snapshot().cwd;
      const paths = pane.split(/\r?\n/).map(row => row.trim()).filter(row => /^[A-Za-z]:[\\/]/.test(row));
      return !!cwd && paths.length === 1 && win32.normalize(paths[0]).toLowerCase() === win32.normalize(cwd).toLowerCase();
    };
    return { ...dialog, isActive: (pane: string) => dialog.holdOnly
      ? !!dialog.isActive?.(pane) || (claudeTrustDialogState(pane).active && !matchesCwd(pane))
      : matchesCwd(pane) && !!dialog.isActive?.(pane) };
  };
  const shellCard = (pane: string) => {
    if (provider !== "claude-code" || (detectors as ClaudePaneDetectors).readInputRow(pane) !== null
      || !/^[ \t]*(?:PowerShell|Bash) command[ \t]*$/m.test(pane)
      || !/^[ \t]*Do you want to proceed\?[ \t]*$/m.test(pane)
      || !/^[ \t]*Esc to cancel\b/m.test(pane)) return null;
    const card = selectionCard(pane, "Claude Code");
    return card && card.options.some(option => /^Yes\b/.test(option.title)) ? card : null;
  };
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
      return trustScope(dialog);
    }),
    getRuntimeDialogs: () => [...originalRuntime().map(trustScope), ...(provider === "claude-code" ? [{
      // Windows uses a PowerShell permission shape distinct from the audited four-choice Unix Bash card. Never
      // auto-answer it: expose its actual numbered choices through the ordinary stepwise human-card path.
      pattern: /^[ \t]*Do you want to proceed\?[ \t]*$/m, isActive: (pane: string) => shellCard(pane) !== null,
      // The request's own identity (as the Linux Bash card's is), not the whole pane: a repainted status row is the same
      // request, so its episode and parked clock are not restarted by every capture.
      remoteCard: shellCard, requestIdentity: (pane: string) => shellCard(pane)?.identity ?? null,
      interactionKind: "permission" as const, keys: [], holdOnly: true, blocksDelivery: true,
      inputBlocked: true, description: "Claude Windows shell permission — waiting for a human choice, never auto-approving",
    }] : [])],
  });
  return backend;
}
