/** Offline browser cookie control for #3435 R1. Dummy cookies, two owned TLS listeners, no real session or AD. */
import { createServer } from "node:https";
import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
const repo = resolve(process.env.REPO ?? process.cwd()), out = resolve(process.env.OUT ?? join(repo, ".artifacts/hub-company-join/cookie-control"));
mkdirSync(out, { recursive: true });
const { makeTestCerts } = await import(repo + "/tests/support/hub-init-fixtures.ts");
const { companyFlowCookieName } = await import(repo + "/src/hub/join/http.ts");
const certs = makeTestCerts("hub.example.test"), hubId = randomUUID(), flowId = randomUUID();
const hubCookie = "__Host-agend_hub_" + hubId, flowCookie = companyFlowCookieName(hubId, flowId), fleetCookie = "agend_session";
const seen: string[] = [], servers = [0, 1].map(() => createServer({ key: readFileSync(certs.key), cert: readFileSync(certs.cert) }, (req, res) => {
  seen.push(req.headers.cookie ?? ""); res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end("Owned offline cookie probe\n" + (req.headers.cookie || "No cookies"));
}));
let browser: any;
const checks: string[] = [], check = (name: string, pass: boolean) => { if (!pass) throw Error(name); checks.push(name); };
try {
  for (const s of servers) await new Promise<void>((done, reject) => { s.once("error", reject); s.listen(0, "127.0.0.1", done); });
  const ports = servers.map(s => (s.address() as { port: number }).port), hub = `https://hub.example.test:${ports[0]}`;
  const same = `https://hub.example.test:${ports[1]}`, separate = `https://fleet.example.test:${ports[1]}`;
  const pw = createRequire(resolve(process.env.PW_DIR ?? repo) + "/")("playwright-core");
  browser = await pw.chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox", "--host-resolver-rules=MAP hub.example.test 127.0.0.1, MAP fleet.example.test 127.0.0.1"] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 } });
  await ctx.route("**/*", (route: any) => [hub, same, separate].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
  const cookie = (name: string, url: string) => ({ name, value: "dummy-cookie-control", url, httpOnly: true, secure: true, sameSite: "Strict" as const });
  const page = await ctx.newPage();
  await ctx.addCookies([cookie(hubCookie, hub), cookie(flowCookie, hub), cookie(fleetCookie, same)]);
  await page.goto(same + "/probe");
  check("same-hostname cross-port control sends all three ambient cookies", [hubCookie, flowCookie, fleetCookie].every(name => seen.at(-1)!.includes(name + "=")));
  await page.screenshot({ path: join(out, "same-hostname-control.png") });
  await ctx.clearCookies();
  await ctx.addCookies([cookie(hubCookie, hub), cookie(flowCookie, hub), cookie(fleetCookie, separate)]);
  await page.goto(separate + "/probe");
  check("different Fleet hostname receives only its Fleet cookie", seen.at(-1)!.includes(fleetCookie + "=") && !seen.at(-1)!.includes(hubCookie) && !seen.at(-1)!.includes(flowCookie));
  await page.screenshot({ path: join(out, "different-hostname-fleet.png") });
  await page.goto(hub + "/probe");
  check("Hub hostname receives Hub/flow cookies and no Fleet cookie", seen.at(-1)!.includes(hubCookie + "=") && seen.at(-1)!.includes(flowCookie + "=") && !seen.at(-1)!.includes(fleetCookie));
  await page.screenshot({ path: join(out, "different-hostname-hub.png") });
  await ctx.close();
  writeFileSync(join(out, "results.json"), JSON.stringify({ status: "PASS", checks, scope: "Offline dummy-cookie control, actual browser attributes, owned TLS listeners; no real credentials, sessions or AD. Owned fixture certificate acceptance is not PKI validation." }, null, 2));
  console.log(JSON.stringify({ status: "PASS", checks: checks.length, out }));
} finally {
  await browser?.close();
  for (const s of servers) if (s.listening) { s.closeAllConnections(); await new Promise<void>(done => s.close(() => done())); }
  rmSync(certs.dir, { recursive: true, force: true });
}
