// Controls for the fixture's own lifecycle (not the product): each runs as a child process and must leave no fixture
// listener, no scratch home and no browser behind.
//   - an occupied port is refused before any request reaches the listener holding it;
//   - close() releases both listeners, so the same ports bind again;
//   - a browser that cannot launch fails the boot and cleans up;
//   - an exception inside a case exits 1 and cleans up;
//   - a cleanup step that throws does not skip the others.
//   PW_DIR=… REPO=<checkout> [CHROME=…] npx tsx scripts/manual/smoke/fixture-controls.mts
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const FIXTURE = join(HERE, "../smoke-fixture/index.mts");
const scratch = mkdtempSync(join(tmpdir(), "fx-controls-"));
const homesBefore = new Set(readdirSync(tmpdir()).filter(n => n.startsWith("smoke-fx-")));
const newHomes = () => readdirSync(tmpdir()).filter(n => n.startsWith("smoke-fx-") && !homesBefore.has(n));
const free = (port: number) => new Promise<boolean>(r => { const s = createServer(); s.once("error", () => r(false)); s.listen(port, "127.0.0.1", () => s.close(() => r(true))); });
const child = (name: string, body: string, env: Record<string, string> = {}) => {
  const file = join(scratch, `${name}.mts`);
  writeFileSync(file, `import { bootFixture } from ${JSON.stringify(FIXTURE)};\n${body}\n`);
  const r = spawnSync("npx", ["--prefix", process.env.REPO!, "tsx", file], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 120000 });
  const lines = (r.stdout + r.stderr).split("\n").filter(l => l && !/DEP0040|trace-deprecation/.test(l));
  return { code: r.status, all: lines.join("\n"), out: lines.slice(-4).join(" | ") };
};
const results: Array<[string, boolean, string]> = [];
const check = async (name: string, ok: boolean, detail: string, ports: number[]) => {
  const portsFree = (await Promise.all(ports.map(free))).every(Boolean), homes = newHomes();
  results.push([name, ok && portsFree && homes.length === 0, `${detail}; ports free: ${portsFree}; leftover homes: ${homes.length}`]);
};

// 1. Occupied port: an inert listener on the health port; the fixture must refuse and never connect to it.
{
  const port = 48960; let connections = 0;
  const inert = createServer(sock => { connections++; sock.destroy(); });
  await new Promise<void>(r => inert.listen(port, "127.0.0.1", () => r()));
  const r = child("occupied", `await bootFixture({ port: ${port} }); console.log("BOOTED"); process.exit(0);`);
  await new Promise<void>(r2 => inert.close(() => r2()));
  await check("occupied port refused, zero requests", r.code !== 0 && /in use: refusing/.test(r.all) && connections === 0, `exit ${r.code}, connections ${connections}`, [port, port + 1]);
}
// 2. Close, then rebind the same ports in the same process.
{
  const port = 48964;
  const r = child("rebind", `const a = await bootFixture({ port: ${port}, instances: 3 }); await a.close();
const b = await bootFixture({ port: ${port}, instances: 3 }); const ok = (await fetch(b.base + "/signin")).status; await b.close(); console.log("REBIND", ok); process.exit(0);`);
  await check("close releases listeners; rebind works", r.code === 0 && /REBIND 200/.test(r.out), `exit ${r.code} ${r.out}`, [port, port + 1]);
}
// 3. A browser that cannot launch.
{
  const port = 48968;
  const r = child("badbrowser", `try { await bootFixture({ port: ${port}, instances: 3 }); console.log("BOOTED"); } catch (e) { console.log("REFUSED"); } process.exit(0);`, { CHROME: "/nonexistent/chrome" });
  await check("bad browser fails the boot and cleans up", r.code === 0 && /REFUSED/.test(r.out), `exit ${r.code} ${r.out}`, [port, port + 1]);
}
// 4. An exception inside a case.
{
  const port = 48972;
  const r = child("throws", `const fx = await bootFixture({ port: ${port}, instances: 3 }); throw new Error("case failed");`);
  await check("a case exception exits 1 and cleans up", r.code === 1, `exit ${r.code}`, [port, port + 1]);
}
// 5. One cleanup step throws (the browser's); the listeners and the home are still released.
{
  const port = 48976;
  const r = child("badclose", `const fx = await bootFixture({ port: ${port}, instances: 3 }); fx.browser.close = async () => { throw new Error("browser close failed"); };
await fx.close(); await fx.close(); console.log("CLOSED"); process.exit(0);`);
  await check("a throwing cleanup step skips nothing; close is idempotent", r.code === 0 && /CLOSED/.test(r.out) && /fixture close: browser/.test(r.out), `exit ${r.code} ${r.out}`, [port, port + 1]);
}
for (const [name, ok, detail] of results) console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
const fails = results.filter(r => !r[1]).length;
console.log(fails ? `${fails} FAIL` : `all ${results.length} PASS`);
process.exit(fails ? 1 : 0);
