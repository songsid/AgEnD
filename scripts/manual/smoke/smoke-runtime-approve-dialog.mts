// Settings → Runtime — a computer asking to pair opens an approval dialog, waiting computers come first under a
// "N computers are waiting" bar, and computers with the same name can be told apart. In a real browser on the shared fixture
// (the product's own web server, a scratch home, no fleet start). The Runtime reads answer synthetic paired computers (all
// names and ids are made up); the writes this page makes (approve, reject) are answered here and recorded, nothing is paired.
// Every matrix case (desk/phone × light/dark × en/zh-TW):
//   - the dialog opens by itself, the pairing fingerprint is large, Approve is off for the first second and then on;
//   - Later closes it (no request) and it does not open again on the next poll; the bar and the first card show the waiting
//     computer; the two "Demo-notebook" cards are #1 and #2 with a time and an id;
//   - the focus is not on any button (Enter cannot approve);
//   - the bar opens it again, Approve sends the fingerprint, the card turns online;
//   - a computer that starts waiting afterwards opens it alone (the ones put off stay shut), Reject sends the reject route and leaves no card;
//   - a request that has expired opens nothing, says so on its card and has no Approve;
//   - no page error, no CSP report, no horizontal scroll, every dialog button ≥ 44 px on the phone.
// LABEL=base: the before pictures only (the waiting computer's card is far down the list).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [LABEL=base|branch] [MATRIX=full] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-runtime-approve-dialog.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-runtime-approve-dialog";
const LABEL = process.env.LABEL ?? "branch", BASE = LABEL === "base";
const r: Record<string, unknown> = { label: LABEL };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const ID = { first: "3f9a1c2e-1234-4321-abcd-123456789012", lab: "c25e8f10-1234-4321-abcd-123456789012", second: "b71d04e9-1234-4321-abcd-123456789012", bench: "d4410a77-1234-4321-abcd-123456789012", old: "e8890b21-1234-4321-abcd-123456789012" };
const FINGERPRINT = "7A4C-9E21-B0D3";
const T0 = Date.UTC(2026, 10, 8, 14, 22, 0);
const cli = (id: string, version: string) => ({ id, path: `C:\\tools\\${id}.exe`, runnable: true, authenticated: true, version, supports: { execution: true, resume: true, mcp: true }, models: [] });
const runtimeInfo = { version: "2.3.5-alpha", buildId: "a".repeat(64), protocolVersions: [1], capabilities: ["exec", "mcp", "panes", "credential-profiles", "remote-setup", "cli-install"] };
const fresh = () => [
  { id: ID.first, name: "Demo-notebook", status: "online", platform: "win32", hostname: "DEMO-NB", createdAt: T0, approvedAt: T0 + 60_000, lastSeenAt: Date.now(), inventoryUpdatedAt: Date.now(), runtimeInfo,
    inventory: { home: "C:\\Users\\demo", clis: [cli("codex", "codex-cli 0.164.0"), cli("claude-code", "2.1.302 (Claude Code)"), cli("antigravity", "1.5.0")] } },
  { id: ID.lab, name: "Lab-desktop", status: "online", platform: "win32", hostname: "LAB-DESK-01", createdAt: T0 + 600_000, approvedAt: T0 + 660_000, lastSeenAt: Date.now(), inventoryUpdatedAt: Date.now(), runtimeInfo,
    inventory: { home: "C:\\Users\\lab", clis: [cli("codex", "codex-cli 0.164.0")] } },
  { id: ID.second, name: "Demo-notebook", status: "pending", platform: "win32", hostname: "DEMO-NB", createdAt: T0 + 1_860_000, pairingFingerprint: FINGERPRINT },
];
const fx = await bootFixture({ port: 47460, instances: 4 });
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
try {
  for (const c of matrix(process.env.MATRIX ?? "full")) {
    const cn = caseName(c), phone = c.device === "phone", zh = c.lang === "zh-TW";
    const { ctx, page, csp } = await fx.page(c, { path: "/settings/agents" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    let machines = fresh();
    const writes: Array<{ path: string; body: unknown }> = [];
    let reads = 0;
    await page.route(/\/ui\/runtimes(\/.*)?(\?.*)?$/, async (route: any) => {
      const url = new URL(route.request().url()), method = route.request().method();
      if (url.pathname === "/ui/runtimes") { reads++; return route.fulfill(json({ enabled: true, machines })); }
      const act = /^\/ui\/runtimes\/machines\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
      if (act && method === "POST") {
        writes.push({ path: url.pathname, body: route.request().postDataJSON() });
        machines = act[2] === "approve" ? machines.map((m: any) => m.id === act[1] ? { ...m, status: "online", approvedAt: Date.now(), pairingFingerprint: undefined, inventory: { home: "C:\\Users\\demo", clis: [cli("codex", "codex-cli 0.164.0")] } } : m)
          : machines.map((m: any) => m.id === act[1] ? { ...m, status: "revoked" } : m);
        return route.fulfill(json({ machine: machines.find((m: any) => m.id === act[1]) }));
      }
      if (method !== "GET") return route.fulfill(json({ error: "refused by the smoke" }, 409));
      return route.continue();
    });
    await page.goto(`${fx.base}/settings/runtimes`);
    await page.waitForSelector(`[data-machine-id="${ID.second}"]`, { timeout: 15000 });
    await page.waitForTimeout(BASE ? 800 : 400);
    if (BASE) {
      // What the person sees today: the long cards first, the waiting computer's Approve far down.
      const where = await page.evaluate(`(() => { const card = document.querySelector('[data-machine-id="${ID.second}"]'), btn = card?.querySelector(".btn-primary"); const b = btn?.getBoundingClientRect();
        return { cardTop: Math.round(card?.getBoundingClientRect().top ?? -1), approveTop: Math.round(b?.top ?? -1), viewport: innerHeight, dialogs: document.querySelectorAll("dialog[open]").length }; })()`);
      await page.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-1-view`) });
      await page.evaluate(`document.querySelector(".runtime-computers-heading")?.scrollIntoView({ block: "start" })`); await page.waitForTimeout(250);
      await page.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-2-list`) });
      r[cn] = { where, errs, csp: await csp() };
      await ctx.close(); continue;
    }
    const dlg = "dialog.runtime-approve-dialog[open]";
    await page.waitForSelector(dlg, { timeout: 10000 });
    // read at once: Approve is off for the first second, and a slow machine must not let that second pass before it is read
    const armedBefore = await page.evaluate(`document.querySelector('${dlg} .runtime-ask-approve')?.disabled`);
    await page.waitForTimeout(1200);
    const opened = await page.evaluate(`(() => { const d = document.querySelector('${dlg}'); if (!d) return null; const fp = d.querySelector(".runtime-approve-fingerprint"); const box = d.querySelector(".dlg-box");
      const btns = [...d.querySelectorAll(".dlg-actions button")].map((b) => ({ t: b.textContent.trim(), h: Math.round(b.getBoundingClientRect().height), off: b.disabled }));
      const active = document.activeElement;
      return { focusOnButton: active instanceof HTMLButtonElement, focusInDialog: !!active && d.contains(active), title: d.querySelector(".dlg-title")?.textContent, fp: fp?.textContent, fpSize: fp ? parseFloat(getComputedStyle(fp).fontSize) : 0, facts: d.querySelector(".runtime-machine-facts")?.textContent,
        sameName: d.querySelector(".runtime-same-name")?.textContent ?? "", hint: d.textContent.includes(${JSON.stringify(zh ? "請比對提出要求的 Runtime" : "Compare this fingerprint")}), btns,
        overflow: box ? box.scrollWidth - box.clientWidth : 0, onScreen: (() => { const q = box.getBoundingClientRect(); return q.left >= 0 && q.right <= innerWidth + 1 && q.top >= 0 && q.bottom <= innerHeight + 1; })() }; })()`) as any;
    await page.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-3-dialog`) });
    // Later: closes, no request, and the next poll does not open it again.
    await page.locator(`${dlg} .dlg-actions button`, { hasText: zh ? "稍後" : "Later" }).click(); await page.waitForTimeout(400);
    const readsAtLater = reads; const closed = await page.evaluate(`!document.querySelector("dialog[open]")`);
    if (c.device === "desk" && c.theme === "light" && c.lang === "en") { while (reads <= readsAtLater + 1) await page.waitForTimeout(500); await page.waitForTimeout(300); }
    const stayed = await page.evaluate(`!document.querySelector("dialog[open]")`);
    const list = await page.evaluate(`(() => { const cards = [...document.querySelectorAll(".runtime-machine")]; const tag = (id) => document.querySelector('[data-machine-id="' + id + '"] .runtime-same-name-tag')?.textContent ?? "";
      const bar = document.querySelector(".runtime-pending-banner"); return { order: cards.map((x) => x.getAttribute("data-machine-id")), bar: bar?.textContent.trim() ?? "", tags: [tag("${ID.first}"), tag("${ID.second}"), tag("${ID.lab}")],
        when: [...document.querySelectorAll(".runtime-same-name-when")].map((x) => x.textContent), hint: document.querySelector('[data-machine-id="${ID.first}"] .runtime-same-name')?.textContent ?? "",
        cardApprove: !!document.querySelector('[data-machine-id="${ID.second}"] .btn-primary'), pageX: document.documentElement.scrollWidth - innerWidth }; })()`) as any;
    await page.evaluate(`document.querySelector(".runtime-computers-heading")?.scrollIntoView({ block: "start" })`); await page.waitForTimeout(250);
    await page.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-4-list`) });
    // The bar brings it back; Approve sends the fingerprint.
    await page.locator(".runtime-pending-review").click(); await page.waitForSelector(dlg, { timeout: 5000 }); await page.waitForTimeout(1300);
    await page.locator(`${dlg} .runtime-ask-approve`).click(); await page.waitForTimeout(900);
    const done = await page.evaluate(`({ dialog: !!document.querySelector("dialog[open]"), status: document.querySelector('[data-machine-id="${ID.second}"] .runtime-status')?.className ?? "", bar: !!document.querySelector(".runtime-pending-banner") })`) as any;
    // A computer that starts waiting now opens the dialog alone; Reject sends the reject route and leaves no card.
    machines = [...machines, { id: ID.bench, name: "Bench-pc", status: "pending", platform: "win32", hostname: "BENCH-01", createdAt: T0 + 2_400_000, pairingFingerprint: "1B2C-3D4E-5F60" }];
    await page.waitForSelector(dlg, { timeout: 12000 }); await page.waitForTimeout(300);
    const second = await page.evaluate(`(() => { const d = document.querySelector('${dlg}'); return { facts: d?.querySelector(".runtime-machine-facts")?.textContent ?? "", countNote: /^\\d+ of \\d+$|^第 \\d+ 台，共 \\d+ 台$/.test(d?.querySelector(".dlg-body > .note")?.textContent ?? "") }; })()`) as any;
    await page.locator(`${dlg} .runtime-ask-reject`).click(); await page.waitForTimeout(900);
    const rejected = await page.evaluate(`({ dialog: !!document.querySelector("dialog[open]"), card: !!document.querySelector('[data-machine-id="${ID.bench}"]'), revoked: document.body.textContent.includes(${JSON.stringify(zh ? "已撤銷" : "Revoked")}) })`) as any;
    // A request that has run out opens nothing, says so on its card and has no Approve; Reject clears it.
    machines = [...machines, { id: ID.old, name: "Old-laptop", status: "pending", platform: "win32", hostname: "OLD-01", createdAt: T0 + 3_000_000, pairingFingerprint: "AAAA-BBBB-CCCC", pairingExpired: true }];
    await page.waitForSelector(`[data-machine-id="${ID.old}"]`, { timeout: 12000 }); await page.waitForTimeout(500);
    const expired = await page.evaluate(`(() => { const card = document.querySelector('[data-machine-id="${ID.old}"]'); return { dialog: !!document.querySelector("dialog[open]"), note: card?.querySelector(".runtime-approval .note")?.textContent ?? "", approve: !!card?.querySelector(".btn-primary"), reject: !!card?.querySelector(".runtime-expired-reject"), bar: !!document.querySelector(".runtime-pending-banner") }; })()`) as any;
    await page.locator(`[data-machine-id="${ID.old}"]`).screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-5-expired`) });
    const got = { armedBefore, opened, closed, stayed, list, writes, done, second, rejected, expired, errs, csp: await csp(), pageX: await page.evaluate("document.documentElement.scrollWidth - innerWidth") };
    const want = [ID.second, ID.first, ID.lab];
    check(cn, armedBefore === true && !!opened && opened.fpSize >= 22 && opened.fp === FINGERPRINT && opened.btns.length === 3 && opened.btns.every((b: any) => !b.off)
      && (!phone || opened.btns.every((b: any) => b.h >= 44)) && opened.overflow <= 0 && opened.onScreen && opened.hint && opened.sameName.length > 0
      && closed && stayed && JSON.stringify(list.order) === JSON.stringify(want) && list.bar.includes(zh ? "有 1 台電腦等待核准" : "1 computer is waiting for approval")
      && list.tags[0] === "#1" && list.tags[1] === "#2" && list.tags[2] === "" && list.when.length === 2 && list.hint.length > 0 && list.cardApprove && list.pageX <= 0
      && !opened.focusOnButton && opened.focusInDialog
      && writes.length === 2 && JSON.stringify(writes[0]) === JSON.stringify({ path: `/ui/runtimes/machines/${ID.second}/approve`, body: { fingerprint: FINGERPRINT } })
      && JSON.stringify(writes[1]) === JSON.stringify({ path: `/ui/runtimes/machines/${ID.bench}/reject`, body: {} })
      && !done.dialog && done.status.includes("is-online") && !done.bar
      && second.facts.includes("Bench-pc") && !second.countNote && !rejected.dialog && !rejected.card && !rejected.revoked
      && !expired.dialog && expired.note.length > 0 && !expired.approve && expired.reject && !expired.bar
      && errs.length === 0 && (got.csp as string[]).length === 0 && got.pageX <= 0, got);
    await ctx.close();
  }
} catch (e) { fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500); }
finally {
  writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, `result-${LABEL}.json`), JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : BASE ? "RECORDED" : "ALL PASS");
  await fx.close(); process.exit(fail.length ? 1 : 0);
}
