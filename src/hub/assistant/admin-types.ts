import type { RoomAssistantConfig } from "./types.js";

export type AssistantQuotaBand = "available" | "near_limit" | "exhausted" | "unknown";
export interface AssistantBackendChoice {
  id: string;
  name: string;
  accounts: Array<{ id: string | null; name: string; state: "signed-in" | "needs-sign-in" | "unknown" }>;
}
export interface AssistantInstanceView {
  roomId: string;
  roomName: string;
  state: "starting" | "working" | "idle" | "stopping" | "failed";
  lastUsed: number;
}
export interface AssistantAdminSettings extends RoomAssistantConfig {
  backends: AssistantBackendChoice[];
  running: AssistantInstanceView[];
}
export interface AssistantUsage {
  /** Seven UTC calendar days, oldest first, including zero-answer days. */
  days: Array<{ day: string; count: number }>;
  quota: { band: AssistantQuotaBand };
  note?: "usage-not-saved";
}
/** HTTP composition supplies its existing Hub-admin session and CSRF checks. No room messages are returned. */
export interface RoomAssistantAdmin {
  settings(): Promise<AssistantAdminSettings>;
  configure(value: unknown): Promise<AssistantAdminSettings>;
  usage(): Promise<AssistantUsage>;
  stopRoom(roomId: string): Promise<void>;
}

/** Created only for a mounted Hub; its physical workers drain before that mount can be replaced. */
export type ManagedRoomAssistant = import("./types.js").RoomAssistant & RoomAssistantAdmin & { close(): Promise<void> };
