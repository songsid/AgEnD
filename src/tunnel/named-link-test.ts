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
 * With the admin's link already open on exactly these values, nothing is started: ② and ③ are the open link's own,
 * and ⑤ looks for its page's readiness marker instead (the open link is never stopped, replaced or shared).
 *
 * Only closed step codes leave this module. The token is put in the child's environment (never argv), its output is
 * kept private and bounded and read for a closed classification only, and the child is always stopped.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { lookup, Resolver } from "node:dns/promises";
import type { ChildProcess } from "node:child_process";
import { spawn } from "../child-process.js";
import { publicTunnelHostname, normalizePublicTunnelToken } from "../public-tunnel-config.js";
import { minimalChildEnv, type CloudflaredProtocol } from "./cloudflared.js";
import { classifyNamedTunnelOutput, classifyNamedTunnelProbeError } from "./named-diagnostics.js";
import { fetchViaPublicResolver, fetchViaSystemResolver, isPublicIPv4, PUBLIC_RESOLVERS, type ProbeResponse } from "./public-fetch.js";

export type NamedTestStep = "values" | "origin" | "tunnel" | "dns" | "reach";
export const NAMED_TEST_STEPS: readonly NamedTestStep[] = ["values", "origin", "tunnel", "dns", "reach"];
/** What each step found; the page words each one (and what to do next) in the person's language. */
export type NamedTestCode =
  | "ok" | "live"
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
export interface NamedTestResult { steps: NamedTestStepResult[]; hostname: string | null; port: number | null }
export interface NamedTestInput { hostname: unknown; port: unknown; protocol: unknown; token: string | null | undefined }

/** Cloudflare's own "no connector / origin unreachable" answers (502 Bad gateway, 503, 530 incl. error 1033). */
const WRONG_SERVICE_STATUSES = new Set([502, 503, 504, 530]);
const REGISTERED = /\bRegistered tunnel connection\b/i;
const MAX_OUTPUT = 64 * 1024;
export const NAMED_TEST_REGISTER_MS = 20_000;
export const NAMED_TEST_REACH_MS = 20_000;
/** The whole test, whatever happens: spawn, waits and teardown included. */
export const NAMED_TEST_HARD_MS = 60_000;

export interface NamedLinkTestDeps {
  /** The dashboard's own port: never the tunnel's origin. */
  healthPort: number;
  /** The bundled cloudflared's path (may fetch the pinned copy). */
  ensureBinary(signal: AbortSignal): Promise<string>;
  /** The open link on exactly these values: its page's readiness marker. Null: none (or other values). */
  liveMarker(values: { hostname: string; port: number; token: string }): string | null;
  /** Holds the one tunnel lane for the test; null when a link or a sign-in tunnel holds it. `open` says which. */
  reserve(): { release(): void } | { busy: "link-open" | "other" };
  spawnProcess?: typeof spawn;
  env?: NodeJS.ProcessEnv;
  /** Test seams. */
  resolve4?: (host: string) => Promise<string[]>;
  systemLookup?: (host: string) => Promise<unknown>;
  fetchPage?: (url: string, signal: AbortSignal) => Promise<ProbeResponse>;
  bindHost?: string;
  registerMs?: number;
  reachMs?: number;
  retryMs?: number;
  stopGraceMs?: number;
}

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
  const hard = setTimeout(() => abort.abort(), NAMED_TEST_HARD_MS);
  const onOuter = () => abort.abort();
  outer?.addEventListener("abort", onOuter, { once: true });
  let server: Server | null = null, child: ChildProcess | null = null, lane: { release(): void } | null = null;
  try {
    // The admin's link is open on exactly these values: test it as it is.
    const marker = deps.liveMarker({ hostname, port, token });
    if (marker) {
      pass("origin", "live"); pass("tunnel", "live");
      const dns = await resolveStep(hostname, deps);
      if (dns !== "ok") return fail("dns", dns);
      pass("dns");
      const reach = await reachStep(`https://${hostname}/signin`, marker, true, deps, abort.signal);
      return reach === "ok" ? (pass("reach"), { steps, hostname, port }) : fail("reach", reach);
    }
    if (port === deps.healthPort) return fail("origin", "dashboard-port");
    const held = deps.reserve();
    if ("busy" in held) return fail("origin", held.busy === "link-open" ? "link-open-other" : "tunnel-busy");
    lane = held;

    // ② origin — a stand-in that answers every request with this test's nonce, and nothing else.
    const nonce = randomBytes(16).toString("hex");
    const page = `<!doctype html><title>AgEnD</title><p>agend-named-test ${nonce}</p>`;
    server = createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(req.method === "HEAD" ? undefined : page); });
    const bound = await new Promise<NamedTestCode>(resolve => {
      server!.once("error", (err: NodeJS.ErrnoException) => resolve(err?.code === "EADDRINUSE" || err?.code === "EACCES" ? "port-in-use" : "origin-failed"));
      server!.listen(port, deps.bindHost ?? "127.0.0.1", () => resolve("ok"));
    });
    if (bound !== "ok") { server = null; return fail("origin", bound); }
    pass("origin");

    // ③ tunnel — a test connector of the same tunnel, registered or not within the budget.
    let binary: string;
    try { binary = await deps.ensureBinary(abort.signal); } catch { return fail("tunnel", "no-binary"); }
    const spawnProcess = deps.spawnProcess ?? spawn;
    let output = "";
    const registered = await new Promise<NamedTestCode>(resolve => {
      let settled = false;
      const done = (code: NamedTestCode) => { if (!settled) { settled = true; clearTimeout(timer); abort.signal.removeEventListener("abort", aborted); resolve(code); } };
      const classify = (): NamedTestCode => {
        const kind = classifyNamedTunnelOutput(output, token);
        return kind === "named-auth-failed" ? "auth" : "network";
      };
      const timer = setTimeout(() => done(classify()), deps.registerMs ?? NAMED_TEST_REGISTER_MS);
      const aborted = () => done("network");
      abort.signal.addEventListener("abort", aborted, { once: true });
      try {
        child = spawnProcess(binary, ["tunnel", "--no-autoupdate", "--config", "/dev/null", ...(protocol === "auto" ? [] : ["--protocol", protocol]), "run"], {
          shell: false, env: { ...minimalChildEnv(deps.env ?? process.env), TUNNEL_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"],
        });
      } catch { done("stopped"); return; }
      const absorb = (chunk: Buffer | string) => {
        output = (output + String(chunk)).slice(-MAX_OUTPUT);
        if (REGISTERED.test(output)) done("ok");
        else if (classifyNamedTunnelOutput(output, token) === "named-auth-failed") done("auth");
      };
      child.stdout?.on("data", absorb); child.stderr?.on("data", absorb);
      child.stdout?.on("error", () => {}); child.stderr?.on("error", () => {});
      child.once("error", () => done("stopped"));
      child.once("exit", () => setTimeout(() => {
        const kind = classifyNamedTunnelOutput(output, token);
        done(REGISTERED.test(output) ? "ok" : kind === "named-auth-failed" ? "auth" : kind === "named-connection-failed" ? "network" : "stopped");
      }, 50));
    });
    output = "";                                                   // nothing of it is kept past the classification
    if (registered !== "ok") return fail("tunnel", registered);
    pass("tunnel");

    // ④ dns, ⑤ reach — through a public resolver, as a phone elsewhere would.
    const dns = await resolveStep(hostname, deps);
    if (dns !== "ok") return fail("dns", dns);
    pass("dns");
    const reach = await reachStep(`https://${hostname}/agend-named-test-${nonce.slice(0, 8)}`, `agend-named-test ${nonce}`, false, deps, abort.signal);
    return reach === "ok" ? (pass("reach"), { steps, hostname, port }) : fail("reach", reach);
  } finally {
    clearTimeout(hard);
    outer?.removeEventListener("abort", onOuter);
    if (child) await stopChild(child, deps.stopGraceMs ?? 3_000);
    if (server) await new Promise<void>(r => { server!.close(() => r()); server!.closeAllConnections?.(); });
    lane?.release();
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
      const res = await fetchPage(url, attempt.signal);
      if (res.status === 200 && res.body.includes(expected)) return "ok";
      last = res.status === 200 ? "other-page" : res.status === 404 ? "route-missing" : WRONG_SERVICE_STATUSES.has(res.status) ? "wrong-service" : "reach-failed";
      // The open link's page may be served by another of the tunnel's connectors; any 200 there is its page.
      if (live && res.status === 200) return "other-page";
    } catch (err) {
      const kind = classifyNamedTunnelProbeError(err, "");
      last = kind === "named-route-missing" ? "route-missing" : kind === "named-connection-failed" ? "self-unreachable" : "reach-failed";
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    }
    await new Promise(r => setTimeout(r, deps.retryMs ?? 1_000));
  }
  return last;
}

/** SIGTERM, then SIGKILL; resolves once the child has exited (or after both budgets, which a live child cannot outlast). */
async function stopChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(r => child.once("exit", () => r()));
  const within = (ms: number) => Promise.race([exited.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), ms))]);
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  if (await within(graceMs)) return;
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
  await within(graceMs);
}
