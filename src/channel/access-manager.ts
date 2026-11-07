import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { AccessConfig } from "../types.js";

interface AccessState {
  mode?: "pairing" | "locked" | "open";
  allowed_users: (number | string)[];
}

export class AccessManager {
  private config: AccessConfig;
  private statePath: string;
  private state: AccessState;
  /**
   * The mode that came out of the state file, or undefined when the file had
   * none. Kept separately because the constructor fills `state.mode` in from
   * the config when the file is silent, after which the two are indistinguishable.
   */
  private persistedMode?: "pairing" | "locked" | "open";

  constructor(config: AccessConfig, statePath: string) {
    this.config = config;
    this.statePath = statePath;

    // Load persisted state or start fresh
    if (existsSync(statePath)) {
      try {
        const raw = readFileSync(statePath, "utf8");
        const saved = JSON.parse(raw) as Partial<AccessState>;
        // Legacy pending_codes are inert. Only already-granted users and the saved mode survive.
        this.persistedMode = saved.mode;
        this.state = {
          mode: saved.mode,
          allowed_users: saved.allowed_users ?? [],
        };
      } catch {
        this.state = { allowed_users: [] };
      }
    } else {
      this.state = { allowed_users: [] };
    }

    // Merge config's allowed_users with saved ones (deduplicated, normalized to string)
    const merged = new Set([...this.state.allowed_users, ...config.allowed_users].map(String));
    this.state.allowed_users = Array.from(merged);

    // If saved state has no mode, use config mode
    if (this.state.mode === undefined) {
      this.state.mode = config.mode;
    }
  }

  private persist(): void {
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  isAllowed(userId: number | string): boolean {
    if (this.getMode() === "open") return true;
    const key = String(userId);
    return this.state.allowed_users.some(u => String(u) === key);
  }

  setMode(mode: "pairing" | "locked" | "open"): void {
    this.state.mode = mode;
    this.persist();
  }

  getMode(): "pairing" | "locked" | "open" {
    return this.state.mode ?? this.config.mode;
  }

  /**
   * The configured mode that the state file is overriding, or null when they
   * agree or nothing was persisted.
   *
   * State wins on purpose — a saved access change must survive a
   * fleet restart — but the first `persist()` freezes whatever the mode was at
   * the time, and from then on editing `access.mode` in fleet.yaml changes
   * nothing. Without this, that reads as "my config edit did nothing" with no
   * way to find out why.
   *
   * Reported rather than logged from here: the CLI also builds an AccessManager
   * with a synthetic config, where a mismatch means nothing.
   */
  overriddenConfigMode(): "pairing" | "locked" | "open" | null {
    if (this.persistedMode === undefined) return null;
    return this.persistedMode === this.config.mode ? null : this.config.mode;
  }

  getAllowedUsers(): (number | string)[] {
    return [...this.state.allowed_users];
  }

  removeUser(userId: number | string): boolean {
    const key = String(userId);
    const idx = this.state.allowed_users.findIndex(u => String(u) === key);
    if (idx === -1) {
      return false;
    }
    this.state.allowed_users.splice(idx, 1);
    this.persist();
    return true;
  }
}
