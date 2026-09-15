/**
 * Capability carried only by authenticated, explicit instance-deletion
 * boundaries. Automatic topology observations must never manufacture one.
 */
const explicitRemovalBrand: unique symbol = Symbol("agend.explicit-instance-removal");

export type ExplicitInstanceRemovalSource = "dashboard-confirmed" | "delete-instance-tool";

export interface ExplicitInstanceRemoval {
  readonly source: ExplicitInstanceRemovalSource;
  readonly [explicitRemovalBrand]: true;
}

export function authorizeExplicitInstanceRemoval(source: ExplicitInstanceRemovalSource): ExplicitInstanceRemoval {
  return Object.freeze({ source, [explicitRemovalBrand]: true as const });
}

export function assertExplicitInstanceRemoval(value: unknown): asserts value is ExplicitInstanceRemoval {
  if (!value || typeof value !== "object" || (value as Partial<ExplicitInstanceRemoval>)[explicitRemovalBrand] !== true) {
    throw new Error("Refusing destructive instance removal without explicit authorization");
  }
}
