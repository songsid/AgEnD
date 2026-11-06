/** Host Settings wire values only; no filesystem, key or runtime side effects on import. */
export interface HubBrowserCertificateInfo {
  fingerprint256: string;
  validFrom: string;
  validTo: string;
  selfSigned: boolean;
}
export interface HubBrowserCertificateView {
  revision: string;
  selected: HubBrowserCertificateInfo;
  activeFingerprint256: string | null;
  restartRequired: boolean;
}
export type HubBrowserCertificatePrepare = { mode: "generate"; revision: string }
  | { mode: "import"; revision: string; certificateFile: string; keyFile: string };
export interface HubBrowserCertificateApply { reference: string; revision: string }
export interface HubBrowserCertificateProposal extends HubBrowserCertificateApply { certificate: HubBrowserCertificateInfo }

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("invalid_browser_certificate");
  return input as Record<string, unknown>;
}
function revision(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function file(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0"); }
export function parseHubBrowserCertificatePrepare(input: unknown): HubBrowserCertificatePrepare {
  const p = record(input), keys = Object.keys(p).sort().join(",");
  if (!revision(p.revision)) throw Error("invalid_browser_certificate");
  if (p.mode === "generate" && keys === "mode,revision") return { mode: "generate", revision: p.revision };
  if (p.mode === "import" && keys === "certificateFile,keyFile,mode,revision" && file(p.certificateFile) && file(p.keyFile))
    return { mode: "import", revision: p.revision, certificateFile: p.certificateFile, keyFile: p.keyFile };
  throw Error("invalid_browser_certificate");
}
export function parseHubBrowserCertificateApply(input: unknown): HubBrowserCertificateApply {
  const p = record(input);
  if (Object.keys(p).sort().join(",") !== "reference,revision" || !revision(p.revision) || typeof p.reference !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(p.reference)) throw Error("invalid_browser_certificate");
  return { reference: p.reference, revision: p.revision };
}
