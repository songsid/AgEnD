/**
 * Where initialization puts things, and the fleet.yaml keys it writes. Everything Hub-private lives under
 * <home>/hub (0700); key material under hub/keys is S1's (hub.md §4).
 */
import { join } from "node:path";
import type { RawConfigPatch } from "../../settings-api.js";
import type { HubIdentitySummary, HubInitPlan } from "./types.js";

export const HUB_DIR = "hub";
export const BIND_SECRET_REL = "hub/secrets/directory-bind";
export const BIND_PASSWORD_REF = `file:${BIND_SECRET_REL}`;

export function hubPaths(home: string) {
  const hub = join(home, HUB_DIR);
  return {
    hub,
    keys: join(hub, "keys"),
    initDir: join(hub, "init"),
    operation: join(hub, "init", "operation.json"),
    manifest: join(hub, "init-manifest.json"),
    inventory: join(hub, "install-inventory.json"),
    secrets: join(hub, "secrets"),
    bindSecret: join(home, BIND_SECRET_REL),
    webTlsDir: join(hub, "web-tls"),
    webCert: join(hub, "web-tls", "cert.pem"),
    webKey: join(hub, "web-tls", "key.pem"),
    fleetYaml: join(home, "fleet.yaml"),
  };
}

/** Resolve a bindPasswordRef the initializer wrote. Only the one private file scheme is accepted. */
export function bindSecretPath(home: string, ref: string): string | undefined {
  return ref === BIND_PASSWORD_REF ? join(home, BIND_SECRET_REL) : undefined;
}

/**
 * The hub.* settings, written with enabled: false. `enabled: true` is a separate, last patch (hub.md §5: "commits
 * hub.enabled last"). Paths are relative to the AgEnD home.
 */
export function hubConfigPatches(plan: HubInitPlan, identity: HubIdentitySummary): RawConfigPatch[] {
  return [
    { path: ["hub", "enabled"], value: false },
    { path: ["hub", "name"], value: plan.name },
    { path: ["hub", "hubId"], value: identity.hubId },
    { path: ["hub", "webOrigin"], value: plan.webOrigin },
    { path: ["hub", "memberOrigin"], value: plan.memberOrigin },
    { path: ["hub", "memberListen"], value: { host: plan.memberListen.host, port: plan.memberListen.port } },
    { path: ["hub", "webListen"], value: { host: plan.webListen.host, port: plan.webListen.port } },
    { path: ["hub", "webTls"], value: { ...WEB_TLS_CONFIG } },
    { path: ["hub", "directory"], value: { ...plan.directory, bindPasswordRef: plan.bindPasswordRef } },
    { path: ["hub", "administrator"], value: { realm: plan.administrator.realm, objectId: plan.administrator.objectId } },
    { path: ["hub", "retention"], value: { contentDays: plan.retention.contentDays, eventDays: plan.retention.eventDays } },
    { path: ["hub", "coexistence"], value: plan.coexistence },
  ];
}

/** The copied browser certificate, as hub.webTls names it (relative to the AgEnD home). */
export const WEB_TLS_CONFIG = { certificateFile: "hub/web-tls/cert.pem", keyFile: "hub/web-tls/key.pem" } as const;

export const ENABLE_PATCH: RawConfigPatch = { path: ["hub", "enabled"], value: true };
