import { z } from "zod";
import { ContactDecisionSchema } from "./contact-auth-policy.js";
import type { ContactPerson, ContactTicket, ContactTicketDecision } from "./contact-auth-types.js";
import type { RequestContextActorV1, RequestContextV1 } from "./request-context-protocol.js";
/** Presentation only. No person, engine, authority or parent is accepted in a decision. */
export interface RequestContactCardV1 {
 version:1;engine:"legacy"|"request-v1";
 ticket:Pick<ContactTicket,"id"|"revision"|"state"|"source"|"target"|"verb"|"message"|"createdAt"|"expiresAt"|"decidedAt"|"deliveryId">;
 sourceLabel:string;targetLabel:string;requester:RequestContextActorV1|null;
 ingress:RequestContextV1["ingress"]|"legacy";
 sourceAudience:RequestContextV1["sourceAudience"]|null;returnAudience:RequestContextV1["sourceAudience"]|null;
 grantCandidates:Array<{key:string;label:string;platform:ContactPerson["platform"]}>;
 reason:string;continuedFrom?:string;approvalScope:"root-request"|"operation";authority:"none";
 snapshot:RequestContactSnapshotV1;
 actions:{canDecide:boolean;canGrant:boolean;requiresVerification:boolean};
}
export interface RequestContactSnapshotV1 {ticketRevision:number;policyRevision:number;imageSha256:string}
export interface RequestContactCardPageV1 {version:1;items:RequestContactCardV1[];nextCursor:string|null}
export interface RequestContactDecisionV1 {snapshot:RequestContactSnapshotV1;decision:ContactTicketDecision["decision"];grant?:ContactTicketDecision["grant"]}
export const RequestContactDecisionV1Schema=z.strictObject({
 snapshot:z.strictObject({ticketRevision:z.number().int().positive(),policyRevision:z.number().int().nonnegative(),imageSha256:z.string().regex(/^[a-f0-9]{64}$/)}),
 decision:ContactDecisionSchema.shape.decision,grant:ContactDecisionSchema.shape.grant,
}).refine(value=>!value.grant||value.decision==="approve-once");
/** Server-owned per-request evidence. Never serialized into a card or resolved from request body. */
export interface RequestContactPrincipal {person:ContactPerson;binding:string;verified:boolean;current():boolean}
export interface RequestContactListFilter {agent?:string;status?:ContactTicket["state"]|"all";cursor?:string}

export interface RequestContactNeedV1 {id:string;type:"contact";reason:"contact_request";instance:string;since:number;detail:string;contactTicket:{id:string;source:string;target:string}}
