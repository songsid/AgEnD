/**
 * Timezone helpers for event-db values.
 *
 * event-db (events/activity) stores timestamps as SQLite `datetime('now')` —
 * "YYYY-MM-DD HH:MM:SS" in **UTC**, with no zone suffix. Storage stays UTC; these
 * helpers convert only for DISPLAY (UTC→local) and QUERY BOUNDARIES (local→UTC),
 * so user-facing times match the local convention used by chat-logs and fleet.log.
 *
 * TZ source matches the chat-log path: `process.env.TZ` override, else the
 * system/Intl resolved zone.
 */

export function resolveTz(): string {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Convert a UTC event-db datetime string ("YYYY-MM-DD HH:MM:SS") to the same
 * format in local `tz`. Unparseable input is returned unchanged.
 */
export function utcDbToLocal(utcDbStr: string, tz = resolveTz()): string {
  const d = new Date(utcDbStr.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return utcDbStr;
  // sv-SE renders ISO-like "YYYY-MM-DD HH:MM:SS".
  return d.toLocaleString("sv-SE", { timeZone: tz, hour12: false });
}

/**
 * Convert a local wall-clock string ("YYYY-MM-DD HH:MM:SS", interpreted in `tz`)
 * to the UTC "YYYY-MM-DD HH:MM:SS" string matching event-db storage — for use as
 * a range-query boundary. DST-safe via an offset round-trip. Unparseable input is
 * returned unchanged.
 */
export function localWallToUtcDb(wall: string, tz = resolveTz()): string {
  const asIfUtc = new Date(wall.replace(" ", "T") + "Z").getTime();
  if (Number.isNaN(asIfUtc)) return wall;
  // Render that instant in tz; the gap back to "as-if-UTC" is the zone offset at
  // that instant (handles DST because it is sampled near the target instant).
  const shownInTz = new Date(asIfUtc).toLocaleString("sv-SE", { timeZone: tz, hour12: false });
  const offset = new Date(shownInTz.replace(" ", "T") + "Z").getTime() - asIfUtc;
  return new Date(asIfUtc - offset).toISOString().slice(0, 19).replace("T", " ");
}

/** Local "today" date ("YYYY-MM-DD") in `tz`. */
export function localTodayDate(tz = resolveTz()): string {
  return new Date().toLocaleString("sv-SE", { timeZone: tz, hour12: false }).slice(0, 10);
}
