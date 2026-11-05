/** Real reachability loop with queued HTTP results and an injected elapsed clock; no listener race or real sleep. */
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractPsFunction } from "./support/installer-ps-extract.js";
import { installerPwshBatch, withInstallerClock } from "./support/installer-pwsh-fixture.js";
const source = readFileSync(join(import.meta.dirname, "..", "website/public/install-agend.ps1"), "utf8");
const prelude = withInstallerClock(extractPsFunction(source, "Wait-SetupPageReachable"));
const scenario = (kind: "http" | "delayed" | "closed", seconds: number) => `
$script:calls = 0
function Invoke-WebRequest { param($Uri, [switch]$UseBasicParsing, $TimeoutSec, $MaximumRedirection, $ErrorAction)
  $script:calls++
  if ($Uri -ne 'http://127.0.0.1:19280/s/scratch/' -or $TimeoutSec -ne 3 -or $MaximumRedirection -ne 0 -or -not $UseBasicParsing) { throw 'Wrong HTTP boundary' }
  ${kind === "http" ? "$failure = [Net.WebException]::new('404'); $failure | Add-Member -NotePropertyName Response -NotePropertyValue ([pscustomobject]@{ StatusCode = 404 }) -Force; throw $failure" : kind === "delayed" ? "if ($script:FixtureMilliseconds -ge 2500) { return [pscustomobject]@{ StatusCode = 200 } }; throw 'No listener yet'" : "throw 'No listener'"}
}
Write-Output ('REACHABLE=' + (Wait-SetupPageReachable 'http://127.0.0.1:19280/s/scratch/' ${seconds}))
Write-Output ('ELAPSED=' + $script:FixtureMilliseconds + ' CALLS=' + $script:calls)
`;
const batch = installerPwshBatch({ installer: prelude }, {
  http: { prelude: "installer", body: scenario("http", 10) },
  delayed: { prelude: "installer", body: scenario("delayed", 15) },
  closed: { prelude: "installer", body: scenario("closed", 3) },
});
afterAll(batch.cleanup);
const output = (name: string) => { expect(batch.results[name]?.error).toBeNull(); return batch.results[name]!.out; };
describe.skipIf(!batch.available)("stage 5 opens the page only after Windows can reach it", () => {
  it("any HTTP answer counts, including 404, with no wait", () => { expect(output("http")).toContain("REACHABLE=True"); expect(output("http")).toContain("ELAPSED=0 CALLS=1"); });
  it("a listener appearing later is retried until its first answer", () => { expect(output("delayed")).toContain("REACHABLE=True"); expect(output("delayed")).toContain("ELAPSED=2500 CALLS=6"); });
  it("never reachable: false at its configured bound, not before", () => { expect(output("closed")).toContain("REACHABLE=False"); expect(output("closed")).toContain("ELAPSED=3000 CALLS=6"); });
});
