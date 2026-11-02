/** Named Windows CLI conversations; independent of Linux/tmux instances. Local administrator only. */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getAgendHome } from "./paths.js";
import { validWindowsDirectory } from "./windows-cli-worker.js";
import { windowsBridgeFor, type WindowsCliBridge, type WindowsCliTask } from "./windows-cli.js";
import { isNativeProviderId, nativeProvider, validateNativeModel, type NativeProviderId } from "./windows-cli-providers.js";

export interface WindowsTurn { id: string; prompt: string; output: string; status: string; startedAt: number; finishedAt?: number; error?: string }
export interface WindowsAgent {
  id: string; name: string; cwd: string; description: string; instructions: string;
  cli: NativeProviderId; model?: string;
  sandbox: "read-only" | "workspace-write"; createdAt: number; threadId?: string;
  activeId?: string; turns: WindowsTurn[];
  paused?: boolean;
  /** Once linked, removal from fleet.yaml must not import this provider state again. */
  fleet_instance?: string;
}
export interface WindowsAgentPatch { name?: string; cwd?: string; description?: string; instructions?: string; sandbox?: WindowsAgent["sandbox"]; cli?: NativeProviderId; model?: string }
export interface WindowsAgentSendOptions { onSettled?: (task: WindowsCliTask) => void }
interface AgentData { version: 1; agents: WindowsAgent[]; requests: Record<string, { agentId: string; digest: string }> }
const idPattern = /^[a-f0-9-]{36}$/i;
const shortText = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit && !value.includes("\0");
export class WindowsAgents {
  private data: AgentData = { version: 1, agents: [], requests: {} };
  private file: string;
  private listeners = new Set<() => void>();
  private launching = new Set<string>();
  constructor(home: string, private bridge: WindowsCliBridge) {
    this.file = join(home, "windows-agents.json");
    if (existsSync(this.file)) {
      if (statSync(this.file).size > 20 * 1024 * 1024) throw new Error("Windows agent store is too large");
      const value = JSON.parse(readFileSync(this.file, "utf8"));
      if (value.version !== 1 || !Array.isArray(value.agents) || !value.requests || typeof value.requests !== "object") throw new Error("Invalid Windows agent store");
      this.data = value;
      // Version 1 profiles created before provider selection were all Codex conversations.
      for (const agent of this.data.agents) { agent.cli ??= "codex"; if (!isNativeProviderId(agent.cli)) throw new Error("Invalid Windows agent CLI"); }
    }
  }
  private change<T>(fn: () => T): T {
    const before = JSON.stringify(this.data);
    try {
      const result = fn();
      const body = JSON.stringify(this.data);
      if (Buffer.byteLength(body) > 20 * 1024 * 1024) throw new Error("Windows agent history limit reached");
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      writeFileSync(temp, body, { mode: 0o600 }); renameSync(temp, this.file);
      for (const listener of [...this.listeners]) { try { listener(); } catch { /* Observers cannot roll back committed data. */ } }
      return result;
    } catch (e) { this.data = JSON.parse(before); throw e; }
  }
  private find(id: string): WindowsAgent {
    const agent = this.data.agents.find(a => a.id === id);
    if (!agent) throw new Error("Windows agent not found");
    return agent;
  }
  get(id: string): WindowsAgent & { blocked: boolean } {
    const agent = structuredClone(this.find(id));
    const task = agent.activeId ? this.bridge.get(agent.activeId) : null;
    const blocked = !!agent.activeId && ((!task && !this.launching.has(agent.activeId)) || task?.outcomeConfirmed === false || !!task?.finishedAt);
    const turn = agent.turns.find(t => t.id === agent.activeId);
    if (turn && task) Object.assign(turn, { status: task.status, output: task.output, error: task.error });
    if (turn && blocked) { turn.status = "interrupted"; turn.error = "Windows execution outcome is unknown. Check that its Windows processes stopped before unlocking this agent."; }
    return { ...agent, blocked };
  }
  list(): Array<Omit<WindowsAgent, "turns" | "instructions"> & { blocked: boolean }> {
    return this.data.agents.map(a => { const { turns: _turns, instructions: _instructions, ...row } = this.get(a.id); return row; });
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  bindInstance(id: string, name: string): void {
    if (!name || name.length > 128 || /[\\/\x00-\x1f\x7f]/.test(name) || name.includes("..")) throw new Error("Invalid Fleet instance name");
    const agent=this.find(id);
    if(agent.fleet_instance===name)return;
    this.change(()=>{agent.fleet_instance=name;});
  }
  update(id: string, patch: WindowsAgentPatch, authorized: () => boolean = () => true): WindowsAgent {
    const current = this.find(id);
    if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some(key => !["name","cwd","description","instructions","sandbox","cli","model"].includes(key))) throw new Error("Unknown Windows agent field");
    if (current.activeId) throw new Error("Wait for the Windows agent to finish before changing its settings");
    const next = structuredClone(current);
    if (Object.hasOwn(patch,"name")) {
      if (!shortText(patch.name,64) || !patch.name.trim() || /[\x00-\x1f\x7f]/.test(patch.name)) throw new Error("Enter a Windows agent name (1–64 characters)");
      next.name = patch.name.trim();
      if (this.data.agents.some(agent => agent.id !== id && agent.name.toLowerCase() === next.name.toLowerCase())) throw new Error("A Windows agent already uses that name");
    }
    if (Object.hasOwn(patch,"cwd")) { if (!validWindowsDirectory(patch.cwd)) throw new Error("Enter an absolute Windows working directory"); next.cwd = patch.cwd; }
    if (Object.hasOwn(patch,"cli")) { if (!isNativeProviderId(patch.cli)) throw new Error("Choose a supported Windows CLI"); next.cli = patch.cli; }
    if (current.threadId && (next.cli !== current.cli || next.cwd !== current.cwd)) throw new Error("Start a new conversation before changing this agent's CLI or working directory");
    if (Object.hasOwn(patch,"description")) { if (!shortText(patch.description,512)) throw new Error("Agent description is too long"); next.description = patch.description; }
    if (Object.hasOwn(patch,"instructions")) { if (!shortText(patch.instructions,8000)) throw new Error("Agent instructions are too long"); next.instructions = patch.instructions; }
    if (Object.hasOwn(patch,"model")) { const model = validateNativeModel(patch.model); if (model) next.model = model; else delete next.model; }
    if (Object.hasOwn(patch,"sandbox")) { if (patch.sandbox !== "read-only" && patch.sandbox !== "workspace-write") throw new Error("Choose a file access mode"); next.sandbox = patch.sandbox; }
    const provider = nativeProvider(next.cli);
    if (!provider.supports.execution || !provider.supports.resume) throw new Error(provider.reason || "This CLI cannot create Windows conversations yet");
    if (next.sandbox === "read-only" && !provider.readOnlySupport) throw new Error(`${provider.name} does not support read-only execution`);
    if (!authorized()) throw new Error("Authorization expired before changing the Windows agent");
    if (JSON.stringify(next) === JSON.stringify(current)) return structuredClone(current);
    this.change(() => { this.data.agents[this.data.agents.findIndex(agent => agent.id === id)] = next; });
    return structuredClone(next);
  }
  remove(id: string, authorized: () => boolean = () => true): WindowsAgent {
    const agent = this.find(id);
    if (agent.activeId) throw new Error("Cancel and finish the Windows agent before removing it");
    if (!authorized()) throw new Error("Authorization expired before removing the Windows agent");
    const snapshot = structuredClone(agent);
    this.change(() => { this.data.agents = this.data.agents.filter(row => row.id !== id); });
    // Workspaces, provider sessions and request tombstones survive removal.
    return snapshot;
  }
  restore(snapshot: WindowsAgent): void {
    if (this.data.agents.some(row => row.id === snapshot.id || row.name.toLowerCase() === snapshot.name.toLowerCase())) throw new Error("Cannot restore a Windows agent over an existing agent");
    this.change(() => { this.data.agents.push(structuredClone(snapshot)); });
  }
  setPaused(id: string, paused: boolean): WindowsAgent {
    const agent = this.find(id);
    if (typeof paused !== "boolean") throw new Error("Paused must be a boolean");
    if (agent.paused === paused || !agent.paused && !paused) return structuredClone(agent);
    this.change(() => { agent.paused = paused; });
    return structuredClone(agent);
  }
  cancel(id: string): WindowsCliTask | null {
    const agent = this.find(id);
    return agent.activeId ? this.bridge.cancel(agent.activeId) : null;
  }
  async create(input: unknown, authorized: () => boolean = () => true): Promise<WindowsAgent> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Agent must be an object");
    const v = input as Record<string, unknown>;
    if (Object.keys(v).some(k => !["name", "cwd", "description", "instructions", "sandbox", "cli", "model"].includes(k))) throw new Error("Unknown Windows agent field");
    const cli = v.cli ?? "codex";
    if (!isNativeProviderId(cli)) throw new Error("Choose a supported Windows CLI");
    const provider = nativeProvider(cli), model = validateNativeModel(v.model);
    if (!provider.supports.execution || !provider.supports.resume) throw new Error(provider.reason || "This CLI cannot create Windows conversations yet");
    if (v.sandbox === "read-only" && !provider.readOnlySupport) throw new Error(`${provider.name} does not support read-only execution; choose native CLI permissions`);
    if (!shortText(v.name, 64) || !v.name.trim() || /[\x00-\x1f\x7f]/.test(v.name)) throw new Error("Enter a Windows agent name (1–64 characters)");
    const suppliedCwd = v.cwd === undefined ? "" : typeof v.cwd === "string" ? v.cwd.trim() : null;
    if (suppliedCwd === null || suppliedCwd && !validWindowsDirectory(suppliedCwd)) throw new Error("Enter an absolute Windows working directory or leave it empty");
    if (v.sandbox !== "read-only" && v.sandbox !== "workspace-write") throw new Error("Choose a file access mode");
    if (!shortText(v.description ?? "", 512) || !shortText(v.instructions ?? "", 8000)) throw new Error("Agent description or instructions are too long");
    if (this.data.agents.length >= 16) throw new Error("This preview supports at most 16 Windows agents");
    if (this.data.agents.some(a => a.name.toLowerCase() === (v.name as string).trim().toLowerCase())) throw new Error("A Windows agent already uses that name");
    if (!authorized()) throw new Error("Authorization expired before creating the Windows agent");
    const id = randomUUID(), name = v.name.trim();
    const cwd = suppliedCwd || await this.bridge.prepareWorkspace(id, authorized);
    if (!validWindowsDirectory(cwd)) throw new Error("Could not create a valid Windows workspace");
    const agent: WindowsAgent = { id, name, cli, ...(model ? { model } : {}), cwd, sandbox: v.sandbox, description: String(v.description ?? ""), instructions: String(v.instructions ?? ""), createdAt: Date.now(), turns: [] };
    this.change(() => {
      if (!authorized()) throw new Error("Authorization expired while creating the Windows agent");
      // Another creation may have completed while native Windows prepared this workspace.
      if (this.data.agents.length >= 16) throw new Error("This preview supports at most 16 Windows agents");
      if (this.data.agents.some(a => a.name.toLowerCase() === name.toLowerCase())) throw new Error("A Windows agent already uses that name");
      this.data.agents.push(agent);
    });
    return structuredClone(agent);
  }
  send(id: string, value: unknown, authorized: () => boolean, options: WindowsAgentSendOptions = {}): WindowsCliTask | WindowsTurn {
    const agent = this.find(id);
    const v = value as Record<string, unknown>;
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["requestId", "prompt"].includes(k))
      || typeof v.requestId !== "string" || !idPattern.test(v.requestId) || !shortText(v.prompt, 8000) || !v.prompt.trim()) throw new Error("Invalid Windows agent message");
    const requestId = v.requestId, prompt = v.prompt;
    const digest = createHash("sha256").update(prompt).digest("hex");
    const old = Object.hasOwn(this.data.requests, requestId) ? this.data.requests[requestId] : null;
    if (old) {
      if (old.agentId !== id || old.digest !== digest) throw new Error("requestId belongs to a different message");
      const turn = this.get(id).turns.find(t => t.id === requestId);
      if (!turn) throw new Error("This message was already sent; its visible history has expired");
      return turn;
    }
    if (agent.activeId) throw new Error(this.get(id).blocked ? "Check Windows processes and unlock this agent before continuing" : "This Windows agent is still working");
    if (agent.paused) throw new Error("This Windows agent is paused; resume it before sending work");
    if (Object.keys(this.data.requests).length >= 4096) throw new Error("Windows agent preview message limit reached");
    this.launching.add(requestId);
    try { this.change(() => {
      agent.activeId = requestId;
      agent.turns.push({ id: requestId, prompt, output: "", status: "starting", startedAt: Date.now() });
      if (agent.turns.length > 10) agent.turns.shift();
      this.data.requests[requestId] = { agentId: id, digest };
    }); } catch(error) { this.launching.delete(requestId); throw error; }
    try {
      return this.bridge.start({ requestId, cli: agent.cli, ...(agent.model ? { model: agent.model } : {}), cwd: agent.cwd, sandbox: agent.sandbox,
        prompt: agent.instructions ? `Agent instructions:\n${agent.instructions}\n\nUser task:\n${prompt}` : prompt }, authorized, {
        resumeSessionId: agent.threadId,
        onSettled: task => { try { this.change(() => {
          const current = this.find(id), turn = current.turns.find(t => t.id === requestId)!;
          Object.assign(turn, { output: task.output, status: task.status, finishedAt: task.finishedAt, error: task.error });
          if (task.threadId) current.threadId = task.threadId;
          if (task.status === "completed" && !current.threadId) {
            turn.status = "failed";
            turn.error = "CLI returned no conversation id. The next message will start a new conversation.";
          }
          if (task.outcomeConfirmed) delete current.activeId;
        }); } catch (error) { options.onSettled?.({ ...task,status:"failed",error:`Could not save Windows conversation: ${error instanceof Error ? error.message : error}` }); throw error; }
          const saved = this.find(id).turns.find(turn => turn.id === requestId);
          options.onSettled?.(saved?.status === "failed" ? { ...task,status:"failed",error:saved.error } : { ...task });
        },
      });
    } catch (e) {
      this.change(() => { const current = this.find(id); delete current.activeId; current.turns = current.turns.filter(t => t.id !== requestId); delete this.data.requests[requestId]; });
      throw e;
    } finally { this.launching.delete(requestId); }
  }
  recover(id: string, confirmedStopped: unknown): WindowsAgent & { blocked: boolean } {
    const agent = this.find(id);
    if (confirmedStopped !== true || !agent.activeId || !this.get(id).blocked) throw new Error("Confirm the disconnected Windows process has stopped before unlocking");
    this.bridge.releaseUnknown(agent.activeId);
    this.change(() => {
      const turn = agent.turns.find(t => t.id === agent.activeId);
      if (turn) { turn.status = "interrupted"; turn.finishedAt = Date.now(); }
      delete agent.activeId;
    });
    return this.get(id);
  }
}
const stores = new WeakMap<object, WindowsAgents>();
export function windowsAgentsFor(owner: object & { dataDir?: string }): WindowsAgents {
  let store = stores.get(owner);
  if (!store) { store = new WindowsAgents(owner.dataDir ?? getAgendHome(), windowsBridgeFor(owner)); stores.set(owner, store); }
  return store;
}
