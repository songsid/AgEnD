export type RoomPresence = "online" | "idle" | "working" | "paused" | "offline" | "later";
export interface RoomMessage {
  id: string; roomId: string; at: number;
  author: { kind: "person" | "agent" | "assistant" | "system"; id: string; name: string; owner?: { name: string } };
  text: string; mentions: string[]; replyTo?: string; idempotencyKey?: string;
  files?: { id: string; name: string; size: number; mime: string; url: string }[];
  warning?: "assistant-unavailable";
  ask?: { total: number; answered: number; working: number; later: number };
  answerTo?: string;
  stage?: "queued" | "working" | "answered" | "not-answered";
}
/** Track A owns the shared service contract. */
export type RoomAssistantPort = import("../assistant/types.js").RoomAssistant;
export interface RoomEvent {
  type: "message.added" | "message.updated" | "presence.changed" | "member.changed" | "room.changed" | "unread.changed" | "invitation.changed";
  roomId: string;
  data: Record<string, unknown>;
  /** A removed member receives only the removal marker, never subsequent room content. */
  removedPerson?: string;
  audiencePerson?: string;
  sequence?: number;
}
