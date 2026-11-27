export type RoomPresence = "online" | "idle" | "working" | "paused" | "offline" | "later";
export type RoomSystemEvent = { kind: "room-created" | "member-joined" | "admin-joined" | "poll-closed" | "app-rate-limited"; name: string }
  | { kind:"purpose-changed";name:string;purpose:string }
  | { kind: "office-changed"; name: string; enabled: boolean }
  | { kind: "office-style-changed"; name: string; style: string }
  | { kind: "agent-mention-stopped"; reason: "all" | "ambiguous" | "depth" | "rate" | "capacity"; name: string; sourceId: string; retryAt?: number };
export interface RoomMessage {
  id: string; roomId: string; at: number;
  /** Committed group-room order; an answer receives its final position when it arrives. Older/direct rows may omit it. */
  sequence?: number;
  author: { kind: "person" | "agent" | "assistant" | "system"; id: string; name: string; owner?: { name: string }; agentKind?: "fleet" | "personal"; via?: { id: string; name: string; kind?: "app" | "agent" } };
  /** Structured viewer-localized system sentence; text remains a cached-client fallback. */
  system?: RoomSystemEvent;
  proactive?: true;
  text: string; mentions: string[]; replyTo?: string; idempotencyKey?: string;
  files?: { id: string; name: string; size: number; mime: string; url: string }[];
  warning?: "assistant-unavailable";
  ask?: { total: number; answered: number; working: number; later: number; failed?: number; blocked?: number; reason?: "share-needs-reshare" | "finished-without-answer" | "owner-stopped-sharing" | "expired" | "retired" | "unavailable" | "interrupted" | "unknown" };
  answerTo?: string;
  /** A completed reaction has no text bubble and is never a pending worker. */
  acknowledgedByReaction?: true;
  /** The immediate question's person-member id (same identity as room.me.id), never an agent owner's id. */
  askedBy?: string;
  reasonCode?: "owner-declined" | "finished-without-answer" | "owner-stopped-sharing" | "share-needs-reshare";
  stage?: "queued" | "working" | "answered" | "not-answered";
  /** M-3596, a 1:1 room's open question (its answer row, no text yet): when the agent got it; else how many came first. */
  startedAt?: number; ahead?: number;
  /** M-3127: who reacted with what, oldest emoji first; `members` are room member ids (the viewer finds its own). */
  reactions?: { emoji: string; count: number; members: string[] }[];
  /** M-3127 B: an agent answer's buttons (its asker only) or poll (everyone in the room). */
  buttons?: import("./buttons.js").RoomButtonsView;
}
export interface RoomAssistantPort {
  available(): { enabled: boolean; backend: string | null; running: number; cap: number; state: "idle" | "busy" | "paused"; note?: string };
  ask(input: { roomId: string; roomName: string; messageId: string; asker: { name: string }; text: string;
    context: { author: string; text: string; at: number; repliedTo?: true }[] }): Promise<{ text: string }>;
  forget(roomId: string): void;
}
export interface RoomEvent {
  type: "message.added" | "message.updated" | "presence.changed" | "member.changed" | "room.changed" | "unread.changed" | "invitation.changed" | "pins.changed";
  roomId: string;
  data: Record<string, unknown>;
  /** A removed member receives only the removal marker, never subsequent room content. */
  removedPerson?: string;
  audiencePerson?: string;
  sequence?: number;
}
