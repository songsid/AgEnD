export type RoomPresence = "online" | "idle" | "working" | "paused" | "offline" | "later";
export interface RoomSystemEvent { kind: "room-created" | "member-joined" | "admin-joined"; name: string }
export interface RoomMessage {
  id: string; roomId: string; at: number;
  /** Committed group-room order; an answer receives its final position when it arrives. Older/direct rows may omit it. */
  sequence?: number;
  author: { kind: "person" | "agent" | "assistant" | "system"; id: string; name: string; owner?: { name: string } };
  /** Structured viewer-localized system sentence; text remains a cached-client fallback. */
  system?: RoomSystemEvent;
  text: string; mentions: string[]; replyTo?: string; idempotencyKey?: string;
  files?: { id: string; name: string; size: number; mime: string; url: string }[];
  warning?: "assistant-unavailable";
  ask?: { total: number; answered: number; working: number; later: number };
  answerTo?: string;
  stage?: "queued" | "working" | "answered" | "not-answered";
}
export interface RoomAssistantPort {
  available(): { enabled: boolean; backend: string | null; running: number; cap: number; state: "idle" | "busy" | "paused"; note?: string };
  ask(input: { roomId: string; roomName: string; messageId: string; asker: { name: string }; text: string;
    context: { author: string; text: string; at: number; repliedTo?: true }[] }): Promise<{ text: string }>;
  forget(roomId: string): void;
}
export interface RoomEvent {
  type: "message.added" | "message.updated" | "presence.changed" | "member.changed" | "room.changed" | "unread.changed" | "invitation.changed";
  roomId: string;
  data: Record<string, unknown>;
  /** A removed member receives only the removal marker, never subsequent room content. */
  removedPerson?: string;
  audiencePerson?: string;
  sequence?: number;
}
