// Shared Settings preview: use raw ownership, never expanded live config.
const effectiveIdentity = (inst, defaults) => {
  const backend = inst.backend || defaults.backend || "claude-code";
  const model = inst.model?.trim() || (inst.runtime !== "windows" && backend === (defaults.backend || "claude-code") ? defaults.model?.trim() : "") || "";
  return [backend, model];
};
export const defaultIdentityTargets = (fleet, next) => Object.entries(fleet?.instances || {}).filter(([, inst]) => {
  const before = effectiveIdentity(inst, fleet?.defaults || {}), after = effectiveIdentity(inst, next);
  return before.some((v, i) => v !== after[i]);
}).map(([name]) => name);

export const defaultClassicTargets = (classic, before, after) => {
  const d = classic?.defaults || {};
  const values = (room, fleet) => {
    const backend = room.backend || d.backend || fleet.backend || "claude-code";
    const classicBackend = d.backend || fleet.backend || "claude-code";
    return [backend, room.model || (backend === classicBackend && d.model)
      || (backend === (fleet.backend || "claude-code") && fleet.model) || ""];
  };
  return Object.entries(classic?.channels || {}).filter(([, room]) => room && typeof room === "object").filter(([, room]) => {
    const a = values(room, before), b = values(room, after);
    return a.some((v, i) => v !== b[i]);
  }).map(([key, room]) => ({ key, instanceName: room.instanceName }));
};
