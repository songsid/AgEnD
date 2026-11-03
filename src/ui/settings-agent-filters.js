// View-only Agent list filters. They never stage settings or read another endpoint.
import { html } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { instanceMachineId } from "./runtime-catalog.js";

register("agentFilters", {
  en: {
    title: "Filter Agents", runtime: "Runtime", status: "Status", allRuntimes: "All Runtimes", allStatuses: "All statuses",
    local: "Windows local", remote: "Windows remote", machine: "Windows remote · {0}", unknownRuntime: "Unknown Runtime",
    running: "Running", paused: "Paused", stopped: "Stopped", crashed: "Crashed", unknown: "Unknown status", offline: "Runtime offline",
    results: "Showing {0} of {1} Agents", clear: "Clear filters", noMatch: "No matching Agents", noMatchHint: "Try a different search, Runtime, or status.",
  },
  "zh-TW": {
    title: "篩選 Agent", runtime: "Runtime", status: "狀態", allRuntimes: "所有 Runtime", allStatuses: "所有狀態",
    local: "Windows 本機", remote: "Windows 遠端", machine: "Windows 遠端 · {0}", unknownRuntime: "未知 Runtime",
    running: "執行中", paused: "已暫停", stopped: "已停止", crashed: "已當掉", unknown: "未知狀態", offline: "Runtime 離線",
    results: "顯示 {0} / {1} 個 Agent", clear: "清除篩選", noMatch: "沒有符合條件的 Agent", noMatchHint: "請調整搜尋、Runtime 或狀態。",
  },
});
export const agentFilterText = (key, ...values) => t(`agentFilters.${key}`, ...values);
const STATUSES = ["running", "paused", "stopped", "crashed"];

/** Missing runtime is the configured WSL default; invalid explicit values are not WSL. */
export function agentRuntime(inst, live) {
  if (inst?.runtime === undefined || inst?.runtime === "wsl") return { kind: "wsl", machineId: "", label: "WSL / Linux" };
  if (inst?.runtime !== "windows") return { kind: "unknown", machineId: "", label: agentFilterText("unknownRuntime") };
  const id = instanceMachineId(inst);
  if (id && typeof id !== "string") return { kind: "unknown", machineId: "", label: agentFilterText("unknownRuntime") };
  if (!id) return { kind: "windows-local", machineId: "", label: agentFilterText("local") };
  const name = inst.machine_name || (instanceMachineId(live) === id ? live?.machine_name : "");
  return { kind: "windows-remote", machineId: id, label: agentFilterText("machine", name || id) };
}

/** Unknown/unreadable snapshots must not be reported as stopped. */
export function agentStatus(live) {
  return STATUSES.includes(live?.status) ? live.status : "unknown";
}
export const agentRuntimeOffline = (inst, live) => agentRuntime(inst, live).kind === "windows-remote" && live?.machine_status === "offline";

/** Search and grouping have already run; preserve their ordering and group identities. */
export function filterAgentGroups(groups, instances, live, { runtime = "", status = "" } = {}) {
  return groups.map((group) => ({ ...group, names: group.names.filter((name) => {
    const target = agentRuntime(instances[name], live[name]);
    const matchesRuntime = !runtime || (runtime.startsWith("machine:") ? target.machineId === runtime.slice(8) && target.kind === "windows-remote" : target.kind === runtime);
    const matchesStatus = !status || (status === "runtime-offline" ? agentRuntimeOffline(instances[name], live[name]) : agentStatus(live[name]) === status);
    return matchesRuntime && matchesStatus;
  }) })).filter((group) => group.names.length);
}

export function AgentFilters({ instances, live, runtime, status, matched, total, active, onRuntime, onStatus, onClear }) {
  const machines = new Map();
  let unknownRuntime = runtime === "unknown", offline = status === "runtime-offline";
  for (const [name, inst] of Object.entries(instances)) {
    const target = agentRuntime(inst, live[name]);
    if (target.machineId) machines.set(target.machineId, target.label);
    if (target.kind === "unknown") unknownRuntime = true;
    if (agentRuntimeOffline(inst, live[name])) offline = true;
  }
  // Preserve a selected machine across a snapshot/config refresh instead of silently selecting another Runtime.
  if (runtime.startsWith("machine:") && !machines.has(runtime.slice(8))) machines.set(runtime.slice(8), agentFilterText("machine", runtime.slice(8)));
  return html`<div class="s-agent-filters" role="group" aria-label=${agentFilterText("title")}>
    <div class="s-agent-filter-controls">
      <label><span>${agentFilterText("runtime")}</span><select value=${runtime} onChange=${(event) => onRuntime(event.target.value)}>
        <option value="">${agentFilterText("allRuntimes")}</option><option value="wsl">WSL / Linux</option><option value="windows-local">${agentFilterText("local")}</option><option value="windows-remote">${agentFilterText("remote")}</option>
        ${[...machines].sort((a, b) => a[1].localeCompare(b[1])).map(([id, label]) => html`<option key=${id} value=${`machine:${id}`}>${label}</option>`)}
        ${unknownRuntime ? html`<option value="unknown">${agentFilterText("unknownRuntime")}</option>` : null}
      </select></label>
      <label><span>${agentFilterText("status")}</span><select value=${status} onChange=${(event) => onStatus(event.target.value)}>
        <option value="">${agentFilterText("allStatuses")}</option>${[...STATUSES, "unknown"].map((value) => html`<option key=${value} value=${value}>${agentFilterText(value)}</option>`)}
        ${offline ? html`<option value="runtime-offline">${agentFilterText("offline")}</option>` : null}
      </select></label>
      <button type="button" class="btn btn-sm s-agent-filter-clear" disabled=${!active} onClick=${onClear}>${agentFilterText("clear")}</button>
    </div>
    <p class="s-agent-filter-count" role="status" aria-live="polite">${agentFilterText("results", matched, total)}</p>
  </div>`;
}
