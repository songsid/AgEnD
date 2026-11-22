/** Synthetic identities while retaining the shared fixture's layout/role/backend stress. */
import { fixtureInstances, type FixtureInstance } from "./data.mts";
export function publicRoster(count = 6): FixtureInstance[] {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("invalid public fixture size");
  const templates = fixtureInstances();
  return Array.from({ length: count }, (_, i) => {
    const template = templates[i % templates.length]!;
    return { ...template,
      name: i === 0 ? "general" : `example-agent-${String(i).padStart(2, "0")}`,
      displayName: i === 0 ? "General" : template.general ? `Example agent ${i}` : template.displayName || `Example agent ${i}`,
      general: i === 0,
    };
  });
}
