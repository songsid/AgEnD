/** M-3339 wire contract. All identities and origins are resolved by the server. */
export interface ContactPerson {
  platform: "discord" | "telegram" | "host";
  /** Transport/proof routing only; authorization identity is platform + userId. */
  adapterId: string;
  userId: string;
  label: string;
}

export type ContactVerb = "send_to_instance" | "delegate_task" | "request_information" | "broadcast" | "report_result";
export type ContactTicketState = "pending" | "approved" | "delivered" | "declined" | "expired" | "unknown";
export interface ContactGuardStatus {
  state: "ready" | "restart-required" | "not-covered" | "failed";
  backend: string;
  version?: string;
  wouldDisable?: string[];
  impactComplete?: boolean;
  reason?: string;
}
export interface ContactRoomTool {
  /** Exact backend tool identity; no wildcard or command-fragment matching. */
  name: string;
  kind: "public-read" | "mcp";
  usesOwnerAccount: boolean;
  /** Server label, never a credential value. */
  accountWarning?: string;
}
export interface ContactRoomTools {
  /** Public WebSearch/WebFetch or the verified backend equivalents stay available. */
  publicRead: boolean;
  allowedMcpTools: ContactRoomTool[];
  /** Current tools that would stop if this legacy room switched. */
  wouldDisable: string[];
}
export interface ContactOrigin {
  /** Unknown and mixed origins never acquire admin authority from message text. */
  kind: "human" | "unknown" | "mixed";
  people: ContactPerson[];
  receiptIds: string[];
  /** Server-owned instance hops, oldest first; no authority is conveyed by labels. */
  chain: string[];
}
export interface ContactGrant {
  id: string;
  person: ContactPerson;
  source: string;
  target: string;
  sourceGeneration?: string;
  targetGeneration?: string;
  verbs: ContactVerb[];
  expiresAt: string;
  /** null means reusable until expiry, otherwise a remaining dispatch count. */
  remainingUses: number | null;
  createdBy: ContactPerson;
  createdAt: string;
}
export interface ContactTicket {
  id: string;
  revision: number;
  scope: "peer.dispatch";
  state: ContactTicketState;
  source: string;
  target: string;
  sourceGeneration: string;
  targetGeneration: string;
  verb: ContactVerb;
  origin: ContactOrigin;
  /** Visible only to an authorized approver or the source room's authorized admin. */
  message: string;
  requestHash: string;
  correlationId: string;
  resultRecipient: string;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: ContactPerson;
  grantId?: string;
  grantIds?: string[];
  deliveryId?: string;
  /** Contact delivery, never a claim that the target completed its task. */
  reason?: string;
  canDecide: boolean;
}
export interface ContactHistoryRow {
  id: string;
  at: string;
  actor: ContactPerson;
  action: "policy" | "approve" | "decline" | "grant-add" | "grant-remove" | "grant-use" | "origin-clear";
  ticketId?: string;
  summary: string;
  source?: string;
  target?: string;
  generation?: string;
  originChange?: { before: ContactOriginImage; after: ContactOriginImage };
  policyChange?: {
    approvers?: { before: ContactPerson[] | null; after: ContactPerson[] | null };
    grants?: { before: ContactGrant[]; after: ContactGrant[] };
    roomTools?: { before: ContactRoomTools; after: ContactRoomTools };
    modeRequested?: "legacy" | "restricted";
  };
}
export type ContactOriginImage = Pick<ContactOrigin, "kind" | "people" | "chain"> & { receiptCount: number };
export interface ContactOriginClear { revision: number; originRevision: number; generation: string }
export interface ContactOriginState {
  kind: ContactOrigin["kind"] | "none";
  people: ContactPerson[];
  chain: string[];
  receiptCount: number;
  revision: number;
  generation: string;
  canClear: boolean;
  lastCleared?: { actor: ContactPerson; at: string };
}
export interface ContactPermissions {
  instance: string;
  revision: number;
  classicRoom: boolean;
  mode: "legacy" | "restricted";
  approvers: ContactPerson[];
  /** Slice 1: only the target platform's configured Fleet admins (or verified host operator). */
  eligibleApprovers: ContactPerson[];
  /** True when approvers are inherited from Fleet admins on the target's platform. */
  inheritedApprovers: boolean;
  nativeGuard: ContactGuardStatus;
  roomTools: ContactRoomTools;
  canManage: boolean;
  canSetMode: boolean;
  suggestRestricted: boolean;
  grants: ContactGrant[];
  history: ContactHistoryRow[];
  originState?: ContactOriginState;
  originRestriction?: { active: true; reason: "earlier-non-admin" | "unknown-origin"; resetSupported: false };
}
export interface ContactPermissionsWrite {
  revision: number;
  mode?: "legacy" | "restricted";
  approvers?: ContactPerson[];
  roomTools?: Pick<ContactRoomTools, "publicRead" | "allowedMcpTools">;
  /** Replaces the contact table, with an explicit optimistic revision check. */
  grants?: Array<Pick<ContactGrant, "id" | "person" | "source" | "target" | "verbs" | "expiresAt" | "remainingUses">>;
}
export interface ContactTicketPage { items: ContactTicket[]; nextCursor: string | null }
export interface ContactTicketDecision {
  revision: number;
  decision: "approve-once" | "decline";
  /** Separate, explicit opt-in; never inferred from clicking Approve once. */
  grant?: { expiresAt: string; remainingUses: number | null;
    /** Explicit subset of this ticket’s server-owned originating people; absent keeps the legacy single-person contract. */
    personKeys?: string[] };
}
export interface ContactHeldResult {
  sent: false;
  held: true;
  authorization_id: string;
  authorization_state: ContactTicketState;
  message: string;
}
export interface ContactBadge { id: string; state: ContactTicketState }
/** SSE `contact-auth`: clients refresh their scoped list and affected detail. */
export interface ContactAuthEvent { instance: string; ticketId?: string; revision: number }

/** AgEnD tool ceiling, separate from room-configured public-read and MCP tools. */
export const CLASSIC_RESTRICTED_TOOLS: readonly string[] = Object.freeze([
  "reply", "react", "edit_message", "download_attachment", "close_poll",
  "list_instances", "describe_instance", "list_teams", "delivery_status",
  "send_to_instance", "delegate_task", "request_information", "broadcast", "report_result",
]);
