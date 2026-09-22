import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { redactProviderError } from "./provider-probe.js";

export const SECRET_CHALLENGE_TTL_MS = 5 * 60_000;
export const SECRET_APPLY_RESULT = [
  "verified", "applying", "applied", "restart_required", "rolled_back", "rollback_failed",
] as const;
export type SecretApplyResult = typeof SECRET_APPLY_RESULT[number];

export interface ConnectionMetadata {
  id: string;
  type: "discord" | "telegram" | string;
  token_env: string;
  token_present: boolean;
  group_id: string | number | null;
  status: string;
  identity?: { id: string | null; username: string | null };
}

export interface SecretChallenge {
  id: string;
  connectionId: string;
  sessionBinding: string;
  generation: number;
  operation: "secret.apply";
  idempotencyKey: string;
  expiresAt: number;
  /** Kept only in memory until the apply job consumes it. */
  secret: string;
}

export interface SecretApplyJob {
  id: string;
  connectionId: string;
  idempotencyKey: string;
  result: SecretApplyResult;
  status: "running" | "done";
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export function requestSessionBinding(req: IncomingMessage): string {
  // The raw credential is never retained or logged. A digest is enough to bind
  // a challenge to the authenticated Settings session (or CLI header).
  const cookie = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
  const header = typeof req.headers["x-agend-token"] === "string" ? req.headers["x-agend-token"] : "";
  return createHash("sha256").update(`settings-session-v1\0${cookie}\0${header}`).digest("hex");
}

export function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

export function safeSecretError(error: unknown, secret?: string, additionalSecrets: readonly string[] = []): string {
  let message = redactProviderError(error, secret);
  for (const extra of additionalSecrets) {
    if (extra) message = redactProviderError(message, extra);
  }
  return message.replace(/[\r\n]/g, " ").slice(0, 180);
}
