// Lazy, fixed local-owner copy only. Wire reasons are never rendered as exception text or translation keys.
const keys = new Map([
  ["engine-unavailable", "provider_engine-unavailable"],
  ["engine-unsupported", "provider_engine-unsupported"],
  ["image-unconfigured", "provider_image-unconfigured"],
  ["image-mismatch", "provider_image-mismatch"],
  ["credential-unconfigured", "provider_credential-unconfigured"],
  ["unavailable", "provider_unavailable"],
  ["provider-unavailable", "provider_unavailable"],
]);
export const guidanceFor = (reason) => keys.get(reason) ?? null;
