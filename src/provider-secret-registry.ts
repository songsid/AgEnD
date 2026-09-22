import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import { redactProviderError } from "./provider-probe.js";

/**
 * The API-key registry is deliberately code-owned.  In particular, callers
 * select an id; they never select an URL, host, header name, or environment
 * variable.  That is what keeps this path a verifier rather than an SSRF
 * proxy with a nice UI.
 */
export type ProviderSecretActivation = "next_use" | "reload_hook";
export type ProviderSecretAuth = "bearer" | "x-api-key" | "anthropic";

export interface ProviderSecretVerifier {
  origin: `https://${string}`;
  path: string;
  auth: ProviderSecretAuth;
  timeoutMs: number;
  maxResponseBytes: number;
  expected(status: number, body: unknown): boolean;
}

export interface ProviderSecretSpec {
  id: string;
  kind: "api_key";
  envKey: string;
  displayName: string;
  allowedHosts: readonly string[];
  verifier?: ProviderSecretVerifier;
  activation: ProviderSecretActivation;
  reloadHookId?: string;
}

export interface ProviderSecretStatus {
  id: string;
  display_name: string;
  kind: "api_key";
  token_present: boolean;
  verifier: "available" | "unsupported";
  activation: ProviderSecretActivation;
  /** The browser may render this as a hint, but never receives the key. */
  stale_consumers: string[];
}

export type ProviderProbeResult =
  | { ok: true; status: "verified"; provider_status: number }
  | { ok: false; status: "unsupported_verifier" | "provider_rejected" | "provider_unavailable"; error?: string };

function jsonObject(body: unknown): body is Record<string, unknown> {
  return !!body && typeof body === "object" && !Array.isArray(body);
}

const modelList = (status: number, body: unknown): boolean => status >= 200 && status < 300 && jsonObject(body);

/** Initial registry.  xAI stays out until its endpoint/auth contract is fixed. */
export const PROVIDER_SECRET_SPECS: readonly ProviderSecretSpec[] = Object.freeze([
  {
    id: "groq.api_key",
    envKey: "GROQ_API_KEY",
    displayName: "Groq API key",
    kind: "api_key",
    allowedHosts: ["https://api.groq.com"],
    verifier: {
      origin: "https://api.groq.com",
      path: "/openai/v1/models",
      auth: "bearer",
      timeoutMs: 8_000,
      maxResponseBytes: 256 * 1024,
      expected: modelList,
    },
    activation: "reload_hook",
    reloadHookId: "groq.voice",
  },
  {
    id: "openai.api_key",
    envKey: "OPENAI_API_KEY",
    displayName: "OpenAI API key",
    kind: "api_key",
    allowedHosts: ["https://api.openai.com"],
    verifier: {
      origin: "https://api.openai.com",
      path: "/v1/models",
      auth: "bearer",
      timeoutMs: 8_000,
      maxResponseBytes: 256 * 1024,
      expected: modelList,
    },
    activation: "next_use",
  },
  {
    id: "anthropic.api_key",
    envKey: "ANTHROPIC_API_KEY",
    displayName: "Anthropic API key",
    kind: "api_key",
    allowedHosts: ["https://api.anthropic.com"],
    verifier: {
      origin: "https://api.anthropic.com",
      path: "/v1/models",
      auth: "anthropic",
      timeoutMs: 8_000,
      maxResponseBytes: 256 * 1024,
      expected: modelList,
    },
    activation: "next_use",
  },
].map(spec => Object.freeze({
  ...spec,
  allowedHosts: Object.freeze([...spec.allowedHosts]),
  verifier: spec.verifier ? Object.freeze({ ...spec.verifier }) : undefined,
})) as ProviderSecretSpec[]);

const RESERVED_ENV_KEYS = new Set(["PATH", "HOME", "PWD", "SHELL", "ENV", "BASH_ENV", "NODE_OPTIONS", "LD_PRELOAD"]);
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function providerSecretSpec(id: string): ProviderSecretSpec | undefined {
  return PROVIDER_SECRET_SPECS.find(spec => spec.id === id);
}

/** Validate immutable registry data at module load and in focused tests. */
export function validateProviderSecretRegistry(specs: readonly ProviderSecretSpec[] = PROVIDER_SECRET_SPECS): void {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const spec of specs) {
    if (ids.has(spec.id)) throw new Error("provider secret registry contains duplicate id");
    ids.add(spec.id);
    if (!ENV_KEY.test(spec.envKey) || RESERVED_ENV_KEYS.has(spec.envKey)) throw new Error("provider secret registry contains unsafe env key");
    if (keys.has(spec.envKey)) throw new Error("provider secret registry contains duplicate env key");
    keys.add(spec.envKey);
    for (const origin of spec.allowedHosts) {
      const parsed = new URL(origin);
      if (parsed.protocol !== "https:" || isIP(parsed.hostname) !== 0 || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
        throw new Error("provider secret registry contains unsafe origin");
      }
    }
    if (!spec.verifier) continue;
    const verifierOrigin = new URL(spec.verifier.origin);
    if (verifierOrigin.protocol !== "https:" || isIP(verifierOrigin.hostname) !== 0 || verifierOrigin.username || verifierOrigin.password || verifierOrigin.search || verifierOrigin.hash || verifierOrigin.pathname !== "/") {
      throw new Error("provider secret verifier contains unsafe origin");
    }
    if (!spec.allowedHosts.includes(spec.verifier.origin)) throw new Error("provider verifier origin is not allowlisted");
    if (!spec.verifier.path.startsWith("/") || spec.verifier.path.includes("?") || spec.verifier.path.includes("#") || spec.verifier.path.includes("\\")) {
      throw new Error("provider verifier contains unsafe path");
    }
    if (!Number.isFinite(spec.verifier.timeoutMs) || spec.verifier.timeoutMs <= 0 || !Number.isFinite(spec.verifier.maxResponseBytes) || spec.verifier.maxResponseBytes <= 0) {
      throw new Error("provider verifier limits are invalid");
    }
  }
}

validateProviderSecretRegistry();

export function validateSecretHeaderValue(secret: string): void {
  if (!secret || secret.length > 4096 || /[\r\n\0]/.test(secret) || /[^\x20-\x7e]/.test(secret)) {
    throw new Error("secret header value is invalid");
  }
}

function isPrivateAddress(address: string): boolean {
  address = address.toLowerCase();
  if (address.startsWith("::ffff:")) return isPrivateAddress(address.slice("::ffff:".length));
  if (address === "::1" || address === "0.0.0.0" || address === "::") return true;
  if (address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe8") || address.startsWith("fe9") || address.startsWith("fea") || address.startsWith("feb")) return true;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

export interface ProviderHttpResponse {
  status: number;
  body: unknown;
  /** Response text is redacted before it leaves this module. */
  detail?: string;
}

export interface ProviderHttpClient {
  request(spec: ProviderSecretSpec, secret: string): Promise<ProviderHttpResponse>;
}

function responseBodyText(response: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; response.destroy(); reject(new Error("provider response timeout")); } }, timeoutMs);
    timer.unref?.();
    response.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        clearTimeout(timer);
        response.destroy();
        reject(new Error("provider response exceeded limit"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    response.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    response.on("error", err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Direct HTTPS client. It deliberately does not use fetch/undici's ambient
 * proxy environment: the allowlisted provider is the only destination. DNS is
 * resolved once and the resulting address is returned on every lookup call,
 * preventing a check/connect TOCTOU window.
 */
export class FixedProviderHttpClient implements ProviderHttpClient {
  async request(spec: ProviderSecretSpec, secret: string): Promise<ProviderHttpResponse> {
    const verifier = spec.verifier;
    if (!verifier) throw new Error("unsupported verifier");
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("TLS verification is disabled");
    validateSecretHeaderValue(secret);
    const origin = new URL(verifier.origin);
    if (!spec.allowedHosts.includes(origin.origin)) throw new Error("provider origin is not allowlisted");
    const deadline = Date.now() + verifier.timeoutMs;
    const address = await Promise.race([
      dnsLookup(origin.hostname, { all: false, verbatim: true }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("provider DNS lookup timeout")), verifier.timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (!address?.address || isPrivateAddress(address.address)) throw new Error("provider address is not public");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (verifier.auth === "bearer") headers.Authorization = `Bearer ${secret}`;
    else if (verifier.auth === "x-api-key") headers["x-api-key"] = secret;
    else {
      headers["x-api-key"] = secret;
      headers["anthropic-version"] = "2023-06-01";
    }
    const requestOptions: RequestOptions = {
      protocol: "https:",
      hostname: origin.hostname,
      port: origin.port || 443,
      path: verifier.path,
      method: "GET",
      headers,
      rejectUnauthorized: true,
      servername: origin.hostname,
      // Explicitly bypass any agent/proxy supplied by ambient config.
      agent: false,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
    };
    const raw = await new Promise<{ response: IncomingMessage; body: string }>((resolve, reject) => {
      let settled = false;
      const remaining = Math.max(1, deadline - Date.now());
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        request.destroy(new Error("provider request timeout"));
        reject(new Error("provider request timeout"));
      }, remaining);
      timer.unref?.();
      const request = httpsRequest(requestOptions, response => {
        responseBodyText(response, verifier.maxResponseBytes, Math.max(1, deadline - Date.now())).then(body => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ response, body });
        }, error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
      });
      request.on("error", error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      request.end();
    });
    let body: unknown = null;
    try { body = JSON.parse(raw.body); } catch { body = raw.body; }
    // A redirect is never followed by this client. It is classified as
    // unavailable by verifyProviderSecret, regardless of Location contents.
    return { status: raw.response.statusCode ?? 0, body, detail: redactProviderError(raw.body, secret) };
  }
}

export async function verifyProviderSecret(
  spec: ProviderSecretSpec | undefined,
  secret: string,
  client: ProviderHttpClient = new FixedProviderHttpClient(),
): Promise<ProviderProbeResult> {
  if (!spec?.verifier) return { ok: false, status: "unsupported_verifier" };
  try {
    const response = await client.request(spec, secret);
    if (response.status >= 200 && response.status < 300 && spec.verifier.expected(response.status, response.body)) {
      return { ok: true, status: "verified", provider_status: response.status };
    }
    if (response.status === 401 || response.status === 403) return { ok: false, status: "provider_rejected" };
    return { ok: false, status: "provider_unavailable", error: safeProviderDetail(response.detail, secret) };
  } catch (error) {
    return { ok: false, status: "provider_unavailable", error: safeProviderDetail(redactProviderError(error, secret), secret) };
  }
}

function safeProviderDetail(detail?: string, secret?: string): string | undefined {
  if (!detail) return undefined;
  return redactProviderError(detail, secret)
    .replace(/(?:Bearer|x-api-key|api-key|authorization)\s*[:=]?\s*[^\s,;]+/gi, "$1: [redacted]")
    .slice(0, 180);
}

export function providerRegistryEnvKeys(): Set<string> {
  return new Set(PROVIDER_SECRET_SPECS.map(spec => spec.envKey));
}

export function isReservedProviderEnvKey(key: string): boolean {
  return RESERVED_ENV_KEYS.has(key);
}
