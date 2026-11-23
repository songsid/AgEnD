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

/** One identity form for preview, confirmation and result rows. */
export const defaultIdentityRecord = (name, fleet, classic, live = {}) => {
  const room = Object.values(classic?.channels || {}).find(room => room?.instanceName === name);
  const display = live[name]?.display_name || fleet?.instances?.[name]?.display_name || room?.display_name || room?.name;
  return { name, ...(typeof display === "string" && display.trim() ? { display_name: display.trim() } : {}) };
};
/** Unknown/paused/stopped owners are deferred. The confirm never guesses they run. */
export const runningDefaultIdentityTargets = (fleet, classic, live = {}, next) => {
  const names = new Set([...defaultIdentityTargets(fleet, next),
    ...defaultClassicTargets(classic, fleet?.defaults || {}, next).map(room => room.instanceName).filter(Boolean)]);
  return [...names].filter(name => live[name]?.status === "running").map(name => {
    const row = defaultIdentityRecord(name, fleet, classic, live);
    return { name, label: row.display_name || name };
  });
};
