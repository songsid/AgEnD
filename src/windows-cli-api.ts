import type { IncomingMessage, ServerResponse } from "node:http";
import { evaluateWebRequest, type WebGateRequest } from "./web-auth.js";
import type { WebSessionStore } from "./web-session.js";
import { gatewayRequestContext } from "./web-request-context.js";
import { readBoundedWebBody } from "./web-body.js";
import { windowsBridgeFor, windowsCliEnabled, type WindowsCliBridge, type WindowsCliProbe } from "./windows-cli.js";
import type { RuntimeMachine } from "./runtime-protocol.js";
import { windowsAgentsFor } from "./windows-agents.js";
import { nativeAgentId } from "./native-instance-registry.js";
import type { FleetWindowsRuntime } from "./fleet-windows-runtime.js";
import { isSettingsReplay, settingsRequestLocalAdmin } from "./settings-request-capability.js";
import { withNativePaneVerification } from "./runtime-pane-native.js";

export interface WindowsCliApiContext {
  readonly webToken: string | null;
  readonly webSessions?: WebSessionStore | null;
  readonly dataDir?: string;
  readonly fleetConfig?: {instances:Record<string,{runtime?:"wsl"|"windows";native_agent_id?:string}>}|null;
  nativeInstanceRuntime?(): FleetWindowsRuntime;
  deliverToInstance?(name:string,payload:Record<string,unknown>,options?:{stillCurrent?:()=>boolean}):Promise<boolean|void>;
  emitSseEvent?(event:string,data:unknown):void;
}
function json(res: ServerResponse, code: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
/** The ordinary dashboard gate AND an explicit admin-only, non-public boundary. Rechecked after every await. */
export function nativeCliAuthorization(req: IncomingMessage, url: URL, ctx: WindowsCliApiContext): boolean {
  if (gatewayRequestContext(req)) return false;
  // Confirmed creation replays intentionally carry no browser cookies or bearer headers. Only the server-owned,
  // still-current administrator capability may continue this exact operation; it grants no other native route.
  if (isSettingsReplay(req)) {
    try { return req.method === "POST" && url.pathname === "/ui/instances" && settingsRequestLocalAdmin(req); }
    catch { return false; }
  }
  const v = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken, ctx.webSessions, { touch: false });
  return v.kind === "allow" && (v.via === "header-token" || v.session.tier === "admin");
}
/**
 * Who may be shown WHICH account a sign-in is (a masked e-mail and a plan): an admin SESSION on the dashboard reached directly (surface "local": this machine, a LAN, a tailnet or your own proxy), and no one else. These routes also
 * serve the CLI's own header token (an agent's) and other flows that predate the account display, so the callers are not turned away: the
 * answer is the same without the account (`withoutAccountIdentity`). No public link or gateway, no read or guest session, no header token,
 * no replayed confirmation.
 */
export function accountIdentityVisible(req: IncomingMessage, url: URL, ctx: WindowsCliApiContext): boolean {
  if (gatewayRequestContext(req) || isSettingsReplay(req)) return false;
  const v = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken, ctx.webSessions, { touch: false });
  return v.kind === "allow" && v.via === "session" && v.session.tier === "admin" && v.session.surface === "local";
}
/** The same inventory without any account: names and `loggedIn`/`authenticated` stay, every `identity` goes. A copy; the stored value is untouched. */
export function probeWithoutAccountIdentity(probe: WindowsCliProbe): WindowsCliProbe {
  const copy = structuredClone(probe);
  for (const row of copy.clis ?? []) delete (row as { identity?: unknown }).identity;
  for (const row of copy.credentialProfiles?.profiles ?? []) delete (row as { identity?: unknown }).identity;
  return copy;
}
export function machineWithoutAccountIdentity(machine: RuntimeMachine): RuntimeMachine {
  return machine.inventory ? { ...machine, inventory: probeWithoutAccountIdentity(machine.inventory) } : machine;
}
export function handleWindowsCliRequest(req: IncomingMessage, res: ServerResponse, url: URL, ctx: WindowsCliApiContext, bridge?: WindowsCliBridge): boolean {
  const path = url.pathname;
  const agentPage = /^\/ui\/windows-agents\/[a-f0-9-]{36}$/i.test(path);
  if (!agentPage && path !== "/ui/windows-cli" && !path.startsWith("/ui/windows-cli/")) return false;
  if (!windowsCliEnabled()) { json(res, 404, { error: "Windows CLI preview is not enabled" }); return true; }
  const authorized = (): boolean => nativeCliAuthorization(req, url, ctx);
  if (!authorized()) { json(res, 403, { error: "Windows CLI tasks require an administrator on the local dashboard" }); return true; }
  const service = bridge ?? windowsBridgeFor(ctx);
  const method = req.method ?? "GET";
  if (path === "/ui/windows-cli/agents" || path.startsWith("/ui/windows-cli/agents/")) {
    void (async () => {
      const store = windowsAgentsFor(ctx);
      const runtime=ctx.nativeInstanceRuntime?.();
      const canonical=(id:string):string=>{
        const row=Object.entries(ctx.fleetConfig?.instances ?? {}).find(([,config])=>nativeAgentId(config as Parameters<typeof nativeAgentId>[0])===id.toLowerCase());
        if(!row)throw new Error("Windows instance is not registered in the Fleet");return row[0];
      };
      const agent = /^\/ui\/windows-cli\/agents\/([a-f0-9-]{36})(?:\/(messages|recover))?$/i.exec(path);
      if (method === "GET" && path === "/ui/windows-cli/agents") {
        const registered=new Set(Object.values(ctx.fleetConfig?.instances??{}).map(config=>nativeAgentId(config as Parameters<typeof nativeAgentId>[0])));
        json(res,200,{agents:store.list().filter(profile=>!runtime||!ctx.fleetConfig||registered.has(profile.id))});return;
      }
      if (method === "GET" && agent && !agent[2]) { json(res, 200, { agent: runtime ? runtime.get(canonical(agent[1])) : store.get(agent[1]) }); return; }
      if (method !== "POST") { json(res, 404, { error: "Unknown Windows agent operation" }); return; }
      const raw = await readBoundedWebBody(req, 40_000);
      if (!authorized()) { json(res, 403, { error: "Authorization expired" }); return; }
      const input = JSON.parse(raw.toString("utf8"));
      if (path === "/ui/windows-cli/agents") {
        const result=runtime ? await runtime.create(input,authorized) : null;
        const created = result ? result.agent : await store.create(input, authorized);
        if (!authorized()) { json(res, 403, { error: "Authorization expired" }); return; }
        json(res, 201, { ...(result ?? {}), agent: created });
      }
      else if (agent?.[2] === "messages" && runtime && ctx.deliverToInstance) {
        if(!input || typeof input!=="object" || Array.isArray(input) || Object.keys(input).some(key=>!["requestId","prompt"].includes(key)) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestId) || typeof input.prompt!=="string" || !input.prompt.trim() || input.prompt.length>8000)throw new Error("Invalid Windows agent message");
        const name=canonical(agent[1]),existing=runtime.get(name)?.turns.find(turn=>turn.id===input.requestId);
        if(existing && existing.prompt!==input.prompt)throw new Error("requestId belongs to a different message");
        if(!existing){
          const messageId=`native:${input.requestId}:user`,ts=new Date().toISOString();
          const sent=await ctx.deliverToInstance(name,{type:"fleet_inbound",content:input.prompt,requestId:input.requestId,meta:{source:"web",user:"You",message_id:messageId,ts}},{stillCurrent:authorized});
          if(!authorized()){json(res,403,{error:"Authorization expired"});return;}
          if(sent===false)throw new Error("The instance did not accept this message");
          ctx.emitSseEvent?.("message",{instance:name,role:"user",sender:"You",text:input.prompt,ts,messageId});
        }
        json(res,202,{accepted:true,agent:runtime.get(name)});
      }
      else if (agent?.[2] === "messages") json(res, 202, { task: store.send(agent[1], input, authorized) });
      else if (agent?.[2] === "recover") json(res, 200, { agent: runtime ? runtime.recoverAsync ? await runtime.recoverAsync(canonical(agent[1]),input.confirmedStopped) : runtime.recover(canonical(agent[1]),input.confirmedStopped) : store.recover(agent[1], input.confirmedStopped) });
      else json(res, 404, { error: "Unknown Windows agent operation" });
    })().catch(error => {
      const allowed = authorized();
      json(res, allowed ? 400 : 403, { error: allowed ? error instanceof Error ? error.message : "Windows agent operation failed" : "Authorization expired" });
    });
    return true;
  }
  if ((method === "GET" || method === "HEAD") && (agentPage || path === "/ui/windows-cli")) {
    return false; // The ordinary app shell owns this panel, after the preview/admin checks above.
  }
  if (method === "GET" && path === "/ui/windows-cli/tasks") { json(res, 200, { tasks: service.list() }); return true; }
  const task = /^\/ui\/windows-cli\/tasks\/([a-z0-9-]{16,80})$/i.exec(path);
  if (method === "GET" && task) { const result = service.get(task[1]); json(res, result ? 200 : 404, result ?? { error: "Task not found" }); return true; }
  const cancel = /^\/ui\/windows-cli\/tasks\/([a-z0-9-]{16,80})\/cancel$/i.exec(path);
  if (method !== "POST" || (!cancel && path !== "/ui/windows-cli/tasks" && path !== "/ui/windows-cli/probe")) {
    json(res, 404, { error: "Unknown Windows CLI operation" }); return true;
  }
  void (async () => {
    const raw = await readBoundedWebBody(req, 80_000);
    if (!authorized()) { json(res, 403, { error: "Authorization expired" }); return; }
    const input = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    if (path === "/ui/windows-cli/probe") {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "force") || (input.force !== undefined && typeof input.force !== "boolean")) throw new Error("Probe accepts only an optional boolean force field");
      const result = await service.probe(input, authorized);
      if (!authorized()) { json(res, 403, { error: "Authorization expired" }); return; }
      const labelled = withNativePaneVerification(result);
      json(res, 200, accountIdentityVisible(req, url, ctx) ? labelled : probeWithoutAccountIdentity(labelled));
    } else if (cancel) json(res, 202, service.cancel(cancel[1]));
    else json(res, 202, service.start(input, authorized));
  })().catch(error => json(res, 400, { error: error instanceof Error ? error.message : "Windows CLI operation failed" }));
  return true;
}
