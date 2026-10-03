/**
 * Which fleet a bot speaks for (#1131 follow-up). Several AgEnD fleets can
 * share one Discord guild, each bot registering its own `/login`; the slash
 * menu then lists identical commands, and a picker answered by the wrong
 * fleet looked like a dead button. The label goes into those commands and
 * pickers: `fleet_label` from fleet.yaml, else this host's name, plus the
 * AgEnD home's directory name when it is not the default one.
 */
import { hostname } from "node:os";
import { basename } from "node:path";
import { getAgendHome, isDefaultAgendHome } from "./paths.js";

/** Longest label carried into a slash command description (Discord caps those at 100). */
export const FLEET_LABEL_MAX = 40;

export function fleetLabel(
  config: { fleet_label?: unknown } | null | undefined,
  home: string = getAgendHome(),
  host: string = hostname(),
): string {
  const configured = typeof config?.fleet_label === "string" ? config.fleet_label.trim() : "";
  const label = configured || (isDefaultAgendHome(home) ? host : `${host} · ${basename(home)}`);
  return label.length > FLEET_LABEL_MAX ? `${label.slice(0, FLEET_LABEL_MAX - 1)}…` : label;
}
