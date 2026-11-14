import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { fleetVersionState, HUB_FLEET_VERSIONS_MIGRATION } from "../src/hub/fleet-versions.js";
import { applyHubMigrations } from "../src/hub/db.js";
import { parseMemberFrame, encodeMemberFrame } from "../src/hub/protocol.js";
const caps = ["welcome-caps-v1", "room-ask-v1"];
it("orders capability, recommendation and unknown states using SemVer rather than lexical comparison", () => {
  expect(fleetVersionState("3.0.0", [], "2.4.0")).toBe("too-old-rooms");
  expect(fleetVersionState(null, [], null)).toBe("too-old-rooms");
  expect(fleetVersionState(null, null, null)).toBe("unknown");
  expect(fleetVersionState(null, caps, "2.4.0")).toBe("unknown");
  expect(fleetVersionState("2.4.0-beta.9", caps, "2.4.0-beta.10")).toBe("needs-update");
  expect(fleetVersionState("2.4.0-beta.10", caps, "2.4.0")).toBe("needs-update");
  expect(fleetVersionState("2.4.0+build", caps, "2.4.0")).toBe("current");
  expect(fleetVersionState("3.0.0", caps, "2.4.0")).toBe("current");
  expect(fleetVersionState("2.3.5", caps, null)).toBe("current");
});
it("accepts only bounded version/service values and never takes an identity or a report timestamp", () => {
  const frame = { v: 1 as const, type: "fleet.info" as const, requestId: randomUUID(), linkEpoch: 1,
    payload: { version: "2.4.0-beta.4", runsAsService: false } };
  expect(parseMemberFrame(encodeMemberFrame(frame))).toEqual(frame);
  for (const payload of [ { ...frame.payload, version: "x" }, { ...frame.payload, version: "2.4.0+" + "x".repeat(128) },
    { ...frame.payload, runsAsService: 0 }, { ...frame.payload, fleetId: randomUUID() }, { ...frame.payload, at: 5 } ]) {
    expect(() => parseMemberFrame(JSON.stringify({ ...frame, payload }))).toThrow();
  }
});
it("adds its own schema component, retains a report, and makes an older migration plan refuse it", () => {
  const db = new Database(":memory:");
  try {
    applyHubMigrations(db, [HUB_FLEET_VERSIONS_MIGRATION]);
    db.prepare("INSERT INTO hub_fleet_versions VALUES(?,?,?,?,?,?)").run(randomUUID(), "2.4.0", 0, 10, 9, "[]");
    applyHubMigrations(db, [HUB_FLEET_VERSIONS_MIGRATION]);
    expect(db.prepare("SELECT version FROM hub_fleet_versions").get()).toEqual({ version: "2.4.0" });
    expect(() => applyHubMigrations(db, [])).toThrow("s3-fleet-versions");
  } finally { db.close(); }
});

it("keeps even a failing diagnostic logger out of the connection path", async () => {
  const { warnFleetDiagnostics } = await import("../src/hub/fleet-info.js");
  expect(() => warnFleetDiagnostics(() => { throw Error("logger unavailable"); }, randomUUID(), "connect")).not.toThrow();
});
