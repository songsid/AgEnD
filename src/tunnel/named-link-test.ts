/**
 * The fixed-address "Test connection" (Settings → Access; the user, 2026-11-01): checks the named-tunnel values as
 * filled in, step by step, and says for each ✗ what the person can do next.
 *
 *   ① values   the hostname, the origin port and the connector token are well-formed
 *   ② origin   a stand-in answers on 127.0.0.1:<port> for this test (what Cloudflare's route must point to)
 *   ③ tunnel   a test connector (the bundled cloudflared, the token in its environment) registers with Cloudflare
 *   ④ dns      the hostname resolves through a public resolver
 *   ⑤ reach    an HTTPS request to the hostname comes back with this test's nonce (so it reached THIS AgEnD)
 *
 * With the admin's link already open on exactly these values (protocol included), nothing is started: ② and ③ are
 * the open link's own, and ⑤ looks for its page's readiness marker instead (the open link is never stopped, replaced
 * or shared).
 *
 * #2907 review: the connector is started through the one tunnel lane's managed start (the lease a crash leaves
 * recoverable, a stop proven by the process's fingerprint); the lane is given back only on a confirmed stop — an
 * unproven one is reported (`cleanup: "unconfirmed"`) and the lane stays held. Every stage races the hard deadline,
 * and nothing is started once it (or the admin's session) is gone. Only closed step codes leave this module: the
 * token goes into the connector's environment, never argv, and its output is read for a closed classification only.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { lookup, Resolver } from "node:dns/promises";
import { publicTunnelHostname, normalizePublicTunnelToken } from "../public-tunnel-config.js";
import { CloudflaredProvider, type CloudflaredOptions, type CloudflaredProtocol } from "./cloudflared.js";
import { classifyNamedTunnelProbeError } from "./named-diagnostics.js";
import { fetchViaPublicResolver, fetchViaSystemResolver, isPublicIPv4, PUBLIC_RESOLVERS, type ProbeResponse } from "./public-fetch.js";
import type { TunnelPurposeLane } from "./purpose-lane.js";
import type { TunnelProvider } from "./types.js";

export type NamedTestStep = "values" | "origin" | "tunnel" | "dns" | "reach";
export const NAMED_TEST_STEPS: readonly NamedTestStep[] = ["values", "origin", "tunnel", "dns", "reach"];
/** What each step found; the page words each one (and what to do next) in the person's language. */
export type NamedTestCode =
  | "ok" | "live"
  // any step: the hard deadline, or the admin's session ended
  | "timeout" | "cancelled"
  // ① values
  | "bad-hostname" | "bad-port" | "no-token" | "bad-token"
  // ② origin
  | "dashboard-port" | "port-in-use" | "origin-failed" | "link-open-other" | "tunnel-busy"
  // ③ tunnel
  | "auth" | "network" | "stopped" | "no-binary"
  // ④ dns
  | "dns-missing" | "dns-failed"
  // ⑤ reach
  | "wrong-service" | "other-page" | "route-missing" | "self-unreachable" | "reach-failed";
export interface NamedTestStepResult { step: NamedTestStep; ok: boolean; code: NamedTestCode }
export interface NamedTestResult {
  steps: NamedTestStepResult[];
  hostname: string | null;
  port: number | null;
  /** The test connector's stop could not be proven: it may still run (the lane stays held until it is resolved). */
  cleanup?: "unconfirmed";
}
export interface NamedTestInput { hostname: unknown; port: unknown; protocol: unknown; token: string | null | undefined }

/** Cloudflare's own "no connector / origin unreachable" answers (502 Bad gateway, 503, 530 incl. error 1033). */
const WRONG_SERVICE_STATUSES = new Set([502, 503, 504, 530]);
export const NAMED_TEST_REGISTER_MS = 20_000;
export const NAMED_TEST_REACH_MS = 20_000;
/** The whole test before cleanup, whatever happens. */
export const NAMED_TEST_HARD_MS = 60_000;
/** Cleanup's own allowance after the deadline: the managed stop (TERM, proof, KILL, proof) and closing the stand-in. */
export const NAMED_TEST_CLEANUP_MS = 15_000;

/** The test connector's lane: started through the managed tunnel, given back only on a proven stop. */
export interface NamedTestLane {
  start(input: { binary: string; hostname: string; token: string; protocol: CloudflaredProtocol; origin: URL; signal: AbortSignal }): Promise<{ ok: true } | { ok: false; kind: string }>;
  stop(): Promise<{ confirmed: boolean }>;
  /** Nothing was started: give the lane back. */
  releaseUnused(): void;
}
export interface NamedLinkTestDeps {
  /** The dashboard's own port: never the tunnel's origin. */
  healthPort: number;
  /** The bundled cloudflared's path (may fetch the pinned copy). */
  ensureBinary(signal: AbortSignal): Promise<string>;
  /** The open link on exactly these values: its page's readiness marker. Null: none (or other values). */
  liveMarker(values: { hostname: string; port: number; token: string; protocol: CloudflaredProtocol }): string | null;
  /** Holds the one tunnel lane for the test, or says who holds it. */
  reserve(): NamedTestLane | { busy: "link-open" | "other" };
  /** The admin who asked is still signed in (checked before anything is started). */
  current?(): boolean;
  /** Test seams. */
  resolve4?: (host: string) => Promise<string[]>;
  systemLookup?: (host: string) => Promise<unknown>;
  fetchPage?: (url: string, signal: AbortSignal) => Promise<ProbeResponse>;
  bindHost?: string;
  hardMs?: number;
  cleanupMs?: number;
  reachMs?: number;
  retryMs?: number;
}

const DEADLINE = Symbol("deadline");
/** A step that threw (not a closed answer): its own closed failure. */
const UNEXPECTED: Record<NamedTestStep, NamedTestCode> = { values: "bad-token", origin: "origin-failed", tunnel: "stopped", dns: "dns-failed", reach: "reach-failed" };
/** `p`, unless the signal fires first (then DEADLINE); `p` itself is left to settle on its own. */
function within<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { p.catch(() => {}); return Promise.reject(DEADLINE); }
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(DEADLINE);
    signal.addEventListener("abort", stop, { once: true });
    p.then(v => { signal.removeEventListener("abort", stop); resolve(v); }, e => { signal.removeEventListener("abort", stop); reject(e); });
  });
}
const settleWithin = <T>(p: Promise<T>, ms: number): Promise<T | typeof DEADLINE> =>
  Promise.race([p, new Promise<typeof DEADLINE>(r => setTimeout(() => r(DEADLINE), ms).unref?.())]);

export async function runNamedLinkTest(input: NamedTestInput, deps: NamedLinkTestDeps, outer?: AbortSignal): Promise<NamedTestResult> {
  const steps: NamedTestStepResult[] = [];
  const pass = (step: NamedTestStep, code: NamedTestCode = "ok") => { steps.push({ step, ok: true, code }); };
  const fail = (step: NamedTestStep, code: NamedTestCode): NamedTestResult => { steps.push({ step, ok: false, code }); return { steps, hostname, port }; };

  // ① values — nothing runs on a value that could not be used.
  const hostname = publicTunnelHostname(typeof input.hostname === "string" ? input.hostname.trim() : input.hostname);
  const portRaw = typeof input.port === "string" && input.port.trim() !== "" ? Number(input.port) : input.port;
  const port = Number.isInteger(portRaw) && (portRaw as number) >= 1024 && (portRaw as number) <= 65535 ? portRaw as number : null;
  if (!hostname) return fail("values", "bad-hostname");
  if (port === null) return fail("values", "bad-port");
  if (!input.token) return fail("values", "no-token");
  const token = normalizePublicTunnelToken(input.token);
  if (!token) return fail("values", "bad-token");
  pass("values");
  const protocol: CloudflaredProtocol = input.protocol === "quic" || input.protocol === "auto" ? input.protocol : "http2";

  const abort = new AbortController();
  const hard = setTimeout(() => abort.abort(), deps.hardMs ?? NAMED_TEST_HARD_MS);
  const onOuter = () => abort.abort();
  outer?.addEventListener("abort", onOuter, { once: true });
  const signal = abort.signal;
  /** Before anything is started: the deadline has not passed and the admin who asked is still signed in. */
  const gone = (): NamedTestCode | null => signal.aborted ? "timeout" : deps.current && !deps.current() ? "cancelled" : null;
  let server: Server | null = null, lane: NamedTestLane | null = null, started = false;
  let result: NamedTestResult;
  let step: NamedTestStep = "origin";
  try {
    result = await (async (): Promise<NamedTestResult> => {
      // The admin's link is open on exactly these values: test it as it is.
      const marker = deps.liveMarker({ hostname, port, token, protocol });
      if (marker) {
        pass("origin", "live"); pass("tunnel", "live");
        step = "dns";
        const dns = await within(resolveStep(hostname, deps), signal);
        if (dns !== "ok") return fail("dns", dns);
        pass("dns");
        step = "reach";
        const reach = await within(reachStep(`https://${hostname}/signin`, marker, true, deps, signal), signal);
        return reach === "ok" ? (pass("reach"), { steps, hostname, port }) : fail("reach", reach);
      }
      if (port === deps.healthPort) return fail("origin", "dashboard-port");
      const stop = gone(); if (stop) return fail("origin", stop);
      const held = deps.reserve();
      if ("busy" in held) return fail("origin", held.busy === "link-open" ? "link-open-other" : "tunnel-busy");
      lane = held;

      // ② origin — a stand-in that answers every request with this test's nonce, and nothing else.
      const nonce = randomBytes(16).toString("hex");
      const page = `<!doctype html><title>AgEnD</title><p>agend-named-test ${nonce}</p>`;
      const stand = createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(req.method === "HEAD" ? undefined : page); });
      server = stand;
      const bound = await within(new Promise<NamedTestCode>(resolve => {
        stand.once("error", (err: NodeJS.ErrnoException) => resolve(err?.code === "EADDRINUSE" || err?.code === "EACCES" ? "port-in-use" : "origin-failed"));
        stand.listen(port, deps.bindHost ?? "127.0.0.1", () => resolve("ok"));
      }), signal);
      if (bound !== "ok") { server = null; return fail("origin", bound); }
      pass("origin");

      // ③ tunnel — a test connector of the same tunnel, through the lane's managed start.
      step = "tunnel";
      let binary: string;
      try { binary = await within(deps.ensureBinary(signal), signal); }
      catch (err) { if (err === DEADLINE) throw err; return fail("tunnel", "no-binary"); }
      const late = gone(); if (late) return fail("tunnel", late);
      started = true;
      const connector = await within(lane.start({ binary, hostname, token, protocol, origin: new URL(`http://127.0.0.1:${port}`), signal }), signal);
      if (!connector.ok) return fail("tunnel", tunnelCode(connector.kind, signal));
      pass("tunnel");

      // ④ dns, ⑤ reach — through a public resolver, as a phone elsewhere would.
      step = "dns";
      const dns = await within(resolveStep(hostname, deps), signal);
      if (dns !== "ok") return fail("dns", dns);
      pass("dns");
      step = "reach";
      const reach = await within(reachStep(`https://${hostname}/agend-named-test-${nonce.slice(0, 8)}`, `agend-named-test ${nonce}`, false, deps, signal), signal);
      return reach === "ok" ? (pass("reach"), { steps, hostname, port }) : fail("reach", reach);
    })();
  } catch (err) {
    // #2907 review (r2): nothing thrown escapes before the cleanup below — the deadline is "timeout" (or "cancelled"),
    // anything else (a lease write refused, an unexpected error) is the step's closed failure; never a raw error.
    result = fail(step, err === DEADLINE ? (outer?.aborted ? "cancelled" : "timeout") : UNEXPECTED[step]);
  } finally {
    clearTimeout(hard);
    outer?.removeEventListener("abort", onOuter);
    // Cleanup, unconditionally and with its own allowance: what was started goes through the lane's managed stop
    // (which gives the lane back only on a proven stop); the stand-in closes on every outcome.
    const cleanupMs = deps.cleanupMs ?? NAMED_TEST_CLEANUP_MS;
    let unconfirmed = false;
    if (lane) {
      const held: NamedTestLane = lane;
      if (started) {
        const stopped = await settleWithin(held.stop().catch(() => ({ confirmed: false })), cleanupMs);
        unconfirmed = stopped === DEADLINE || !stopped.confirmed;
      } else held.releaseUnused();
    }
    if (server) {
      const stand: Server = server;
      await settleWithin(new Promise<void>(r => { stand.close(() => r()); stand.closeAllConnections?.(); }), cleanupMs);
    }
    if (unconfirmed) result!.cleanup = "unconfirmed";
  }
  return result;
}

/** ③'s closed codes from the managed start's error kinds. */
function tunnelCode(kind: string, signal: AbortSignal): NamedTestCode {
  switch (kind) {
    case "named-auth-failed": return "auth";
    case "named-connection-failed": case "timeout": return "network";
    case "cancelled": return signal.aborted ? "timeout" : "stopped";
    case "lease-held": return "tunnel-busy";
    case "binary-missing": case "binary-not-executable": return "no-binary";
    default: return "stopped";
  }
}

/** ④: a public resolver's answer (what a phone elsewhere gets); the system's only when the public one cannot answer. */
async function resolveStep(hostname: string, deps: NamedLinkTestDeps): Promise<NamedTestCode> {
  try {
    const resolve4 = deps.resolve4 ?? ((h: string) => { const r = new Resolver({ timeout: 3_000, tries: 2 }); r.setServers([...PUBLIC_RESOLVERS]); return r.resolve4(h); });
    const addresses = await resolve4(hostname);
    return addresses.some(isPublicIPv4) ? "ok" : "dns-missing";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOTFOUND" || code === "ENODATA") return "dns-missing";
  }
  try { await (deps.systemLookup ?? ((h: string) => lookup(h)))(hostname); return "ok"; }
  catch (err) { return (err as NodeJS.ErrnoException)?.code === "ENOTFOUND" ? "dns-missing" : "dns-failed"; }
}

/** ⑤: retried until the budget ends (the edge takes a moment to learn a new connector); the last answer decides. */
async function reachStep(url: string, expected: string, live: boolean, deps: NamedLinkTestDeps, signal: AbortSignal): Promise<NamedTestCode> {
  const fetchPage = deps.fetchPage ?? ((u: string, s: AbortSignal) => fetchViaPublicResolver(u, s, { fallback: (v, t) => fetchViaSystemResolver(v, t) }));
  const deadline = performance.now() + (deps.reachMs ?? NAMED_TEST_REACH_MS);
  let last: NamedTestCode = "reach-failed";
  while (!signal.aborted && performance.now() < deadline) {
    const attempt = new AbortController();
    const stop = () => attempt.abort();
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, Math.max(1, Math.min(5_000, deadline - performance.now())));
    try {
      const res = await within(fetchPage(url, attempt.signal), attempt.signal);
      if (res.status === 200 && res.body.includes(expected)) return "ok";
      last = res.status === 200 ? "other-page" : res.status === 404 ? "route-missing" : WRONG_SERVICE_STATUSES.has(res.status) ? "wrong-service" : "reach-failed";
      // The open link's page may be served by another of the tunnel's connectors; any 200 there is its page.
      if (live && res.status === 200) return "other-page";
    } catch (err) {
      if (err !== DEADLINE) {
        const kind = classifyNamedTunnelProbeError(err, "");
        last = kind === "named-route-missing" ? "route-missing" : kind === "named-connection-failed" ? "self-unreachable" : "reach-failed";
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    }
    await new Promise(r => setTimeout(r, deps.retryMs ?? 1_000));
  }
  return last;
}

/**
 * The production lane: the one tunnel lane's reservation, the connector started by its managed start (lease, proven
 * stop) as a CloudflaredProvider that is ready once registered. `provider` is a test seam.
 */
export function namedTestLane(lane: TunnelPurposeLane, opts: { registerMs?: number; provider?: (o: CloudflaredOptions) => TunnelProvider } = {}): NamedLinkTestDeps["reserve"] {
  return () => {
    const id = `named-test-${randomBytes(6).toString("hex")}`;
    const reservation = lane.reserve("named-test", id);
    if (!reservation) return { busy: lane.holder() === "dashboard" ? "link-open" : "other" };
    return {
      async start(i) {
        const provider = (opts.provider ?? (o => new CloudflaredProvider(o)))({ binaryName: i.binary, protocol: i.protocol,
          named: { hostname: i.hostname, token: i.token }, registeredOnly: true, deadlineMs: opts.registerMs ?? NAMED_TEST_REGISTER_MS });
        const result = await reservation.start(provider, { sid: id, origin: i.origin, pagePath: "/", readinessMarker: id,
          expiresAt: Date.now() + NAMED_TEST_HARD_MS, signal: i.signal });
        return result.ok ? { ok: true } : { ok: false, kind: result.errorKind };
      },
      async stop() { return { confirmed: (await reservation.stop("named link test done")).confirmed }; },
      releaseUnused() { reservation.releaseUnused(); },
    };
  };
}
