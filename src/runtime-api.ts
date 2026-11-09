/** Local administrator API for pairing and managing execution computers. */
import { remoteRuntimeEnabled } from "./runtime-switches.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBoundedWebBody } from "./web-body.js";
import { accountIdentityVisible, machineWithoutAccountIdentity, nativeCliAuthorization, probeWithoutAccountIdentity, remoteSetupActor, runtimePairingAdmin, type WindowsCliApiContext } from "./windows-cli-api.js";
import { INSTALLABLE_CLIS, isInstallableCli, type InstallableCliId } from "./runtime-cli-install.js";
import type { RuntimeSwitchStates } from "./runtime-protocol.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import { createRuntimeBundle } from "./runtime-bundle.js";
import type { RuntimeMachine } from "./runtime-protocol.js";
import type { WindowsCliProbe } from "./windows-cli.js";
import { validateNativeTask } from "./windows-cli-worker.js";
import { runtimeServerOrigin } from "./runtime-connection.js";
import type { RuntimeInstallService } from "./runtime-install.js";

export interface RuntimeApiContext extends WindowsCliApiContext { runtimeCoordinator?(): RuntimeCoordinator; runtimeInstaller?(): RuntimeInstallService }
/**
 * #3190 Part 3b: one CLI install the dashboard asked a computer for. Kept in memory only (never the journal, never a file): who asked, which CLI and
 * how it ended. The text is the Runtime's own refusal sentence (it carries no path, URL or output), or a fixed one of ours.
 */
export interface CliInstallJob { cli: InstallableCliId; state: "installing" | "done" | "failed"; startedAt: number; finishedAt?: number; version?: string; error?: string }
const INSTALL_DEADLINE_MS = 11 * 60_000;          // longer than the Runtime's own overall limit (CLI_INSTALL_TIMEOUT_MS, 10 minutes), so the Runtime's answer is the one shown
const installJobs = new WeakMap<RuntimeCoordinator, Map<string, CliInstallJob>>();
/** What `accounts.switches` must answer, checked here before it goes on to the browser: only these fields, and only these types. Null: not that. */
function switchStatesOf(value: unknown): RuntimeSwitchStates | null {
  const one = (entry: unknown): { on: boolean; until?: number } | null => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const { on, until } = entry as { on?: unknown; until?: unknown };
    if (typeof on !== "boolean" || (until !== undefined && (typeof until !== "number" || !Number.isFinite(until)))) return null;
    return { on, ...(until !== undefined ? { until: until as number } : {}) };
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const accounts = one((value as { accounts?: unknown }).accounts), install = one((value as { install?: unknown }).install);
  return accounts && install ? { accounts, install } : null;
}
/**
 * How long a POST waits to see whether the Runtime refuses at once. The refusals that matter (the owner's switch is off, an install the Runtime
 * will not take) come back from the computer in a few milliseconds over its connection, and a bare `setImmediate` is gone before they can: the page
 * got a 202 and only later a failed job. A run that is really under way is still answered 202 after this long, and followed through the job.
 */
const EARLY_ANSWER_MS = 1500;
const jobsOf = (hub: RuntimeCoordinator): Map<string, CliInstallJob> => { let jobs = installJobs.get(hub); if (!jobs) installJobs.set(hub, jobs = new Map()); return jobs; };
function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(value));
}
export function handleRuntimeRequest(req: IncomingMessage, res: ServerResponse, url: URL, ctx: RuntimeApiContext, bundle = createRuntimeBundle): boolean {
  if (url.pathname !== "/ui/runtimes" && !url.pathname.startsWith("/ui/runtimes/")) return false;
  const method = req.method ?? "GET";
  if (!nativeCliAuthorization(req, url, ctx)) { json(res, 403, { error: "Runtime settings require a local dashboard administrator" }); return true; }
  const enabled = remoteRuntimeEnabled() && !!ctx.runtimeCoordinator;
  if (!enabled) { json(res, method === "GET" && url.pathname === "/ui/runtimes" ? 200 : 404, { enabled: false, machines: [] }); return true; }
  if (["GET", "HEAD", "POST"].includes(method) && url.pathname === "/ui/runtimes/download/windows") {
    if (url.search) { json(res,400,{error:"Runtime downloads do not accept file paths or options"});return true; }
    const send = (serverOrigin?: string): void => { try {
      const file=serverOrigin === undefined ? bundle() : bundle({serverOrigin});
      res.writeHead(200,{"Content-Type":"application/zip","Content-Disposition":`attachment; filename="${file.filename}"`,
        "Content-Length":file.bytes.length,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","X-Agend-SHA256":file.sha256});
      res.end(method === "HEAD" ? undefined : file.bytes);
    } catch { json(res,503,{error:"The matching Windows Runtime package is unavailable on this host. Update or reinstall AgEnD and retry."}); }
    };
    if (method === "POST") {
      void (async () => {
        const raw = await readBoundedWebBody(req,4096);
        if (!nativeCliAuthorization(req,url,ctx)) { json(res,403,{error:"Authorization expired"});return; }
        const body: unknown = JSON.parse(raw.toString("utf8"));
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key=>key!=="server") || !("server" in body)) throw Error("Invalid connection information");
        const origin=runtimeServerOrigin(body.server);
        if (!res.destroyed && !res.writableEnded) send(origin);
      })().catch(()=>json(res,nativeCliAuthorization(req,url,ctx)?400:403,{error:nativeCliAuthorization(req,url,ctx)?"Enter a valid HTTPS AgEnD origin (HTTP is allowed only for loopback)":"Authorization expired"}));
    } else send();
    return true;
  }
  // What the copied PowerShell command pins: the SHA-256 of the exact install.ps1 bytes this server sends. The dashboard an
  // administrator is looking at is the trust anchor, so this is read here (local administrator only), never from the script's own response.
  if (method === "GET" && url.pathname === "/ui/runtimes/installer") {
    if (url.search) { json(res, 400, { error: "The installer information takes no options" }); return true; }
    try { json(res, 200, ctx.runtimeInstaller!().installer()); }
    catch { json(res, 503, { error: "The Windows Runtime installer is unavailable on this host. Update or reinstall AgEnD and retry." }); }
    return true;
  }
  const hub = ctx.runtimeCoordinator!();
  // The header token (an agent's) may still use these routes, but it is shown no account: only an admin session on the directly reached dashboard is (accountIdentityVisible).
  const machineFor = (machine: RuntimeMachine): RuntimeMachine => accountIdentityVisible(req, url, ctx) ? machine : machineWithoutAccountIdentity(machine);
  if (method === "GET" && url.pathname === "/ui/runtimes") { json(res, 200, { enabled: true, machines: hub.listMachines().map(machineFor) }); return true; }
  const tasksRoute = /^\/ui\/runtimes\/machines\/([a-f0-9-]{36})\/tasks(?:\/([a-z0-9-]{16,80})\/cancel)?$/.exec(url.pathname);
  if (tasksRoute) {
    const id = tasksRoute[1], runId = tasksRoute[2];
    if (!hub.machine(id)) { json(res, 404, { error: "Runtime machine not found" }); return true; }
    if (method === "GET" && !runId) { json(res, 200, { tasks: hub.diagnosticTasks(id) }); return true; }
    if (method !== "POST") { json(res, 404, { error: "Unknown runtime task operation" }); return true; }
    void (async () => {
      const raw = await readBoundedWebBody(req, 80_000);
      if (!nativeCliAuthorization(req, url, ctx)) { json(res, 403, { error: "Authorization expired" }); return; }
      const input: unknown = JSON.parse(raw.toString("utf8"));
      if (res.destroyed || res.writableEnded) return;
      let task: unknown;
      if (runId) {
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) throw Error("Cancel takes no fields");
        if (!hub.diagnosticTasks(id).some(task => task.id === runId)) throw Error("Task does not belong to this runtime machine");
        task = await hub.call(id, "cancel", { runId });
      } else {
        const value = validateNativeTask(input);
        const existed = hub.diagnosticTasks(id).some(task => task.id === value.requestId);
        try { task = await hub.call(id, "run", { task: value }); }
        catch (error) {
          // A recorded send owns its request ID even if its acknowledgement was lost.
          const recorded = !existed && hub.diagnosticTasks(id).find(task => task.id === value.requestId);
          if (!recorded) throw error;
          task = recorded;
        }
      }
      if (!nativeCliAuthorization(req, url, ctx)) { json(res, 403, { error: "Authorization expired" }); return; }
      json(res, 202, { task });
    })().catch(error => { const authorized = nativeCliAuthorization(req, url, ctx); json(res, authorized ? 400 : 403, { error: authorized ? error instanceof Error ? error.message : "Runtime task operation failed" : "Authorization expired" }); });
    return true;
  }
  const setupRoute = /^\/ui\/runtimes\/machines\/([a-f0-9-]{36})\/(remote-setup|cli-install)$/.exec(url.pathname);
  if (setupRoute) {
    // Only a local administrator session (remoteSetupActor); a header token, guest, public link or gateway gets nothing, and is not told why.
    const id = setupRoute[1], what = setupRoute[2], machine = hub.machine(id);
    if (!remoteSetupActor(req, url, ctx)) { json(res, 403, { error: "Installing CLIs on a computer needs a local dashboard administrator" }); return true; }
    if (!machine) { json(res, 404, { error: "Runtime machine not found" }); return true; }
    const jobs = jobsOf(hub);
    if (what === "remote-setup" && method === "GET") {
      // What the computer's owner allowed, read from the computer itself (the server cannot change it). An offline or older Runtime has no answer.
      void (async () => {
        let switches: RuntimeSwitchStates | null = null;
        const capable = machine.runtimeInfo?.capabilities.includes("cli-install") === true;
        let answered: unknown, got = false;
        if (capable && machine.status === "online") { try { answered = await hub.callAccount(id, "accounts.switches", {}, 15_000); got = true; } catch { /* shown as "could not read" */ } }
        if (!remoteSetupActor(req, url, ctx)) { json(res, 403, { error: "Authorization expired" }); return; }
        // What came back from the computer is checked before the browser sees it: a wrong shape is one fixed error, not a pass-through.
        if (got) { switches = switchStatesOf(answered); if (!switches) { json(res, 502, { error: "That computer's answer about its setup was not understood" }); return; } }
        json(res, 200, { capable, online: machine.status === "online", switches, job: jobs.get(id) ?? null,
          catalog: Object.values(INSTALLABLE_CLIS).map(({ id: cli, version }) => ({ id: cli, version })) });
      })().catch(() => json(res, 400, { error: "Could not read this computer's setup" }));
      return true;
    }
    if (what === "cli-install" && method === "POST") {
      void (async () => {
        const raw = await readBoundedWebBody(req, 1024);
        const actor = remoteSetupActor(req, url, ctx);
        if (!actor) { json(res, 403, { error: "Authorization expired" }); return; }
        const input: unknown = JSON.parse(raw.toString("utf8"));
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || !("cli" in input) || !isInstallableCli(input.cli)) throw Error("Choose Claude Code or Codex");
        const cli = input.cli;
        if (jobs.get(id)?.state === "installing") { json(res, 409, { error: "An install is already running on this computer", job: jobs.get(id) }); return; }
        // Fixed fields only: the Runtime takes the CLI id and the asker's name, and decides everything else itself.
        const job: CliInstallJob = { cli, state: "installing", startedAt: Date.now() };
        // Taken in the same synchronous step as the check above, before any await: of two requests at once, only one gets here.
        const previous = jobs.get(id); jobs.set(id, job);
        const settled = hub.callAccount(id, "cli.install", { cli, actor }, INSTALL_DEADLINE_MS).then(result => ({ result }), (error: unknown) => ({ error }));
        // A refusal that comes within EARLY_ANSWER_MS (offline, an older Runtime, the switch is off) is answered now; a run that is under way is followed through the job.
        let wait: NodeJS.Timeout | undefined;
        const early = await Promise.race([settled, new Promise<undefined>(resolve => { wait = setTimeout(() => resolve(undefined), EARLY_ANSWER_MS); })]);
        clearTimeout(wait);
        if (early && "error" in early) {
          // Nothing started (offline, an older Runtime, a switch that is off): this attempt leaves no job, and the earlier one (if any) is shown again.
          if (jobs.get(id) === job) { if (previous) jobs.set(id, previous); else jobs.delete(id); }
          throw early.error instanceof Error ? early.error : Error("The install could not start");
        }
        void settled.then(outcome => {
          job.finishedAt = Date.now();
          if ("error" in outcome) { job.state = "failed"; job.error = outcome.error instanceof Error ? outcome.error.message.slice(0, 400) : "The install failed"; return; }
          const version = outcome.result && typeof outcome.result === "object" ? (outcome.result as { version?: unknown }).version : undefined;
          job.state = "done"; if (typeof version === "string") job.version = version.slice(0, 64);
        });
        json(res, 202, { job });
      })().catch(error => { const ok = !!remoteSetupActor(req, url, ctx); json(res, ok ? 400 : 403, { error: ok ? error instanceof Error ? error.message : "Install request failed" : "Authorization expired" }); });
      return true;
    }
    json(res, 404, { error: "Unknown runtime operation" }); return true;
  }
  const route = /^\/ui\/runtimes\/machines\/([a-f0-9-]{36})(?:\/(approve|revoke|rename|refresh|probe|inventory))?$/.exec(url.pathname);
  if (method === "GET" && route) {
    const found = hub.machine(route[1]), machine = found ? machineFor(found) : found;
    json(res, machine ? 200 : 404, machine ? route[2] === "inventory" ? { machineId: machine.id, inventory: machine.inventory ?? null, updatedAt: machine.inventoryUpdatedAt ?? null, status: machine.status } : { machine } : { error: "Runtime machine not found" }); return true;
  }
  if (method !== "POST" || url.pathname !== "/ui/runtimes/pairing" && !route) { json(res, 404, { error: "Unknown runtime operation" }); return true; }
  // #3327: a pairing code and an approval only from an administrator signed in on this dashboard (its session and CSRF:
  // the page's own buttons), never the bare header token — asked again after the body is read.
  const pairingStep = url.pathname === "/ui/runtimes/pairing" || route?.[2] === "approve";
  const allowed = (): boolean => nativeCliAuthorization(req, url, ctx) && (!pairingStep || runtimePairingAdmin(req, url, ctx));
  if (!allowed()) { json(res, 403, { error: "Pairing a computer needs an administrator signed in on this dashboard" }); return true; }
  void (async () => {
    const raw = await readBoundedWebBody(req, 4096);
    if (!allowed()) { json(res, 403, { error: "Authorization expired" }); return; }
    const body: unknown = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    if (!body || typeof body !== "object" || Array.isArray(body)) throw Error("Runtime operation needs an object");
    const input = body as Record<string, unknown>;
    if (url.pathname === "/ui/runtimes/pairing") {
      if (Object.keys(input).length) throw Error("Pairing takes no fields"); json(res, 201, hub.createPairing()); return;
    }
    if (!route) throw Error("Unknown runtime operation");
    const id = route[1], op = route[2];
    if (Object.keys(input).some(key => op === "rename" ? key !== "name" : op === "approve" ? key !== "fingerprint" : true)) throw Error("Unknown runtime operation field");
    if (op === "approve") json(res, 200, { machine: machineFor(hub.approve(id, input.fingerprint)) });
    else if (op === "revoke") json(res, 200, { machine: machineFor(hub.revoke(id)) });
    else if (op === "rename") json(res, 200, { machine: machineFor(hub.rename(id, input.name)) });
    else if (op === "refresh" || op === "probe") {
      const inventory = await hub.call(id, "probe", { force: true });
      if (!nativeCliAuthorization(req, url, ctx)) { json(res, 403, { error: "Authorization expired" }); return; }
      const seen = accountIdentityVisible(req, url, ctx), current = hub.machine(id);
      json(res, 200, { machine: current && !seen ? machineWithoutAccountIdentity(current) : current, inventory: seen ? inventory : probeWithoutAccountIdentity(inventory as WindowsCliProbe) });
    } else throw Error("Unknown runtime operation");
  })().catch(error => json(res, nativeCliAuthorization(req, url, ctx) ? 400 : 403, { error: nativeCliAuthorization(req, url, ctx) ? error instanceof Error ? error.message : "Runtime operation failed" : "Authorization expired" }));
  return true;
}
