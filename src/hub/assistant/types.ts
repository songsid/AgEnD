/** Seam 4: the rooms service supplies this room's recent messages, never a Fleet conversation. */
export interface RoomAssistantAsk {
  roomId: string;
  roomName: string;
  messageId: string;
  asker: { name: string };
  text: string;
  context: Array<{ author: string; text: string; at: number }>;
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

/** A physically owned process/session. stop resolves only after it can no longer run or produce output. */
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
