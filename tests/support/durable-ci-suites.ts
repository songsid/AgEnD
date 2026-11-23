/** Durable fixture suites run once, serially, after CI shard1 to avoid shared worker contention. */
export const DURABLE_CI_SUITES = ["tests/fleet-manager.test.ts", "tests/hub-compose.test.ts", "tests/hub-directory-settings-decision.test.ts", "tests/hub-company-join-restart.test.ts", "src/delivery-outbox.test.ts"];
