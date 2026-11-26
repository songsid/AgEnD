import type { RequestContextPolicyPort } from "./request-context-policy.js";
/** One exact launch's trusted preparation; file rendering and the pre-start C/D hook share this policy object. */
export interface RequestContextStartPreparation {
  readonly policy: RequestContextPolicyPort;
  current(): boolean;
}

/** Process-owned work identity; staging and durable rotation have the same explicit fresh-launch boundary. */
export interface RequestContextDaemonWork {
  current():boolean;
  identity():Readonly<{incarnation:string;workGeneration:string}>;
  fresh():void;
}
