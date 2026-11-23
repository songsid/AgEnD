/** Durable fixture suites run once, serially, after CI shard1 to avoid shared worker contention. */
export const DURABLE_CI_SUITES = ["tests/fleet-manager.test.ts", "src/delivery-outbox.test.ts"];
