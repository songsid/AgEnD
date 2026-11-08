/**
 * The teams an instance is a member of (fleet.yaml `teams.<name>.members`), in fleet.yaml's order. Strings only.
 * Read live: a team decision reaches whoever is a member at list or launch time.
 */
export function instanceTeams(teams: Record<string, { members?: unknown }> | undefined | null, name: string): string[] {
  if (!teams || typeof teams !== "object") return [];
  return Object.keys(teams).filter(team => Array.isArray(teams[team]?.members) && (teams[team]!.members as unknown[]).includes(name));
}
