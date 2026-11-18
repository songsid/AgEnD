/** M-3339 wire contract. All identities and origins are resolved by the server. */
export interface ContactPerson {
  platform: "discord" | "telegram" | "host";
  adapterId: string;
  userId: string;
  label: string;
}

export type ContactVerb = "send_to_instance" | "delegate_task" | "request_information" | "broadcast" | "report_result";
export type ContactTicketState = "pending" | "approved" | "delivered" | "declined" | "expired" | "unknown";
export interface ContactGuardStatus {
  state: "ready" | "restart-required" | "not-covered" | "failed";
  backend: string;
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
  deliveryId?: string;
  /** Contact delivery, never a claim that the target completed its task. */
  reason?: string;
  canDecide: boolean;
}
export interface ContactHistoryRow {
  id: string;
  at: string;
  actor: ContactPerson;
  action: "policy" | "approve" | "decline" | "grant-add" | "grant-remove";
  ticketId?: string;
  summary: string;
}
export interface ContactPermissions {
  instance: string;
  revision: number;
  classicRoom: boolean;
  mode: "legacy" | "restricted";
  approvers: ContactPerson[];
  /** True when approvers are inherited from the target's owning adapter. */
  inheritedApprovers: boolean;
  nativeGuard: ContactGuardStatus;
  roomTools: ContactRoomTools;
  canManage: boolean;
  suggestRestricted: boolean;
  grants: ContactGrant[];
  history: ContactHistoryRow[];
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
  grant?: { expiresAt: string; remainingUses: number | null };
}
export interface ContactHeldResult {
  sent: false;
  held: true;
  authorization_id: string;
  authorization_state: ContactTicketState;
  message: string;
}

/** AgEnD tool ceiling, separate from room-configured public-read and MCP tools. */
export const CLASSIC_RESTRICTED_TOOLS: readonly string[] = Object.freeze([
  "reply", "react", "edit_message", "download_attachment", "close_poll",
  "list_instances", "describe_instance", "list_teams", "delivery_status",
  "send_to_instance", "delegate_task", "request_information", "broadcast", "report_result",
]);
