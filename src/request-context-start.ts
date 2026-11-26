import type { RequestContextPolicyPort } from "./request-context-policy.js";
/** One exact launch's trusted preparation; file rendering and the pre-start C/D hook share this policy object. */
export interface RequestContextStartPreparation {
  readonly policy: RequestContextPolicyPort;
  current(): boolean;
}
