import { describe, expect, it } from "vitest";
import { utcDbToLocal, localWallToUtcDb, localTodayDate } from "../src/tz-utils.js";

const TPE = "Asia/Taipei";       // UTC+8, no DST
const NYC = "America/New_York";  // EDT -4 (summer) / EST -5 (winter)

describe("tz-utils", () => {
  it("utcDbToLocal: UTC event-db string → local (UTC+8)", () => {
    expect(utcDbToLocal("2026-07-25 06:00:00", TPE)).toBe("2026-07-25 14:00:00");
    // crosses date boundary
    expect(utcDbToLocal("2026-07-25 18:00:00", TPE)).toBe("2026-07-26 02:00:00");
  });

  it("localWallToUtcDb: local wall → UTC event-db string (UTC+8)", () => {
    expect(localWallToUtcDb("2026-07-25 14:00:00", TPE)).toBe("2026-07-25 06:00:00");
    // local early morning → previous UTC day
    expect(localWallToUtcDb("2026-07-25 02:00:00", TPE)).toBe("2026-07-24 18:00:00");
  });

  it("is DST-safe (New York: EDT -4 vs EST -5)", () => {
    expect(localWallToUtcDb("2026-07-15 09:00:00", NYC)).toBe("2026-07-15 13:00:00"); // summer -4
    expect(localWallToUtcDb("2026-01-15 09:00:00", NYC)).toBe("2026-01-15 14:00:00"); // winter -5
  });

  it("round-trips local → UTC → local", () => {
    const utc = localWallToUtcDb("2026-07-25 14:00:00", TPE);
    expect(utcDbToLocal(utc, TPE)).toBe("2026-07-25 14:00:00");
  });

  it("returns unparseable input unchanged", () => {
    expect(utcDbToLocal("not-a-date", TPE)).toBe("not-a-date");
    expect(localWallToUtcDb("garbage", TPE)).toBe("garbage");
  });

  it("localTodayDate returns YYYY-MM-DD", () => {
    expect(localTodayDate(TPE)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
