/** Informational installation inventory. Never used for admission, runtime authority or file removal. */
import { readPrivateFile } from "../private-files.js";
import type { HubIdentitySummary, HubInitPlan } from "./types.js";

export const HUB_INVENTORY_REL = "hub/install-inventory.json";
export const HUB_INVENTORY_PATHS = ["fleet.yaml", "hub/", "fleet.log"] as const;
export interface HubInstallationInventory {
  v: 1;
  purpose: "installation-record";
  recordedAt: string;
  hubId: string;
  webOrigin: string;
  memberOrigin: string;
  spkiSha256: string;
  coexistence: HubInitPlan["coexistence"];
  serviceLabel: "com.agend.fleet";
  paths: readonly string[];
}

export function hubInstallationInventory(plan: HubInitPlan, identity: HubIdentitySummary, recordedAt: string): HubInstallationInventory {
  // Select only public setup metadata. Never copy directory config, passwords, PEMs, imported paths or admin identity.
  return { v: 1, purpose: "installation-record", recordedAt, hubId: identity.hubId, webOrigin: plan.webOrigin,
    memberOrigin: plan.memberOrigin, spkiSha256: identity.spkiSha256, coexistence: plan.coexistence,
    serviceLabel: "com.agend.fleet", paths: [...HUB_INVENTORY_PATHS] };
}

function origin(value: unknown): value is string {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try { const u = new URL(value); return u.protocol === "https:" && u.origin === value && !u.username && !u.password; }
  catch { return false; }
}

export function readHubInstallationInventory(home: string): HubInstallationInventory {
  const x: HubInstallationInventory = JSON.parse(readPrivateFile(home, HUB_INVENTORY_REL, 8192));
  if (x?.v !== 1 || x.purpose !== "installation-record" || typeof x.recordedAt !== "string"
    || !Number.isFinite(Date.parse(x.recordedAt)) || new Date(x.recordedAt).toISOString() !== x.recordedAt
    || typeof x.hubId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(x.hubId)
    || !origin(x.webOrigin) || !origin(x.memberOrigin) || !/^[a-f0-9]{64}$/.test(x.spkiSha256)
    || !["dedicated", "same-user-pilot"].includes(x.coexistence) || x.serviceLabel !== "com.agend.fleet"
    || JSON.stringify(x.paths) !== JSON.stringify(HUB_INVENTORY_PATHS)) throw Error("invalid_hub_installation_inventory");
  return x;
}
