/** Mount-owned expiry work. The scheduler never grants authority or extends an assignment deadline. */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { HubTransportStore } from "../store.js";
import type { HubDirectory } from "../directory/types.js";
import { epoch, HubProtocolError, validated } from "../validation.js";
import { createHubRoleResourceEffects, type HubRoleResourceEffectsOptions } from "./effects.js";
import { createHubRoleExpirySettlement } from "./expiry.js";
import { createHubRoleWriter } from "./writer.js";

export interface HubRoleExpiryRuntimeOptions extends HubRoleResourceEffectsOptions {
  directory: HubDirectory;
  transport: Pick<HubTransportStore, "read" | "mutate">;
  refreshAuthorization(): void;
  warning?(code: "unavailable" | "conflict" | "expired"): void;
}

export function createHubRoleExpiryRuntime(options: HubRoleExpiryRuntimeOptions) {
  const { db, transport, current, refreshAuthorization } = options;
  const clock = options.now ?? Date.now, now = () => validated(epoch, clock());
  let closed = false, lost = false, started = false, dirty = false, warning = false;
  let timer: NodeJS.Timeout | null = null, flight: Promise<void> | null = null, closing: Promise<void> | null = null;
  const live = () => {
    if (closed || lost) return false;
    try { if (current() === true) return true; } catch { /* A lost owner never rearms. */ }
    lost = true;
    return false;
  };
  const effects = createHubRoleResourceEffects({ ...options, current: live });
  const advanceAuthorization = (database: Database.Database) => {
    if (database !== db || !db.inTransaction || !live()) throw new HubProtocolError("unavailable");
    transport.mutate({ at: now(), requestId: randomUUID(), actor: { kind: "local-host" }, action: "role.authorization-changed", result: "completed" },
      state => { state.revocationVersion++; });
  };
  const refresh = () => { changed(); return refreshAuthorization(); };
  const common = { ...options, current: live, version: () => transport.read().revocationVersion, advanceAuthorization, refreshAuthorization: refresh };
  // This flight already replans after its own settlement; only external policy writes need changed().
  const settlement = createHubRoleExpirySettlement({ ...common, refreshAuthorization,
    effects: { snapshot: effects.write.snapshot, prepare: effects.prepareExpiry } });
  const writer = createHubRoleWriter({ ...common, effects: effects.write });
  const cancel = () => { if (timer) clearTimeout(timer); timer = null; };
  const warn = (code: "unavailable" | "conflict" | "expired") => {
    if (warning) return;
    warning = true;
    try { options.warning?.(code); } catch { /* Diagnostics cannot transfer physical ownership. */ }
  };
  const arm = (delay: number) => {
    cancel();
    if (!started || !live()) return;
    timer = setTimeout(() => { timer = null; void run(); }, Math.max(0, Math.min(2_147_483_647, delay)));
    timer.unref?.();
  };
  const plan = () => {
    cancel();
    if (!started || !live()) return;
    try {
      const deadline = settlement.nextDeadline();
      if (deadline !== null) arm(deadline - now());
      else warning = false;
    } catch { warn("unavailable"); arm(1000); }
  };
  const run = (): Promise<void> => {
    if (flight) return flight;
    let failed = false;
    // Publish ownership before callbacks in the actual settlement can re-enter.
    flight = Promise.resolve().then(async () => {
      if (!live()) return;
      const deadline = settlement.nextDeadline();
      if (deadline === null || deadline > now()) return;
      const result = await settlement.settle();
      if (!live()) return;
      if (!result.ok) { failed = true; warn(result.code); }
      else warning = false;
    }).catch(() => { failed = true; if (live()) warn("unavailable"); }).finally(() => {
      flight = null;
      if (!live()) return;
      if (dirty) { dirty = false; arm(0); }
      else if (failed) arm(1000);
      else plan();
    });
    return flight;
  };
  function changed() {
    if (!started || !live()) return;
    dirty = true;
    cancel();
    if (!flight) { dirty = false; arm(0); }
  }
  const fence = () => {
    if (closed) return;
    closed = true;
    cancel();
    writer.close();
    settlement.close();
    effects.close();
  };
  return {
    writer,
    start() {
      if (started || !live()) return;
      started = true;
      arm(0);
    },
    changed,
    fence,
    close(): Promise<void> {
      fence();
      // Never claim to abort or release a physical directory read by racing a timeout.
      return closing ??= Promise.resolve(flight).then(() => undefined);
    },
  };
}
