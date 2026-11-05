/** Member-local setup diagnostics only. They never grant readiness or carry an exception, path or credential. */
import { HubProtocolError } from "../validation.js";

export const HUB_PROVIDER_SETUP_REASONS = [
  "engine-unavailable", "engine-unsupported", "image-unconfigured", "image-mismatch", "credential-unconfigured", "unavailable",
] as const;
export type HubProviderSetupReason = typeof HUB_PROVIDER_SETUP_REASONS[number];
const reasons: ReadonlySet<string> = new Set(HUB_PROVIDER_SETUP_REASONS);
export function isHubProviderSetupReason(value: unknown): value is HubProviderSetupReason {
  return typeof value === "string" && reasons.has(value);
}
/** The protocol keeps its existing closed error code; this reason is local-owner presentation metadata. */
export class HubProviderSetupError extends HubProtocolError {
  constructor(readonly reason: HubProviderSetupReason) {
    super(reason === "engine-unsupported" || reason === "image-mismatch" ? "incompatible" : "unavailable");
  }
}
export function hubProviderSetupReason(error: unknown): HubProviderSetupReason | undefined {
  return error instanceof HubProviderSetupError && isHubProviderSetupReason(error.reason) ? error.reason : undefined;
}
