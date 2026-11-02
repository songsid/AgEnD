import { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleWindowsCliRequest, nativeCliAuthorization, type WindowsCliApiContext } from "../src/windows-cli-api.js";
import { WindowsCliBridge } from "../src/windows-cli.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { WEB_SESSION_COOKIE } from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { windowsAgentsFor } from "../src/windows-agents.js";

const token = "t".repeat(48), url = new URL("http://localhost/ui/windows-cli/tasks");
const input = { requestId: "12345678-1234-4321-abcd-123456789012", cli: "codex", cwd: "C:\\test", prompt: "Read only", sandbox: "read-only" };
function request(method = "POST", body: unknown = input): IncomingMessage {
  const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  req.method = method; req.url = url.pathname; req.headers = { host: "localhost", "x-agend-token": token }; return req;
}
class Response extends ServerResponse {
  status = 0; body = "";
  override writeHead(code: number): this { this.status = code; return this; }
  override end(chunk?: unknown): this { this.body += String(chunk ?? ""); return this; }
}
function response(req: IncomingMessage) { return new Response(req); }
beforeEach(() => vi.stubEnv("AGEND_WINDOWS_CLI", "1"));
const scratchDirs:string[]=[];
afterEach(() => {vi.unstubAllEnvs();vi.restoreAllMocks();for(const path of scratchDirs.splice(0)){if(!resolve(path).startsWith(resolve(tmpdir())+(process.platform==="win32"?"\\":"/")))throw Error("Unsafe scratch directory");rmSync(path,{recursive:true,force:true});}});

describe("optional Windows agent workspace API",()=>{
  const agentUrl=new URL("http://localhost/ui/windows-cli/agents");
  const createContext=()=>{const dataDir=mkdtempSync(join(tmpdir(),"agend-workspace-api-"));scratchDirs.push(dataDir);return {webToken:token as string|null,dataDir};};
  const agentInput={name:"General assistant",cli:"codex",sandbox:"read-only"};
  it("waits for native workspace preparation and returns the actual durable path",async()=>{
    const ctx=createContext(),req=request("POST",agentInput),res=response(req);req.url=agentUrl.pathname;
    let finish!:()=>void;
    const prepare=vi.spyOn(WindowsCliBridge.prototype,"prepareWorkspace").mockImplementation(id=>new Promise(resolve=>{finish=()=>resolve(`C:\\Users\\Test\\.agend\\workspaces\\${id}`);}));
    handleWindowsCliRequest(req,res,agentUrl,ctx);
    await vi.waitFor(()=>expect(prepare).toHaveBeenCalledOnce());expect(res.status).toBe(0);expect(windowsAgentsFor(ctx).list()).toEqual([]);
    finish();await vi.waitFor(()=>expect(res.status).toBe(201));
    const agent=JSON.parse(res.body).agent;expect(agent.cwd).toBe(`C:\\Users\\Test\\.agend\\workspaces\\${agent.id}`);expect(windowsAgentsFor(ctx).get(agent.id).cwd).toBe(agent.cwd);
  });
  it("rejects revoked authorization after preparation without persisting an agent or returning its path",async()=>{
    const ctx=createContext(),req=request("POST",agentInput),res=response(req);req.url=agentUrl.pathname;
    let finish!:()=>void;
    const prepare=vi.spyOn(WindowsCliBridge.prototype,"prepareWorkspace").mockImplementation(id=>new Promise(resolve=>{finish=()=>resolve(`C:\\Users\\Test\\.agend\\workspaces\\${id}`);}));
    handleWindowsCliRequest(req,res,agentUrl,ctx);await vi.waitFor(()=>expect(prepare).toHaveBeenCalledOnce());ctx.webToken=null;finish();
    await vi.waitFor(()=>expect(res.status).toBe(403));expect(res.body).not.toContain("Users");expect(windowsAgentsFor(ctx).list()).toEqual([]);
  });
  it("does not prepare a directory after body reception if authorization has expired",async()=>{
    const ctx=createContext(),req=request("POST",agentInput),res=response(req);req.url=agentUrl.pathname;
    const prepare=vi.spyOn(WindowsCliBridge.prototype,"prepareWorkspace");
    handleWindowsCliRequest(req,res,agentUrl,ctx);ctx.webToken=null;
    await vi.waitFor(()=>expect(res.status).toBe(403));expect(prepare).not.toHaveBeenCalled();
  });
});

describe("Windows execution uses the dashboard authorization boundary", () => {
  it("is off by default and starts no worker", () => {
    vi.stubEnv("AGEND_WINDOWS_CLI", ""); const req = request(), res = response(req);
    const bridge = new WindowsCliBridge(); const start = vi.spyOn(bridge, "start");
    handleWindowsCliRequest(req,res,url,{ webToken:token },bridge);
    expect(res.status).toBe(404); expect(start).not.toHaveBeenCalled();
  });
  it("refuses missing credentials, cross-origin headers and a managed public link", () => {
    for (const kind of ["missing", "cross-origin", "public"]) {
      const req = request();
      if (kind === "missing") delete req.headers["x-agend-token"];
      if (kind === "cross-origin") req.headers.origin = "https://elsewhere.example";
      if (kind === "public") bindGatewayRequest(req,{ surface:"gateway", exposureId:"a".repeat(32), expectedOrigin:"https://public.example", isCurrent:() => true });
      expect(nativeCliAuthorization(req,url,{ webToken:token })).toBe(false);
    }
  });
  it("requires an admin session and its own CSRF proof, not read or guest access", () => {
    for (const tier of ["admin", "read", "guest"] as const) {
      const store = new WebSessionStore();
      const session = store.create({ tier, surface:"local", label:"test", tokenEpoch:tokenEpoch(token), ...(tier === "guest" ? { owner:{ adapterId:"tg", userId:"1" } } : {}) });
      const req = request(); delete req.headers["x-agend-token"];
      req.headers.cookie = `${WEB_SESSION_COOKIE}=${session.sessionId}`;
      req.headers.origin = "http://localhost";
      const ctx = { webToken:token, webSessions:store };
      expect(nativeCliAuthorization(req,url,ctx)).toBe(false);
      req.headers["x-agend-csrf"] = csrfTokenFor(session.sessionId);
      expect(nativeCliAuthorization(req,url,ctx)).toBe(tier === "admin");
    }
  });
  it("rechecks revocation after body reception, before invoking the execution service", async () => {
    const req = request(), res = response(req), ctx: { webToken: string | null } = { webToken:token };
    const bridge = new WindowsCliBridge(); const start = vi.spyOn(bridge,"start");
    handleWindowsCliRequest(req,res,url,ctx,bridge); ctx.webToken = null;
    await vi.waitFor(() => expect(res.status).toBe(403)); expect(start).not.toHaveBeenCalled();
  });
  it("passes the validated body to the service and returns a task rather than waiting for model output", async () => {
    const req = request(), res = response(req), bridge = new WindowsCliBridge();
    const start = vi.spyOn(bridge,"start").mockReturnValue({ id:input.requestId, cli:"codex", cwd:input.cwd, sandbox:"read-only", status:"starting", startedAt:1, output:"" });
    handleWindowsCliRequest(req,res,url,{ webToken:token },bridge);
    await vi.waitFor(() => expect(res.status).toBe(202)); expect(start).toHaveBeenCalledWith(input,expect.any(Function));
  });
});

describe("Windows CLI discovery refresh API", () => {
  const probeUrl = new URL("http://localhost/ui/windows-cli/probe");
  const value = { home:"C:\\User",clis:[],probedAt:1 };
  it.each([{}, {force:true}, {force:false}])("passes supported refresh options %j to discovery", async body => {
    const req = request("POST",body), res = response(req), bridge = new WindowsCliBridge(); req.url = probeUrl.pathname;
    const probe = vi.spyOn(bridge,"probe").mockResolvedValue(value);
    handleWindowsCliRequest(req,res,probeUrl,{webToken:token},bridge);
    await vi.waitFor(() => expect(res.status).toBe(200));
    expect(probe).toHaveBeenCalledWith(body); expect(JSON.parse(res.body)).toEqual(value);
  });
  it("accepts an empty POST body as ordinary cached discovery", async () => {
    const req = Readable.from([]) as unknown as IncomingMessage;
    req.method = "POST"; req.url = probeUrl.pathname; req.headers = {host:"localhost","x-agend-token":token};
    const res = response(req), bridge = new WindowsCliBridge(), probe = vi.spyOn(bridge,"probe").mockResolvedValue(value);
    handleWindowsCliRequest(req,res,probeUrl,{webToken:token},bridge);
    await vi.waitFor(() => expect(res.status).toBe(200)); expect(probe).toHaveBeenCalledWith({});
  });
  it.each([null, [], "force", {force:"true"}, {force:1}, {force:true,unexpected:true}])("rejects malformed refresh options %j before discovery", async body => {
    const req = request("POST",body), res = response(req), bridge = new WindowsCliBridge(); req.url = probeUrl.pathname;
    const probe = vi.spyOn(bridge,"probe");
    handleWindowsCliRequest(req,res,probeUrl,{webToken:token},bridge);
    await vi.waitFor(() => expect(res.status).toBe(400)); expect(probe).not.toHaveBeenCalled();
  });
  it("rechecks revocation before returning a discovery result", async () => {
    const req = request("POST",{}), res = response(req), bridge = new WindowsCliBridge(), ctx: WindowsCliApiContext = {webToken:token}; req.url = probeUrl.pathname;
    let finish!: (result: typeof value) => void;
    const probe = vi.spyOn(bridge,"probe").mockImplementation(() => new Promise(resolve => { finish=resolve; }));
    handleWindowsCliRequest(req,res,probeUrl,ctx,bridge);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    (ctx as {webToken:string|null}).webToken = null; finish(value);
    await vi.waitFor(() => expect(res.status).toBe(403)); expect(res.body).not.toContain("C:\\\\User");
  });
  it("does not expose a cached result to an unauthenticated request", () => {
    const req = request("POST",{}), res = response(req), bridge = new WindowsCliBridge(); req.url = probeUrl.pathname;
    delete req.headers["x-agend-token"];
    const probe = vi.spyOn(bridge,"probe").mockResolvedValue(value);
    handleWindowsCliRequest(req,res,probeUrl,{webToken:token},bridge);
    expect(res.status).toBe(403); expect(probe).not.toHaveBeenCalled();
  });
});
