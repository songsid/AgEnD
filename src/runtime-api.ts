/** Local administrator API for pairing and managing execution computers. */
import { remoteRuntimeEnabled } from "./runtime-switches.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBoundedWebBody } from "./web-body.js";
import { nativeCliAuthorization, type WindowsCliApiContext } from "./windows-cli-api.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import { createRuntimeBundle } from "./runtime-bundle.js";
import { validateNativeTask } from "./windows-cli-worker.js";

export interface RuntimeApiContext extends WindowsCliApiContext { runtimeCoordinator?(): RuntimeCoordinator }
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
  if ((method === "GET" || method === "HEAD") && url.pathname === "/ui/runtimes/download/windows") {
    if (url.search) { json(res,400,{error:"Runtime downloads do not accept file paths or options"});return true; }
    try {
      const file=bundle();
      res.writeHead(200,{"Content-Type":"application/zip","Content-Disposition":`attachment; filename="${file.filename}"`,
        "Content-Length":file.bytes.length,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","X-Agend-SHA256":file.sha256});
      res.end(method === "HEAD" ? undefined : file.bytes);
    } catch { json(res,503,{error:"The matching Windows Runtime package is unavailable on this host. Update or reinstall AgEnD and retry."}); }
    return true;
  }
  const hub = ctx.runtimeCoordinator!();
  if (method === "GET" && url.pathname === "/ui/runtimes") { json(res, 200, { enabled: true, machines: hub.listMachines() }); return true; }
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
  const route = /^\/ui\/runtimes\/machines\/([a-f0-9-]{36})(?:\/(approve|revoke|rename|refresh|probe|inventory))?$/.exec(url.pathname);
  if (method === "GET" && route) {
    const machine = hub.machine(route[1]);
    json(res, machine ? 200 : 404, machine ? route[2] === "inventory" ? { machineId: machine.id, inventory: machine.inventory ?? null, updatedAt: machine.inventoryUpdatedAt ?? null, status: machine.status } : { machine } : { error: "Runtime machine not found" }); return true;
  }
  if (method !== "POST" || url.pathname !== "/ui/runtimes/pairing" && !route) { json(res, 404, { error: "Unknown runtime operation" }); return true; }
  void (async () => {
    const raw = await readBoundedWebBody(req, 4096);
    if (!nativeCliAuthorization(req, url, ctx)) { json(res, 403, { error: "Authorization expired" }); return; }
    const body: unknown = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    if (!body || typeof body !== "object" || Array.isArray(body)) throw Error("Runtime operation needs an object");
    const input = body as Record<string, unknown>;
    if (url.pathname === "/ui/runtimes/pairing") {
      if (Object.keys(input).length) throw Error("Pairing takes no fields"); json(res, 201, hub.createPairing()); return;
    }
    if (!route) throw Error("Unknown runtime operation");
    const id = route[1], op = route[2];
    if (Object.keys(input).some(key => op === "rename" ? key !== "name" : op === "approve" ? key !== "fingerprint" : true)) throw Error("Unknown runtime operation field");
    if (op === "approve") json(res, 200, { machine: hub.approve(id, input.fingerprint) });
    else if (op === "revoke") json(res, 200, { machine: hub.revoke(id) });
    else if (op === "rename") json(res, 200, { machine: hub.rename(id, input.name) });
    else if (op === "refresh" || op === "probe") {
      const inventory = await hub.call(id, "probe", { force: true });
      if (!nativeCliAuthorization(req, url, ctx)) { json(res, 403, { error: "Authorization expired" }); return; }
      json(res, 200, { machine: hub.machine(id), inventory });
    } else throw Error("Unknown runtime operation");
  })().catch(error => json(res, nativeCliAuthorization(req, url, ctx) ? 400 : 403, { error: nativeCliAuthorization(req, url, ctx) ? error instanceof Error ? error.message : "Runtime operation failed" : "Authorization expired" }));
  return true;
}
