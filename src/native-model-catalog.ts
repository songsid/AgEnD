/** Model discovery for the native runtime, behind the shared Settings surface. */
import { remoteRuntimeEnabled } from "./runtime-switches.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebApiContext } from "./web-api.js";
import { nativeCliAuthorization } from "./windows-cli-api.js";
import { windowsBridgeFor, windowsCliEnabled, type WindowsCliBridge } from "./windows-cli.js";
import { isNativeProviderId } from "./windows-cli-providers.js";
import { isWindowsInstance } from "./native-instance-registry.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Caller validates the ordinary dashboard gate and the query shape first. */
export function handleNativeModelCatalog(req: IncomingMessage, res: ServerResponse, url: URL, ctx: WebApiContext, bridge?: WindowsCliBridge): boolean {
  const instance = url.searchParams.get("instance");
  const config = instance ? ctx.fleetConfig?.instances[instance] : undefined;
  const requestedMachine=url.searchParams.get("machineId"), machineId=requestedMachine ?? config?.machine_id;
  if (url.searchParams.get("runtime") !== "windows" && !isWindowsInstance(config)) {
    if(requestedMachine!==null){json(res,400,{error:"A machine model catalog requires a Windows runtime"});return true;}
    return false;
  }
  if (!windowsCliEnabled()) { json(res, 404, { error: "Windows runtime is not enabled" }); return true; }
  const allowed = (): boolean => nativeCliAuthorization(req, url, ctx);
  if (!allowed()) { json(res, 403, { error: "Windows model discovery requires an administrator on the local dashboard" }); return true; }
  const backend = url.searchParams.get("backend") ?? "";
  if (!isNativeProviderId(backend)) { json(res, 400, { error: "Unknown Windows CLI provider" }); return true; }
  if (url.searchParams.get("runtime") === "wsl" || instance && (!isWindowsInstance(config) || config?.backend !== backend)) {
    json(res, 400, { error: "The selected runtime and CLI do not match this instance" }); return true;
  }
  if (instance && requestedMachine !== null && requestedMachine !== config?.machine_id) {
    json(res,400,{error:"The selected machine does not own this conversation"});return true;
  }
  void (async () => {
    // M-2239 P1-2: a GET reads the administrator's last detection, including remote machines.
    // Detection is an explicit administrator POST; a model-list `refresh` never launches a CLI.
    let catalog;
    if(machineId){
      if(!remoteRuntimeEnabled() || !ctx.runtimeCoordinator)throw new Error("Remote runtimes are not enabled");
      const hub=ctx.runtimeCoordinator(), machine=hub.machine(machineId);
      if(!machine || machine.status==="pending" || machine.status==="revoked")throw new Error("Unknown runtime machine");
      catalog=machine.inventory;
      if(!catalog)throw new Error("Runtime inventory is not ready");
    } else catalog = await (bridge ?? windowsBridgeFor(ctx)).probe();
    if (!allowed()) { json(res, 403, { error: "Authorization expired" }); return; }
    const cli = catalog.clis.find(row => row.id === backend);
    json(res, 200, {
      backend, runtime: "windows", ...(machineId ? {machineId} : {}),
      models: (cli?.models ?? []).map(model => ({ id: model.id, label: model.name ?? model.id, ...(model.description ? { description: model.description } : {}) })),
      source: cli?.modelsSource ?? (cli?.models.length ? "cli-list" : "unavailable"),
    });
  })().catch(() => json(res, allowed() ? 503 : 403, { error: allowed() ? "Windows model discovery failed. Retry the CLI inventory." : "Authorization expired" }));
  return true;
}
