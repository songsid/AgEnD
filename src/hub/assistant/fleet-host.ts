import { isAbsolute, join } from "node:path";
import { CLAUDE_ASSISTANT_MIN_VERSION, createClaudeAssistantHost } from "./claude-host.js";
import { RoomAssistantService } from "./service.js";
import { assistantStateStore } from "./store.js";
import type { AssistantBackendChoice, AssistantQuotaBand } from "./admin-types.js";
import type { RoomAssistantConfig } from "./types.js";

export interface AssistantHostFacts {
  binary: string | null;
  version: string | null;
  accounts: AssistantBackendChoice["accounts"];
}
export interface FleetAssistantOptions {
  fleetHome: string;
  /** Deployment configuration; does not change the selected account's home. */
  instanceHome: string;
  environment?: NodeJS.ProcessEnv;
  facts(): AssistantHostFacts;
  version(backend: "claude-code", binary: string): Promise<string | null>;
  quota?(config: RoomAssistantConfig): Promise<AssistantQuotaBand>;
}

function qualified(facts: AssistantHostFacts): boolean {
  const parts = facts.version?.split(".").map(Number), floor = CLAUDE_ASSISTANT_MIN_VERSION.split(".").map(Number);
  return !!facts.binary && isAbsolute(facts.binary) && !!facts.version && /^\d+\.\d+\.\d+$/.test(facts.version)
    && !!parts && (parts[0] > floor[0] || parts[0] === floor[0] && (parts[1] > floor[1] || parts[1] === floor[1] && parts[2] >= floor[2]));
}

/** One provider per mounted Hub generation. No worker is created until the room's first ask. */
export function createFleetRoomAssistant(options: FleetAssistantOptions): RoomAssistantService {
  return new RoomAssistantService({
    store: assistantStateStore(join(options.fleetHome, "hub-assistant")),
    backends: () => {
      const facts = options.facts();
      return qualified(facts) ? [{ id: "claude-code", name: "Claude", accounts: facts.accounts }] : [];
    },
    host: { async start(input) {
      const facts = options.facts();
      if (!qualified(facts)) throw new Error("Room assistant backend is unavailable");
      return createClaudeAssistantHost({ fleetHome: options.fleetHome, instanceHome: options.instanceHome,
        binary: facts.binary!, environment: options.environment, version: options.version }).start(input);
    } },
    quota: options.quota,
  });
}
