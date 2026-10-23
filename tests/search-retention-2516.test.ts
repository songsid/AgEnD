/**
 * #2516: default search retention is no age limit (unset and 0); ROW_CAP still prunes; an explicit day count still
 * age-prunes. Mutation proofs for SEARCH_RETENTION_DAYS and searchAgeCutoff (naive `now - 0 * day` would wipe the index).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SEARCH_RETENTION_DAYS, searchAgeCutoff } from "../src/search/search-index.js";
import { ROW_CAP, SearchStore, type SearchDoc } from "../src/search/search-store.js";

const dirs: string[] = [];
const stores: SearchStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
function store(): SearchStore {
  const dir = mkdtempSync(join(tmpdir(), "search-2516-")); dirs.push(dir);
  const s = new SearchStore(join(dir, "search.db")); stores.push(s); return s;
}
const T0 = Date.UTC(2026, 9, 1);
let n = 0;
function doc(over: Partial<SearchDoc> & { text: string }): SearchDoc {
  n++;
  return { key: `chat:dev:b-${n}`, source: "chat", instance: "dev", sender: "han", role: "user", ts: T0 + n * 1000, ref: { boot: "b", id: n }, ...over };
}

describe("searchAgeCutoff / SEARCH_RETENTION_DAYS (#2516)", () => {
  it("unset default is 0 (no age limit), not 90", () => {
    expect(SEARCH_RETENTION_DAYS).toBe(0);
  });
  it("0 and non-positive days yield cutoff 0, never `now` (which would prune everything)", () => {
    const now = T0 + 100 * 86400_000;
    expect(searchAgeCutoff(now, 0)).toBe(0);
    expect(searchAgeCutoff(now, 0)).not.toBe(now);
    expect(searchAgeCutoff(now, SEARCH_RETENTION_DAYS)).toBe(0);
    expect(searchAgeCutoff(now, -1)).toBe(0);
    expect(searchAgeCutoff(now, Number.NaN)).toBe(0);
    expect(searchAgeCutoff(now, Number.POSITIVE_INFINITY)).toBe(0);
  });
  it("a positive day count still age-prunes", () => {
    const now = T0 + 100 * 86400_000;
    expect(searchAgeCutoff(now, 90)).toBe(now - 90 * 24 * 3600_000);
    expect(searchAgeCutoff(now, 1)).toBe(now - 24 * 3600_000);
  });
  it("fleet coalescing: unset and 0 keep SEARCH_RETENTION_DAYS; a positive value wins (`??` keeps 0)", () => {
    const days = (v: number | undefined) => v ?? SEARCH_RETENTION_DAYS;
    expect(days(undefined)).toBe(0);
    expect(days(0)).toBe(0);
    expect(days(14)).toBe(14);
  });
});

describe("SearchStore prune (#2516)", () => {
  it("cutoff 0 never age-prunes: a 100-day-old row stays under the cap", () => {
    const s = store();
    s.add([doc({ text: "ancient nginx", ts: T0 }), doc({ text: "recent nginx", ts: T0 + 100 * 86400_000 })]);
    expect(s.prune(0, 100, 100)).toEqual({ removed: 0, more: false });
    expect(s.count()).toBe(2);
    expect(s.search({ q: "ancient" }).hits.map(h => h.key).length).toBe(1);
  });
  it("cutoff 0 still prunes the oldest past the cap", () => {
    const s = store();
    s.add(Array.from({ length: 8 }, (_, i) => doc({ text: `row ${i} nginx`, ts: T0 + i })));
    expect(s.prune(0, 5, 100)).toEqual({ removed: 3, more: false });
    expect(s.count()).toBe(5);
    expect(s.search({ q: "row 0" }).hits).toEqual([]);
    expect(s.search({ q: "row 7" }).hits.length).toBe(1);
  });
  it("an explicit age cutoff still removes older rows, then the cap", () => {
    const s = store();
    s.add([
      doc({ text: "old nginx", ts: T0 }),
      doc({ text: "mid nginx", ts: T0 + 10 }),
      doc({ text: "new nginx", ts: T0 + 20 }),
    ]);
    expect(s.prune(T0 + 5, 100, 100)).toEqual({ removed: 1, more: false });
    expect(s.search({ q: "old" }).hits).toEqual([]);
    expect(s.search({ q: "mid" }).hits.length).toBe(1);
    expect(s.search({ q: "new" }).hits.length).toBe(1);
  });
  it("ROW_CAP is still 300,000", () => {
    expect(ROW_CAP).toBe(300_000);
  });
});
