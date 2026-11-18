import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const rows: any[] = JSON.parse(readFileSync(new URL("./fixtures/classic-cli-guard-m3339/observations.json", import.meta.url), "utf8"));
it("retains per-version real CLI allow, deny, load and fail-closed observations", () => {
  expect(rows).toHaveLength(41);
  for (const version of ["2.1.295", "2.1.327"]) {
    const cases = rows.filter(r => r.version === version); expect(cases).toHaveLength(20);
    expect(cases.find(r => r.case === "backend-reply").reportedVersion).toBe(version);
    const get = (name: string) => { const r = cases.find(r => r.case === name); expect(r, name).toBeTruthy(); expect(r.exit).toBe(0); return r; };
    for (const name of ["reply", "selected", "backend-reply", "owner-selected"]) { const r = get(name); expect(r.state).toBe("ready"); expect(r.calls).toHaveLength(1); }
    for (const name of ["public-search", "public-fetch"]) {
      const r = get(name); expect(r.results.every((p: any) => !p.error)).toBe(true);
      expect(JSON.stringify(r.results)).toContain(name === "public-fetch" ? "PUBLIC_FETCH_OK" : "PUBLIC_SEARCH_OK");
    }
    for (const name of ["bash", "read", "write", "agent", "other-selected-tool", "agend-admin"]) {
      const r = get(name); expect(r.calls).toHaveLength(0); expect(r.results.some((p: any) => p.error)).toBe(true);
    }
    for (const name of ["missing-hook", "crashing-hook", "timed-out-hook"]) {
      const r = get(name); expect(r.state).toBe("failed"); expect(r.calls).toHaveLength(0);
      expect(r.results.some((p: any) => p.text.includes('blocking because onFailure is "block"'))).toBe(true);
    }
    expect(get("owner-missing").state).toBe("not-covered");
    expect(get("owner-missing").results.every((p: any) => !p.error)).toBe(true);
    expect(get("public-off").results.some((p: any) => p.error)).toBe(true);
    expect(get("missing-start").modelRequests).toBe(0);
    expect(get("stale-policy").state).toBe("restart-required"); expect(get("stale-policy").calls).toHaveLength(0);
    expect(get("inheritance").starts.map((s: any) => s.server).sort()).toEqual(["agend", "selected"]);
  }
  const control = rows.find(r => r.version === "2.1.294");
  expect(control).toMatchObject({ controlOnly: true, case: "missing-hook", state: "failed" }); expect(control.calls).toHaveLength(1);
});
