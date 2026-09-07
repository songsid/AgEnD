import type { ServiceState } from "./service-installer.js";

/**
 * `restartSystemdService()` returns false for both a definitive command error
 * and its five-minute Type=notify timeout. The latter can still finish and
 * start a healthy replacement, so callers must leave the cross-process marker
 * pending for that replacement instead of declaring failure.
 */
export const SYSTEMD_RESTART_INDETERMINATE_EXIT_CODE = 0;

export interface SystemdRestartSelectionInput {
  platform: "macos" | "linux";
  systemServiceInstalled: boolean;
  systemState: ServiceState;
  userServiceInstalled: boolean;
  userState: ServiceState;
}

export interface SystemdRestartTarget {
  unit: "agend" | "com.agend.fleet";
  user: boolean;
  state: ServiceState;
}

/**
 * Select the authoritative systemd unit before considering launchd or a
 * detached PID. This pure boundary is deliberately injectable in tests: a
 * chat-triggered full restart must never bypass an installed systemd unit and
 * fall back to a SIGUSR1/in-process replacement.
 */
export function selectSystemdRestartTarget(
  input: SystemdRestartSelectionInput,
): SystemdRestartTarget | null {
  if (input.platform === "macos") return null;
  if (input.systemServiceInstalled) {
    return { unit: "agend", user: false, state: input.systemState };
  }
  if (input.userServiceInstalled) {
    return { unit: "com.agend.fleet", user: true, state: input.userState };
  }
  return null;
}
