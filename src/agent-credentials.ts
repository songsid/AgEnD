import { createHash } from "node:crypto";
import { dashboardFeaturesOffIn } from "./dashboard-permissions.js";
import { resolveToolSet } from "./tool-permissions.js";
import type { FleetConfig } from "./types.js";

/** An opaque, process-owned issuing generation; it is never supplied by an HTTP caller. */
export type AgentCredentialGeneration = Readonly<{ id: symbol }>;
type IssuedCredential = { generation: AgentCredentialGeneration; digest: string; policy: string };
const digest = (token: string): string => createHash("sha256").update(token).digest("hex");

/** The dispatch policy and destination identity, including inherited feature switches. */
export function agentCredentialPolicy(fleet: FleetConfig | null, name: string, classic = false): string | null {
  const instance = fleet?.instances && Object.hasOwn(fleet.instances, name) ? fleet.instances[name] : undefined;
  if (!instance && !classic) return null;
  return JSON.stringify([
    resolveToolSet(instance, name), dashboardFeaturesOffIn(fleet, name),
    instance?.working_directory ?? null, instance?.channel_id ?? null, instance?.topic_id ?? null,
    instance?.general_topic === true, classic,
  ]);
}

/**
 * Keeps issuing policy separate from the mutable config. Publishing a different policy retires the old
 * generation even if a later rollback returns to the same values. The CLI reads agent.token for each request;
 * renewing it here lets hot Settings changes take effect without waiting for a process restart.
 */
export class AgentCredentials {
  private readonly issued = new Map<string, IssuedCredential>();

  constructor(private readonly policy: (name: string) => string | null,
    private readonly renew: (name: string) => string | null) {}

  issue(name: string, token: string): void {
    this.invalidate(name);
    const policy = this.policy(name);
    if (policy === null || !token) return;
    this.issued.set(name, { generation: Object.freeze({ id: Symbol(name) }), digest: digest(token), policy });
  }

  invalidate(name: string): void { this.issued.delete(name); }

  observePolicies(): void {
    for (const name of [...this.issued.keys()]) this.observe(name);
  }

  private observe(name: string): void {
    const old = this.issued.get(name);
    if (!old) return;
    const policy = this.policy(name);
    if (policy === old.policy) return;
    // Invalidate before any filesystem operation. A failed renewal cannot revive the prior credential.
    this.invalidate(name);
    if (policy !== null) {
      const token = this.renew(name);
      if (token) this.issue(name, token);
    }
  }

  capture(name: string, token: string): AgentCredentialGeneration | null {
    // Also observes direct in-memory changes: request admission never lazily grants an old token new policy.
    this.observe(name);
    const issued = this.issued.get(name);
    return issued?.digest === digest(token) ? issued.generation : null;
  }

  current(name: string, token: string, generation: AgentCredentialGeneration): boolean {
    return this.capture(name, token) === generation;
  }
}
