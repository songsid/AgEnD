/** Owned real HTTP/SQLite + pinned TLS/WSS + durable C adapter + shared browser UI; physical agent input is inert. */
import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { createServer } from "node:https";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { hubRig } from "../../../tests/helpers/hub-rig.js";
import { s3bRig } from "../../../tests/helpers/hub-s3b-rig.js";
import { listenLoopback } from "../smoke-fixture/listen-loopback.mjs";
import { HUB_OPTIONAL_CAPABILITIES, HUB_ROOM_ASK_CAPABILITY } from "../../../src/hub/protocol.js";
import { HubRoomAskAdapter, migrateRoomAsks, createRoomStatePublisher, type RoomAskLink, type AgentStateInput } from "../../../src/hub/member/room-ask.js";
import type { HubRepresentativeDelivery } from "../../../src/hub/representative.js";
import type { HubMemberLink } from "../../../src/hub/client.js";

const out = resolve(process.env.OUT ?? ".artifacts/rooms-integration/routing/browser"); mkdirSync(out, { recursive: true });
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const receipt: any = { sourceHead: execFileSync("git", ["-c", "gc.auto=0", "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scope: "Actual R HTTP/SQLite and HubServer/HubMemberClient TLS/WSS, C durable adapter/state publisher, shared U1/U2 browser UI. Two owned Fleet fixtures; inert directory and physical input/report hook. Captured bridge composes the two existing test rigs, not a complete FleetManager mount. No Team provider, external service, real agent, account or vendor API.",
  checks: [], pictures: [], requests: [], served: {}, wire: [], events: [] };
const check = (name: string, value: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!value, ...(value ? {} : { detail }) }); console.log(`${value ? "PASS" : "FAIL"} ${name}`); };
const until = async (test: () => unknown | Promise<unknown>, label: string) => {
  const end = Date.now() + 8_000; while (Date.now() < end) { if (await test()) return; await new Promise(r => setTimeout(r, 25)); } throw Error("Timed out: " + label);
};
const caps = [...HUB_OPTIONAL_CAPABILITIES, HUB_ROOM_ASK_CAPABILITY], net = await hubRig({ serverCapabilities: caps });
let web: Awaited<ReturnType<typeof s3bRig>> | undefined, browser: any, activePage: any, activeTag = "setup";
const peers: any[] = [];
const server = createServer({ key: readFileSync(join(net.root, "hub/keys/tls-key.pem")), cert: readFileSync(join(net.root, "hub/keys/tls-cert.pem")) }, (req, res) => {
  if (!web?.http.handle(req, res)) { res.writeHead(404); res.end(); }
});
try {
  const port = await listenLoopback(server), origin = `https://127.0.0.1:${port}`;
  web = await s3bRig({ administrator: net.owner, webOrigin: origin });
  web.httpDeps.transport = () => net.server; web.httpDeps.store = net.store; web.httpDeps.pairing = net.pairing; await web.restartHttp();
  net.setReceive(async (frame, link) => web!.http.receive(frame, link));
  const admin = await web.signIn("admin");
  async function peer(name: string) {
    const home = join(net.root, name); mkdirSync(home, { mode: 0o700 });
    const profile = await net.pair(home), exposureId = randomUUID(), db = new Database(join(home, "room-asks.sqlite")); migrateRoomAsks(db);
    const inputs: HubRepresentativeDelivery[] = [], bridges = new WeakMap<HubMemberLink, RoomAskLink>();
    let state: AgentStateInput = { process: "running", execution: "idle" }, client: ReturnType<typeof net.client>;
    const adapter = new HubRoomAskAdapter({ db, bindingKey: `${profile.fleetId}:owned-test-issuer`, encryptionKey: randomBytes(32), current: () => true,
      localExposure: id => id === exposureId ? { agent: name, consentId: exposureId, revision: 1, token: "owned-lifecycle" } : null,
      deliver: async input => { if (!input.stillCurrent() || !await input.beforeInput()) return false; inputs.push(input); return true; } });
    const publisher = createRoomStatePublisher({ exposures: () => [{ exposureId, agent: name }], read: () => state });
    const bridge = (link: HubMemberLink) => {
      let value = bridges.get(link); if (value) return value;
      value = { current: () => link.current(), features: link.features, sendAnswer: async answer => {
        receipt.wire.push({ type: "room.answer", agent: name, messageId: answer.messageId, answerId: answer.answerId });
        await link.send({ v: 1, type: "room.answer", requestId: randomUUID(), linkEpoch: link.linkEpoch, payload: answer });
      } }; bridges.set(link, value); return value;
    };
    const connect = async () => {
      client = net.client(async (frame, link) => {
        const source = bridge(link); adapter.connected(source);
        if (frame.type === "room.ask") { receipt.wire.push({ type: frame.type, agent: name, messageId: frame.payload.messageId, roomId: frame.payload.roomId }); adapter.accept(frame.payload, source); }
        if (frame.type === "room.answer-ack") adapter.acknowledge(frame.payload, source);
      }, undefined, caps, home);
      await client.value.start(); await until(() => client.state.link?.current(), name + " connected");
      const link = client.state.link!; adapter.connected(bridge(link)); publisher.connected({ current: () => link.current(), features: link.features,
        sendState: payload => link.send({ v: 1, type: "agent.state", requestId: randomUUID(), linkEpoch: link.linkEpoch, payload }) });
      await link.send({ v: 1, type: "exposure.snapshot", requestId: randomUUID(), linkEpoch: link.linkEpoch, payload: { revision: 1,
        exposures: [{ id: exposureId, fleetId: profile.fleetId, owner: net.owner, displayName: name, revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "a".repeat(64) }] } });
      await until(() => web!.db.prepare("SELECT 1 FROM hub_exposures WHERE id=?").get(exposureId), name + " publication"); await publisher.refresh();
    };
    const value = { name, exposureId, profile, db, inputs, adapter, publisher, connect,
      disconnect: async () => { await client.value.close(); adapter.connected(null); publisher.connected(null); await until(() => net.server.features(profile.fleetId) === null, name + " server observed close"); web!.http.memberClosed?.(profile.fleetId); },
      state: async (next: AgentStateInput) => { state = next; await publisher.refresh(); },
      answer: async (input: HubRepresentativeDelivery, text: string) => { await adapter.settled(); await adapter.report({ correlationId: input.correlationId!, caller: name, text }); },
    }; peers.push(value); await connect(); return value;
  }
  const notes = await peer("Notes"), planner = await peer("Planner");
  const pw = createRequire(resolve(process.env.PW_DIR!, "package.json"))("playwright-core"); browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
  const layouts = [["desktop", "en", "light"], ["phone", "zh-TW", "dark"]].filter(([device]) => !process.env.DEVICES || process.env.DEVICES.split(",").includes(device));
  if (!layouts.length) throw Error("DEVICES must select desktop or phone");
  receipt.layouts = layouts;
  for (const [device, lang, theme] of layouts) {
    await notes.state({ process: "running", execution: "idle" }); await planner.state({ process: "running", execution: "idle" });
    const made = await web.call(admin, "POST", "/hub/v1/rooms", { name: "Routing room " + device, agents: [notes.exposureId, planner.exposureId] });
    if (made.status !== 200) throw Error("create room: " + made.text);
    const roomId = made.json.room.id, tag = `${device}-${lang}-${theme}`, errors: string[] = [], responses: Promise<void>[] = [];
    const context = await browser.newContext({ viewport: device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 }, locale: lang, colorScheme: theme, ignoreHTTPSErrors: true, hasTouch: device === "phone", isMobile: device === "phone" });
    context.setDefaultTimeout(8_000); const at = admin.cookie.indexOf("=");
    await context.addCookies([{ name: admin.cookie.slice(0, at), value: admin.cookie.slice(at + 1), url: origin, httpOnly: true, secure: true, sameSite: "Strict" }]);
    await context.addInitScript(({ lang, theme }) => {
      localStorage.setItem("agend_lang", lang); localStorage.setItem("agend_theme", theme); localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1");
      const w = window as any, Original = w.EventSource; w.__roomEvents = [];
      w.EventSource = class extends Original { constructor(url: string, options?: EventSourceInit) { super(url, options);
        for (const type of ["presence.changed", "message.added", "message.updated"]) this.addEventListener(type, (e: MessageEvent) => w.__roomEvents.push({ type, data: JSON.parse(e.data) }));
      } };
    }, { lang, theme });
    await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(); activePage = page; activeTag = tag; page.on("pageerror", (e: Error) => errors.push(e.message));
    page.on("response", (response: any) => { const u = new URL(response.url());
      if (u.pathname.startsWith("/hub/v1/")) receipt.requests.push({ device, method: response.request().method(), path: u.pathname + u.search, status: response.status() });
      if (u.pathname.startsWith("/assets/") || u.pathname.startsWith("/ui/js/")) responses.push(response.body().then((body: Buffer) => { receipt.served[u.pathname] = sha(body); }).catch(() => {}));
    });
    const shot = async (name: string) => { const path = `${tag}-${name}.png`; await page.screenshot({ path: join(out, path), fullPage: true }); receipt.pictures.push({ path, sha256: sha(readFileSync(join(out, path))) }); };
    await page.goto(origin + "/ui/hub?room=" + roomId); await page.locator(".hub-room-page").waitFor(); await page.locator(".hub-room-rail-toggle").waitFor();
    if (await page.locator(".hub-room-rail-toggle").getAttribute("aria-pressed") === "false") await page.locator(".hub-room-rail-toggle").click();
    await page.locator(".hub-member-agent").first().waitFor();
    check(tag + " members panel uses the intended width layout", device === "phone" ? await page.locator("dialog[open] .hub-rail-sheet").count() === 1 : await page.locator(".u-rail .hub-room-members").count() === 1);
    check(tag + " room counts use viewer language and singular person", (await page.locator(".hub-chat-title .s").innerText()) === (lang === "en" ? "1 person · 2 agents" : "1 人 · 2 個 Agent"));
    const row = (name: string) => page.locator(".hub-member-agent").filter({ has: page.locator(".hub-member-name", { hasText: name }) });
    const visiblePresence = async (name: string, word: string, dot: string) => {
      if (!await page.locator(".hub-room-members").isVisible()) await page.locator(".hub-room-rail-toggle").click();
      await until(async () => (await row(name).locator(".hub-member-state").innerText()).includes(word), name + " presence " + word);
      check(tag + " " + name + " " + word + " dot", await row(name).locator(".dot." + dot).count() === 1);
    };
    const idle = lang === "en" ? "Idle" : "待命", working = lang === "en" ? "Working" : "處理中", paused = lang === "en" ? "Paused" : "暫停", offline = lang === "en" ? "Offline" : "離線";
    await visiblePresence("Notes", idle, "ok"); await visiblePresence("Planner", idle, "ok"); await shot("idle");
    const closeRail = async () => { if (device === "phone" && await page.locator(".hub-rail-sheet").isVisible()) await page.locator("dialog:has(.hub-rail-sheet) .dlg-x").click(); };
    const send = async (text: string) => { await closeRail(); await page.locator(".hub-room-composer textarea").fill(text); await page.locator(".hub-room-composer #sendBtn").click(); await page.getByText(text, { exact: true }).first().waitFor(); };
    const before = notes.inputs.length + planner.inputs.length;
    await send("Plain room conversation " + device);
    check(tag + " plain message has no agent deliveries", web.db.prepare("SELECT COUNT(*) AS n FROM hub_room_deliveries WHERE room_id=?").get(roomId).n === 0 && notes.inputs.length + planner.inputs.length === before);
    const selected = notes.inputs.length; await send("@Notes Please summarize " + device);
    await until(() => notes.inputs.length === selected + 1, "selected agent input");
    check(tag + " @agent routes only to Notes", planner.inputs.length + notes.inputs.length === before + 1);
    await notes.state({ process: "running", execution: "working" }); await visiblePresence("Notes", working, "busy"); await shot("agent-working");
    await notes.answer(notes.inputs[selected], "Notes summary " + device); await page.getByText("Notes summary " + device, { exact: true }).waitFor();
    await notes.state({ process: "running", execution: "idle" });
    check(tag + " C answer is acknowledged durably", await (async () => { await until(() => notes.db.prepare("SELECT COUNT(*) n FROM hub_room_asks WHERE state<>'acked'").get().n === 0, "C ACK"); return true; })());
    await planner.disconnect(); await visiblePresence("Planner", offline, "off");
    const n = notes.inputs.length, b = planner.inputs.length, mentionAll = lang === "en" ? "@All agents" : "@所有 Agent";
    await closeRail(); await page.locator(".hub-room-composer textarea").fill(mentionAll + " Plan together " + device);
    await page.locator(".hub-room-allbar").waitFor();
    check(tag + " @all preflight describes one online and one later", (await page.locator(".hub-room-allbar").innerText()).includes(lang === "en" ? "2 agents, 1 online, 1 will answer after they come online" : "2 個 Agent 中 1 個在線上，1 個上線後回答")); await shot("all-preflight");
    await page.locator(".hub-room-composer #sendBtn").click(); await until(() => notes.inputs.length === n + 1, "online @all input");
    await notes.state({ process: "running", execution: "working" }); await visiblePresence("Notes", working, "busy"); await closeRail();
    const progress = lang === "en" ? "Answered 0 · working 1 · reply later 1" : "已回答 0 · 處理中 1 · 稍後回覆 1";
    await page.getByText(progress, { exact: true }).waitFor(); await shot("all-queued");
    check(tag + " offline Fleet retains exactly one queued delivery", planner.inputs.length === b && web.db.prepare("SELECT COUNT(*) n FROM hub_room_deliveries WHERE room_id=? AND fleet_id=? AND state='queued'").get(roomId, planner.profile.fleetId).n === 1);
    await notes.answer(notes.inputs[n], "Notes team answer " + device); await notes.state({ process: "running", execution: "idle" }); await page.getByText("Notes team answer " + device, { exact: true }).waitFor();
    await planner.connect(); await until(() => planner.inputs.length === b + 1, "reconnected queued delivery");
    await planner.state({ process: "running", execution: "working" }); await visiblePresence("Planner", working, "busy"); await shot("all-reconnected");
    await planner.answer(planner.inputs[b], "Planner team answer " + device); await planner.state({ process: "running", execution: "idle" }); await page.getByText("Planner team answer " + device, { exact: true }).waitFor();
    await visiblePresence("Planner", idle, "ok");
    await page.getByText(lang === "en" ? "All 2 answered" : "2 個都回答了", { exact: true }).waitFor(); await closeRail(); await shot("all-answered");
    check(tag + " both @all answers persisted exactly once", web.db.prepare("SELECT COUNT(*) n FROM hub_room_deliveries WHERE room_id=? AND state='answered'").get(roomId).n === 3);
    await notes.state({ process: "paused", execution: null, pauseReason: "quota" }); await visiblePresence("Notes", paused, "warn");
    check(tag + " quota reason uses viewer language in live panel", (await row("Notes").locator(".hub-member-state").innerText()).includes(lang === "en" ? "Out of quota" : "額度用完"));
    if (device === "phone") { await closeRail(); await visiblePresence("Notes", paused, "warn"); check(tag + " reason survives members-sheet reopen", (await row("Notes").locator(".hub-member-state").innerText()).includes("額度用完")); }
    await shot("paused");
    const detail = await web.call(admin, "GET", `/hub/v1/rooms/${roomId}`);
    check(tag + " quota reason reaches real HTTP projection", detail.json.members.find((m: any) => m.id === notes.exposureId)?.presenceReason === "quota");
    const events = await page.evaluate(() => (window as any).__roomEvents); receipt.events.push({ device, events });
    check(tag + " live SSE carries state reason and completed progress", events.some((e: any) => e.type === "presence.changed" && e.data.memberId === notes.exposureId && e.data.presenceReason === "quota")
      && events.some((e: any) => e.type === "message.updated" && e.data.parent?.ask?.answered === 2));
    await notes.state({ process: "running", execution: "idle" }); await visiblePresence("Notes", idle, "ok");
    const restored = await web.call(admin, "GET", `/hub/v1/rooms/${roomId}`);
    check(tag + " idle event clears prior quota reason", !restored.json.members.find((m: any) => m.id === notes.exposureId)?.presenceReason && !(await row("Notes").locator(".hub-member-state").innerText()).includes(lang === "en" ? "Out of quota" : "額度用完")); await shot("presence-restored");
    check(tag + " no browser error", errors.length === 0, errors);
    check(tag + " no horizontal document overflow", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await Promise.all(responses); await context.close(); activePage = null;
  }
} catch (error) {
  check("run completed", false, String(error));
  if (activePage) {
    try { const path = activeTag + "-failure.png"; await activePage.screenshot({ path: join(out, path), fullPage: true }); receipt.pictures.push({ path, sha256: sha(readFileSync(join(out, path))) }); receipt.events.push({ device: activeTag, events: await activePage.evaluate(() => (window as any).__roomEvents) }); } catch { /* original assertion remains the result */ }
  }
}
finally {
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
  await browser?.close(); for (const p of peers) { p.publisher.close(); await p.adapter.close(); }
  await web?.close(); await new Promise<void>(yes => server.close(() => yes())); await net.close(); for (const p of peers) p.db.close();
}
console.log(JSON.stringify({ checks: receipt.checks.length, failed: receipt.checks.filter((x: any) => !x.ok).length, pictures: receipt.pictures.length }));
process.exitCode = receipt.checks.some((x: any) => !x.ok) ? 1 : 0;
