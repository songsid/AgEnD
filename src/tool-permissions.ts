/**
 * One answer to "may this instance use this tool", for every way of asking.
 *
 * There are four ways an agent can reach a fleet tool and only one of them ever
 * consulted a tool list:
 *
 * 1. MCP `tools/list` — the model sees a filtered menu.
 * 2. MCP `tools/call` — takes the name it was given and forwards it. The filter
 *    from (1) is never consulted, so a guessed name runs.
 * 3. Writing `channel.sock` directly. It is a 0600 socket in the instance
 *    directory and the backend CLI runs as the same user with a shell, so an
 *    agent that can open a file can send `fleet_outbound` without mcp-server
 *    existing at all.
 * 4. `POST /agent` with `agent.token`, which every instance gets on every spawn
 *    — not only the ones in cli mode.
 *
 * Which is why keeping a tool out of the schema is a way to spend fewer tokens
 * and get a clearer error, and is not a control. The control is this module,
 * called at the points where those four paths converge: the fleet's IPC
 * dispatch and the agent endpoint. See
 * `docs/design/coordinator-tool-perms.zh-TW.md`.
 *
 * Stage 1 wires the callers and records what they would have decided. Nothing
 * here denies anything yet.
 */
import { TOOLS } from "./channel/mcp-tools.js";

export type ToolSetName = "full" | "standard" | "worker" | "coordinator" | "minimal" | "general";

/** Everything an agent that is doing the work needs, and nothing that runs the fleet. */
const WORKER: readonly string[] = [
  // Talking to people.
  "reply", "react", "edit_message", "download_attachment",
  // Talking to peers. `report_result` is why `standard` was never usable as a
  // worker profile: without it the delegate → work → report protocol has no
  // last step. `delegate_task` is here because it creates nothing and needs a
  // target that already exists — it is `send_to_instance` with a correlation
  // id, and a month of real traffic showed 572 of its 574 calls coming from
  // instances this would otherwise have silenced.
  "send_to_instance", "report_result", "request_information", "broadcast", "delegate_task",
  // Knowing where it is and who is next to it. All read-only.
  "list_instances", "describe_instance", "list_teams", "list_models",
  "get_fleet_status", "get_fleet_config", "get_usage", "get_effort", "get_instance_logs",
  "list_decisions", "list_schedules", "list_deployments", "validate_config",
  // Its own things.
  "task", "post_decision", "set_display_name", "set_description",
  // Its own schedules. Present here, but not a free hand: scheduleOpRefusal
  // limits a non-coordinator to schedules that target itself and that it
  // created (#895). The target is the control, not whether the tool is listed.
  "create_schedule", "update_schedule", "delete_schedule",
  // The repo it works in: a lease on the work itself, not a way to run the fleet.
  "checkout_repo", "release_repo",
];

/**
 * The verbs that run the fleet rather than do the work.
 *
 * Every one of them either creates, destroys, silences or reconfigures
 * something that belongs to somebody else.
 */
const ORCHESTRATION: readonly string[] = [
  "create_instance", "delete_instance", "replace_instance",
  "start_instance", "stop_instance", "pause_instance", "wake_instance", "restart_instance",
  "deploy_template", "teardown_deployment",
  "create_team", "delete_team", "update_team",
  "update_fleet_defaults", "update_instance_config",
  // Changing a decision somebody else recorded; `post_decision` adds, and stays.
  "update_decision",
];

const ALL_TOOLS = TOOLS.map(t => t.name);

/**
 * Three tiers plus the three that already existed.
 *
 * `general` is not `coordinator` plus channel I/O — it is deliberately smaller:
 * a dispatcher has no business deleting instances or rewriting fleet defaults.
 */
export const TOOL_PROFILES: Readonly<Record<ToolSetName, readonly string[]>> = {
  full: ALL_TOOLS,
  worker: WORKER,
  coordinator: [...WORKER, ...ORCHESTRATION],
  general: [
    "reply", "react", "edit_message", "download_attachment",
    "list_teams", "list_instances", "describe_instance", "get_fleet_status", "get_usage", "get_effort", "list_models",
    "send_to_instance", "delegate_task", "request_information", "report_result", "broadcast",
    "create_instance", "start_instance", "restart_instance", "wake_instance",
    "task", "list_decisions", "post_decision",
    "create_schedule", "list_schedules", "update_schedule", "delete_schedule",
  ],
  standard: [
    "reply", "react", "edit_message",
    "send_to_instance", "broadcast", "list_instances", "describe_instance",
    "list_decisions", "post_decision", "task", "set_display_name", "set_description",
    "validate_config", "get_fleet_status", "get_usage", "get_effort", "get_instance_logs", "get_fleet_config",
    // Self-scheduling, same scope as worker (#895).
    "create_schedule", "list_schedules", "update_schedule", "delete_schedule",
  ],
  // No schedules: an explicit `minimal` is a deliberate narrowing, and three
  // more schemas would cost the one profile whose point is having few.
  minimal: ["reply", "send_to_instance", "list_decisions", "download_attachment"],
};

const PROFILE_SETS = Object.fromEntries(
  Object.entries(TOOL_PROFILES).map(([name, tools]) => [name, new Set(tools)]),
) as unknown as Readonly<Record<ToolSetName, ReadonlySet<string>>>;

/**
 * `Object.hasOwn`, not `in`.
 *
 * `"constructor" in PROFILE_SETS` is true — every object inherits it — so an
 * instance whose `tool_set` was written as `constructor` or `__proto__` used to
 * pass this check and then reach `PROFILE_SETS[...].has(...)` on a function,
 * which throws inside the sink. A name that is not a profile has to answer no,
 * whatever Object.prototype happens to carry.
 */
export function isToolSetName(value: unknown): value is ToolSetName {
  return typeof value === "string" && Object.hasOwn(PROFILE_SETS, value);
}

export function toolsFor(profile: ToolSetName): ReadonlySet<string> {
  return PROFILE_SETS[profile];
}

export function mayUseTool(profile: ToolSetName, tool: string): boolean {
  return PROFILE_SETS[profile].has(tool);
}

/**
 * Which profile an instance runs under.
 *
 * An explicit `tool_set` always wins, including `full`: a general that has been
 * deliberately narrowed must stay narrowed, and a worker that has been
 * deliberately widened must stay wide. Only when nothing was written does the
 * role decide.
 *
 * `unsetDefault` is the answer for an ordinary instance that said nothing, and
 * it is `"worker"`. It used to be every tool there is, which is what #804
 * actually was: nobody chose to give a worker `create_instance`, it arrived by
 * saying nothing. An instance that needs more says so.
 *
 * A value that is not a profile is not an explicit choice, and falls to the
 * role rather than to the toolbox. Before, an unrecognised `AGEND_TOOL_SET`
 * fell back to all 47 tools — a typo was the shortest path to maximum
 * privilege, which is the wrong direction for a mistake to travel.
 */
export function resolveToolSet(
  config: { tool_set?: string; general_topic?: boolean } | undefined,
  name: string,
  unsetDefault: ToolSetName = "worker",
): ToolSetName {
  const explicit = config?.tool_set;
  if (isToolSetName(explicit)) return explicit;
  if (config?.general_topic === true || name === "general") return "general";
  return unsetDefault;
}

/**
 * The profile for a process that only has the environment variable.
 *
 * mcp-server runs on the other side of a spawn and never sees fleet.yaml, so it
 * resolves from `AGEND_TOOL_SET` alone. Same rules, same fallback, one function
 * — the alternative is two copies of "what does an unknown name mean" that
 * drift the first time one of them is edited.
 */
export function resolveToolSetFromEnv(value: string | undefined): ToolSetName {
  if (!value) return "full";
  if (isToolSetName(value)) return value;
  return "worker";
}

/**
 * The IPC message types that reach a handler of their own.
 *
 * `fleet_outbound` carries its tool name in the body; everything below is a
 * type that IS a tool, dispatched at `fleet-manager`'s IPC switch without ever
 * passing through the outbound handler. They were invisible to the permission
 * question until this table existed, which is how `update_decision` — a tool on
 * the coordinator-only list — kept a way through.
 */
/**
 * The tool an IPC message type means, or null if it is not one.
 *
 * Own-property only, for the same reason as `isToolSetName`: a message with
 * `type: "constructor"` would otherwise pass the gate and hand a function to
 * the permission check.
 */
export function toolForIpcType(type: unknown): string | null {
  return typeof type === "string" && Object.hasOwn(IPC_TYPE_TOOLS, type) ? IPC_TYPE_TOOLS[type]! : null;
}

export const IPC_TYPE_TOOLS: Readonly<Record<string, string>> = {
  fleet_schedule_create: "create_schedule",
  fleet_schedule_list: "list_schedules",
  fleet_schedule_update: "update_schedule",
  fleet_schedule_delete: "delete_schedule",
  fleet_decision_create: "post_decision",
  fleet_decision_list: "list_decisions",
  fleet_decision_update: "update_decision",
  fleet_task: "task",
  fleet_set_display_name: "set_display_name",
  fleet_set_description: "set_description",
};

/**
 * Agent-endpoint ops that never reach its `OP_MAP`.
 *
 * `dispatchAgentOperation` answers these before the map is consulted, so a
 * table built from the map alone would have six gaps in it.
 */
export const EARLY_AGENT_OP_TOOLS: Readonly<Record<string, string>> = {
  "schedule-create": "create_schedule",
  "schedule-list": "list_schedules",
  "schedule-update": "update_schedule",
  "schedule-delete": "delete_schedule",
  // `decision-post` is what agent-cli sends; the endpoint only looks at the
  // prefix, so both spellings reach the same handler and both need a name.
  "decision-post": "post_decision",
  "decision-create": "post_decision",
  "decision-list": "list_decisions",
  "decision-update": "update_decision",
  task: "task",
  usage: "get_usage",
  rename: "set_display_name",
  "set-description": "set_description",
};

/**
 * What to say to an agent that was refused.
 *
 * It will read this as an instruction, so it says what to do instead rather
 * than only what went wrong. Naming the profile matters too: "not allowed" with
 * no reason invites retrying.
 */
export function toolRefusedMessage(profile: ToolSetName, tool: string): string {
  return `${tool} is not available to this instance: it runs with the "${profile}" tool set, and ${tool} belongs to a coordinator. `
    + "Report what you need with report_result and let the coordinator do it, "
    + 'or ask an administrator to set `tool_set: coordinator` for this instance.';
}

/**
 * The profiles that may schedule work for, or manage the schedules of, OTHER
 * instances. Everyone else may still schedule — for itself only.
 */
const SCHEDULES_OTHERS: ReadonlySet<ToolSetName> = new Set<ToolSetName>(["full", "coordinator", "general"]);

export type ScheduleOp = "create" | "update" | "delete";

/**
 * Whether a schedule write is allowed, decided on its TARGET (#895).
 *
 * Having the tool is not the control: a worker holds create/update/delete so it
 * can schedule its own heartbeats and follow-ups. The control is here, and it
 * is pure so every case can be enumerated in a test.
 *
 * - `caller` is the instance the SERVER resolved for the request — the IPC
 *   connection or the agent token. Never a field of the request.
 * - create: the target is `requestedTarget`, or the caller when omitted.
 * - update: the existing schedule, AND `requestedTarget` when present. Checking
 *   only the existing one would let a worker create a schedule for itself and
 *   then `update {target: other}` — a bypass in two calls.
 * - update/delete: a non-coordinator may only touch a schedule it OWNS, meaning
 *   it targets the caller AND the caller created it. A heartbeat a coordinator
 *   put on a worker stays the coordinator's to change.
 *
 * Returns null when allowed, or the refusal to hand back to the agent.
 */
export function scheduleOpRefusal(
  profile: ToolSetName,
  caller: string,
  op: ScheduleOp,
  subject: { requestedTarget?: string | null; existing?: { target: string; source: string } | null },
): string | null {
  if (SCHEDULES_OTHERS.has(profile)) return null;
  const tool = `${op}_schedule`;
  const requested = subject.requestedTarget?.trim() || null;
  if (op === "create") {
    const target = requested ?? caller;
    return target === caller ? null : scheduleRefusedMessage(profile, tool, caller, `schedule work for "${target}"`);
  }
  const existing = subject.existing;
  // A schedule that does not exist is the scheduler's error to report; there
  // is nothing here to own or not own.
  if (!existing) return null;
  if (existing.target !== caller || existing.source !== caller) {
    return scheduleRefusedMessage(profile, tool, caller,
      existing.target !== caller
        ? `change a schedule that targets "${existing.target}"`
        : `change a schedule "${existing.source}" set for you`);
  }
  if (op === "update" && requested && requested !== caller) {
    return scheduleRefusedMessage(profile, tool, caller, `move a schedule onto "${requested}"`);
  }
  return null;
}

/** A schedule refusal the agent can act on, in the #884 shape: why, and what to do instead. */
function scheduleRefusedMessage(profile: ToolSetName, tool: string, caller: string, attempted: string): string {
  return `${tool} refused: under the "${profile}" tool set an instance may only manage its own schedules — `
    + `ones that target it ("${caller}") and that it created — so it cannot ${attempted}. `
    + "To schedule work for another instance, or change one set for you, ask a coordinator "
    + "with report_result or send_to_instance.";
}

/** Where a permission question came from. Recorded so the gaps stay visible. */
export type ToolSink = "ipc-outbound" | "ipc-typed" | "agent-endpoint";

export interface ToolUseRecord {
  readonly sink: ToolSink;
  readonly instance: string;
  readonly profile: ToolSetName;
  readonly tool: string;
  readonly allowed: boolean;
}
