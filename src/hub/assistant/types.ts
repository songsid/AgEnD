export interface RoomAssistantContextMessage {
  author: string;
  text: string;
  at: number;
  /** The one replied-to room message may be older than the latest thirty. */
  repliedTo?: true;
}

/** Seam 4: the rooms service supplies this room's recent messages, never a Fleet conversation. */
export interface RoomAssistantAsk {
  roomId: string;
  roomName: string;
  messageId: string;
  asker: { name: string };
  text: string;
  context: RoomAssistantContextMessage[];
}

export interface RoomAssistantConfig {
  enabled: boolean;
  backend: string;
  account: string | null;
  cap: number;
  idleMinutes: number;
}

export const ROOM_ASSISTANT_DEFAULTS = Object.freeze({ cap: 3, idleMinutes: 15 });

export interface RoomAssistant {
  available(): {
    enabled: boolean;
    backend: string;
    running: number;
    cap: number;
    state: "idle" | "busy" | "paused";
    note?: string;
  };
  ask(input: RoomAssistantAsk): Promise<{ text: string }>;
  forget(roomId: string): void;
}

/** An owned room controller/session. stop resolves only after all its physical workers are gone. */
export interface RoomAssistantSession {
  ask(input: RoomAssistantAsk, signal: AbortSignal): Promise<{ text: string }>;
  stop(): Promise<void>;
}

export interface RoomAssistantHost {
  /** The adapter selects the configured backend/account and launches with ALL tools disabled. */
  start(input: {
    roomId: string;
    roomName: string;
    backend: string;
    account: string | null;
    signal: AbortSignal;
  }): Promise<RoomAssistantSession>;
}
