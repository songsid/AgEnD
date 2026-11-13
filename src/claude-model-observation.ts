/** Metadata only. Never parse rendered text, prompts, refusal explanations or SDK snake_case events. */
export interface ClaudeModelLaunch { id: string; startedAt: number; model?: string }
export type ModelSwitchCause = "safeguards" | "availability" | "observed";
export interface ModelSwitch {
  id: string;
  original: string;
  served: string;
  cause: ModelSwitchCause;
  scope: "turn" | "session" | "unknown";
  since: number;
  /** Restored observation: still listed, never announced again on resume. */
  baseline?: true;
}
export interface ModelObservation {
  configured: string | null;
  launch: string | null;
  session: string | null;
  lastServed: string | null;
  observedAt: number | null;
  active: ModelSwitch | null;
}
export type ClaudeModelRecord = {
  kind: "switch" | "served" | "intent";
  id: string;
  sessionId: string;
  at: number;
  served: string;
  original?: string;
  cause?: ModelSwitchCause;
  scope?: ModelSwitch["scope"];
};

/** Concrete model IDs only. Family/default/plan aliases deliberately remain unresolved. */
export function normalizeClaudeModel(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 100) return null;
  let id = value.toLowerCase().replace(/\[1m\]$/, "").replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const modern = /^(opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?$/.exec(id);
  const older = /^(\d+)[-.](\d+)-(opus|sonnet|haiku)$/.exec(id);
  if (modern) return `${modern[1]}-${modern[2]}.${modern[3] ?? "0"}`;
  if (older) return `${older[3]}-${older[1]}.${older[2]}`;
  return null;
}
export function claudeModelId(value: unknown): string | null {
  return normalizeClaudeModel(value) ? (value as string).toLowerCase() : null;
}
const identifier = (value: unknown): string | null => typeof value === "string" && /^[\w.-]{1,200}$/.test(value) ? value : null;
export function isClaudeMainRecord(e: any): boolean {
  return !!e && e.isSidechain !== true && e.isMeta !== true && e.isApiErrorMessage !== true
    && !e.agentId && !e.agent_id && !e.subagent_type && !e.subagentType;
}
export function parseClaudeModelRecord(e: any): ClaudeModelRecord | null {
  if (!isClaudeMainRecord(e)) return null;
  const sessionId = identifier(e.sessionId ?? e.session_id);
  if (!sessionId || (e.sessionId && e.session_id && e.sessionId !== e.session_id)) return null;
  const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
  if (!Number.isFinite(at)) return null;
  const uuid = identifier(e.uuid);
  if (e.type === "system" && (e.subtype === "model_refusal_fallback" || e.subtype === "model_fallback")) {
    const original = claudeModelId(e.originalModel), served = claudeModelId(e.fallbackModel);
    if (!uuid || !original || !served || normalizeClaudeModel(original) === normalizeClaudeModel(served)) return null;
    return { kind: "switch", id: `notice:${uuid}`, sessionId, at, original, served,
      cause: e.subtype === "model_refusal_fallback" ? "safeguards" : "availability",
      scope: e.scope === "local" || e.scope === "turn" ? "turn" : e.scope === "session" || (e.scope === undefined && e.subtype === "model_refusal_fallback") ? "session" : "unknown" };
  }
  if (e.type === "assistant" && e.message?.role === "assistant") {
    const served = claudeModelId(e.message.model), response = identifier(e.message.id);
    if (!served || !response || e.message.stop_reason === "refusal") return null;
    return { kind: "served", id: `response:${response}:${normalizeClaudeModel(served)}`, sessionId, at, served };
  }
  // A command marker says intent, never that the picker applied a change. No arbitrary command text is retained.
  if (e.type === "user" && uuid && typeof e.message?.content === "string"
    && /^(?:<command-name>\/|<command-message>)/.test(e.message.content)
    && /<command-name>\/model<\/command-name>/.test(e.message.content)) {
    const requested = /<command-args>([^<]{1,100})<\/command-args>/.exec(e.message.content)?.[1];
    return { kind: "intent", id: `intent:${uuid}`, sessionId, at, served: claudeModelId(requested) ?? "" };
  }
  return null;
}

/** One current launch, metadata-only snapshot; no model selection, restart, retry or policy calls. */
export class ClaudeModelObserver {
  private sessionId: string | null = null;
  private seen = new Set<string>();
  private state: ModelObservation;
  private expected: string | null;
  private intent: string | null | undefined;
  constructor(configured: string | undefined, launch: string | undefined, saved?: any) {
    this.state = { configured: configured ?? null, launch: launch ?? null, session: null, lastServed: null, observedAt: null, active: null };
    this.expected = claudeModelId(launch);
    // Read a bounded, versioned metadata checkpoint, never arbitrary transcript content.
    if (saved?.v === 1 && saved.configured === this.state.configured && saved.launch === this.state.launch
      && identifier(saved.sessionId) && Array.isArray(saved.seen) && saved.seen.length <= 1024
      && saved.seen.every((id: unknown) => typeof id === "string" && /^[\w.:-]{1,600}$/.test(id))) {
      this.sessionId = saved.sessionId; this.seen = new Set(saved.seen);
      this.expected = claudeModelId(saved.expected);
      this.state.lastServed = claudeModelId(saved.lastServed);
      this.state.observedAt = Number.isFinite(saved.observedAt) ? saved.observedAt : null;
      const a = saved.active;
      if (a && typeof a.id === "string" && /^[\w.:-]{1,600}$/.test(a.id) && claudeModelId(a.original) && claudeModelId(a.served)
        && ["safeguards", "availability", "observed"].includes(a.cause) && ["turn", "session", "unknown"].includes(a.scope) && Number.isFinite(a.since)) {
        this.state.active = { id: a.id, original: a.original, served: a.served, cause: a.cause, scope: a.scope, since: a.since, baseline: true };
      }
    }
  }
  bindSession(sessionId: string, sessionModel: unknown): void {
    if (this.sessionId !== sessionId) {
      const replacing = this.sessionId !== null;
      this.sessionId = sessionId; this.seen.clear(); this.state.active = null; this.state.lastServed = null; this.state.observedAt = null;
      if (replacing) { this.expected = claudeModelId(this.state.launch); this.intent = undefined; }
    }
    this.state.session = claudeModelId(sessionModel);
  }
  checkpoint() {
    return { v: 1, configured: this.state.configured, launch: this.state.launch, sessionId: this.sessionId,
      expected: this.expected, seen: [...this.seen], lastServed: this.state.lastServed, observedAt: this.state.observedAt, active: this.state.active };
  }
  snapshot(): ModelObservation { return structuredClone(this.state); }
  ownIntent(requested: string): void { this.intent = claudeModelId(requested); }
  ownResult(applied: boolean, requested: string): void {
    if (applied) { this.expected = claudeModelId(requested); this.state.active = null; }
    this.intent = undefined;
  }
  observe(record: ClaudeModelRecord, sessionModel: unknown, allowInference = true): boolean {
    this.bindSession(record.sessionId, sessionModel);
    const session = claudeModelId(sessionModel);
    this.state.session = session;
    const key = `${record.sessionId}:${record.id}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value!);
    if (this.state.observedAt !== null && record.at < this.state.observedAt) return false;
    if (record.kind === "intent") { this.intent = record.served || null; return false; }
    if (record.kind === "switch") {
      this.intent = undefined;
      const prior = this.state.active;
      if (!prior || prior.original !== record.original || prior.served !== record.served || prior.cause !== record.cause || prior.scope !== record.scope) {
        this.state.active = { id: key, original: record.original!, served: record.served, cause: record.cause!, scope: record.scope!, since: record.at };
      }
      return true;
    }
    if (this.state.observedAt !== null && record.at < this.state.observedAt) return false;
    this.state.lastServed = record.served; this.state.observedAt = record.at;
    if (this.intent !== undefined) {
      // Only a concrete requested model corroborated by both hook and served metadata confirms an intentional switch.
      if (this.intent && normalizeClaudeModel(this.intent) === normalizeClaudeModel(record.served)
        && normalizeClaudeModel(session) === normalizeClaudeModel(record.served)) {
        this.expected = record.served; this.intent = undefined; this.state.active = null;
      }
      return true;
    }
    const expected = this.expected;
    const returnsTo = this.state.active?.original ?? expected;
    if ((returnsTo && normalizeClaudeModel(record.served) === normalizeClaudeModel(returnsTo))
      || (claudeModelId(this.state.configured) && normalizeClaudeModel(record.served) === normalizeClaudeModel(this.state.configured))) this.state.active = null;
    else if (allowInference && !this.state.active && expected && normalizeClaudeModel(record.served) !== normalizeClaudeModel(expected)) {
      this.state.active = { id: key, original: expected, served: record.served, cause: "observed", scope: "unknown", since: record.at };
    }
    return true;
  }
}
