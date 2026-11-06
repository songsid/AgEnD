// cc3ce4fe / #3243: the "Not yet verified / 尚未驗證" label in a real browser, on the product's own web server (the shared
// fixture: an in-process FleetManager in a scratch home, no CLI, no tmux). Inert DTOs: the Runtime API answers one paired
// computer whose Codex row the coordinator labelled "unverified" and whose Claude row "verified"; one fleet agent's
// status is a native Codex pane on that computer running an unverified 0.199.0. Per case (desk light en, phone dark
// zh-TW): the Runtime card's CLI table, the computer's CLI diagnostics and the agent's chat header each show exactly one
// label with its hover text; the verified row shows none; no page error, no CSP violation, no phone overflow.
// SKEW=<git rev>: the tab opened before the upgrade — app.css and app-i18n.js are that release's while the panels are this
// tree's (the label uses the existing .tag class and registers its own strings, so it must still read right).
//   PW_DIR=… REPO=… OUT=… [SKEW=rev] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-native-cli-unverified.mts
import { execFileSync } from "node:child_process";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-native-cli-unverified", REPO = process.env.REPO!, SKEW = process.env.SKEW || "";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48860), classic: false, instances: 4 });
const fm = fx.fm, agent = fx.instances[0]!.name, machineId = "12345678-1234-4321-abcd-123456789012";
const row = (id: string, version: string, paneVerification?: string) => ({ id, path: `C:\\tools\\${id}.exe`, version, authenticated: true, runnable: true, readOnlySupport: true,
  supports: { execution: true, resume: true, model: true, mcp: true }, permissionNote: "", models: [], ...(paneVerification ? { paneVerification } : {}) });
const inventory = { home: "C:\\Users\\dev", hostname: "BUILD-DESK", probedAt: Date.now(), clis: [row("codex", "codex-cli 0.199.0", "unverified"), row("claude-code", "2.1.316 (Claude Code)", "verified")] };
const machine = { id: machineId, name: "Build desktop", status: "online", platform: "win32", version: "2.3.5-alpha", lastSeenAt: Date.now(), inventoryUpdatedAt: Date.now(), inventory, runtimeCompatibility: "compatible", paneProtocol: 1 };
// The agent's status as the coordinator sends it for a native pane running an unverified launch.
const ui = fm.getUiStatus.bind(fm);
fm.getUiStatus = () => { const s: any = ui(); for (const i of s.instances ?? []) if (i.name === agent) Object.assign(i, { runtime: "windows", native_adapter: "pane", backend: "codex",
  machine_id: machineId, machine_name: "Build desktop", machine_status: "online", native_cli_version: "0.199.0", native_cli_verification: "unverified" }); return s; };
const OLD: Record<string, string> = {};
if (SKEW) for (const f of ["app.css", "app-i18n.js"]) OLD[f] = execFileSync("git", ["-C", REPO, "show", `${SKEW}:src/ui/shared/${f}`], { encoding: "utf8" });
async function routes(ctx: any) {
  await ctx.route(/\/ui\/runtimes(\?.*)?$/, (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true, machines: [machine] }) }));
  await ctx.route(/\/ui\/runtimes\/machines\/[^/]+\/(inventory|probe)(\?.*)?$/, (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ inventory }) }));
  await ctx.route(/\/ui\/runtimes\/machines\/[^/]+\/tasks(\?.*)?$/, (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tasks: [] }) }));
  if (SKEW) await ctx.route(/\/assets\/(app\.css|app-i18n\.js)(\?.*)?$/, (r: any) => {
    const f = new URL(r.request().url()).pathname.split("/").pop()!;
    r.fulfill({ status: 200, contentType: f.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body: OLD[f] });
  });
}
const T = { en: { label: "Not yet verified", hint: "has not tested this version in Windows panes" }, "zh-TW": { label: "尚未驗證", hint: "還沒在 Windows 面板中測試過這個版本" } } as const;
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  const failed: string[] = [], need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
  const name = `${c.device}-${c.theme}-${c.lang}${SKEW ? "-skew" : ""}`, t = T[c.lang], errors: string[] = [];
  const p = await freshPage(fx, c as any, { account: "operator", beforeNavigate: routes } as any);
  const page = p.page; page.on("pageerror", (e: Error) => errors.push(String(e)));
  try {
    await mounted(page, 30000);
    const tags = (sel: string) => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(x => [x.textContent, x.getAttribute("title") || ""])`) as Promise<[string, string][]>;
    // 1. Settings → Runtime: the computer's card.
    await page.goto(`${p.base}/settings/runtimes`);
    await page.waitForSelector(`[data-machine-id="${machineId}"] .runtime-cli-table`, { timeout: 20000 }); await page.waitForTimeout(400);
    const card = await tags(`[data-machine-id="${machineId}"] .runtime-cli-table .tag`);
    need(card.length === 1 && card[0]![0] === t.label && card[0]![1].includes(t.hint), `card label ${JSON.stringify(card)}`);
    await page.locator(`[data-machine-id="${machineId}"]`).screenshot({ path: shotPath(SMOKE, name, "1-runtime-card") });
    // 2. Its CLI diagnostics.
    await page.locator(`[data-machine-id="${machineId}"] .runtime-inspect`).click();
    await page.waitForSelector(".runtime-diagnostics-dialog .windows-cli-diagnostic-row", { timeout: 20000 }); await page.waitForTimeout(400);
    const diag = await tags(".runtime-diagnostics-dialog .windows-cli-diagnostic-row .tag");
    need(diag.length === 1 && diag[0]![0] === t.label && diag[0]![1].includes(t.hint), `diagnostics label ${JSON.stringify(diag)}`);
    await page.locator(".runtime-diagnostics-dialog").screenshot({ path: shotPath(SMOKE, name, "2-diagnostics") });
    // 3. The agent's chat header.
    await page.goto(`${p.base}/ui/chat/${encodeURIComponent(agent)}`);
    await page.waitForSelector(".native-cli-unverified", { state: "attached", timeout: 20000 }); await page.waitForTimeout(400);
    const head = await tags(".native-cli-unverified");
    // On a phone the header's whole status line (status, "Windows", the computer's name) is hidden by design: the label
    // follows it, never alone. On a desk it shows.
    const shown = (sel: string) => page.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`) as Promise<boolean | null>;
    const [mine, machineTag] = [await shown(".native-cli-unverified"), await shown(".runtime-machine-tag")];
    need(mine === machineTag && (c.device === "phone" || mine === true), `label visible like the computer tag (label ${mine}, computer ${machineTag})`);
    need(head.length === 1 && head[0]![0] === t.label && head[0]![1].startsWith("Codex 0.199.0") && head[0]![1].includes(t.hint), `chat header label ${JSON.stringify(head)}`);
    const overflow = await page.evaluate(`document.scrollingElement.scrollWidth - innerWidth`) as number;
    need(overflow <= 0, `no horizontal overflow (${overflow}px)`);
    await page.screenshot({ path: shotPath(SMOKE, name, "3-chat-header") });
    const all = [...errors, ...p.errors.filter((e: string) => !/auth\/session.*401|401.*auth\/session/.test(e))];
    need(all.length === 0, `page/console errors (incl. CSP) ${all.join(" | ").slice(0, 300)}`);
  } catch (e) { failed.push(`threw: ${String(e).slice(0, 300)}`); }
  finally { await p.ctx.close(); }
  results.push({ name, ok: failed.length === 0, failed });
}
console.log(JSON.stringify(results, null, 1));
await fx.close?.();
process.exit(results.every(r => r.ok) ? 0 : 1);
