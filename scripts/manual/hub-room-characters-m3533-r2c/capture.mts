/**
 * M-3533 R2c real-app captures: shared agents in their own characters in a Hub room office.
 * The real Hub (HTTPS + SQLite, tests/helpers/hub-s3b-rig.ts), the real member-side sender (src/hub/member/agent-pictures.ts)
 * cutting each agent's set from a pack sheet (cropCharacter, src/hub-character-plan.ts characterPlan) and feeding the
 * Hub's own receive, and the real room page from this checkout. Headless Chromium, motion reduced. No fleet, CLI or account.
 * Characters: robots drawn here for the capture (one sheet a robot: idle, working, paused, stand and three walks), and the
 * office-skin-clinic test pack's fox (idle only: every room pose is drawn with it). Everything is made up.
 * FIT=<w>x<h> draws the page with another CHARACTER_FIT (route.fulfill of hub-room-office.js; nothing on disk changes), for comparing sizes.
 *   REPO=<checkout> PW_DIR=<playwright-core root> CJK_FONT=<a CJK .otf> OUT=<dir> [FIT=48x66] npx tsx scripts/manual/hub-room-characters-m3533-r2c/capture.mts
 */
import { createServer as createHttps } from "node:https";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
process.on("unhandledRejection", (e) => { console.error("unhandled", String(e).slice(0, 200)); });
const REPO = resolve(process.env.REPO!), PW = process.env.PW_DIR!, FONT = process.env.CJK_FONT!, OUT = resolve(process.env.OUT!);
const { s3bRig } = await import(join(REPO, "tests/helpers/hub-s3b-rig.ts"));
const { createHubRoomInvitations, HUB_ROOM_INVITATIONS_MIGRATION } = await import(join(REPO, "src/hub/invitations.ts"));
const { personKeyString } = await import(join(REPO, "src/hub/identity.ts"));
const { createOwnedPki } = await import(join(REPO, "scripts/manual/hub-connector-4c/rig.mts"));
const { HubMemberAgentPictures } = await import(join(REPO, "src/hub/member/agent-pictures.ts"));
const { characterPlan } = await import(join(REPO, "src/hub-character-plan.ts"));
const { cropInProcess, reduceInProcess } = await import(join(REPO, "src/hub-picture-reduce.ts"));
const { encodePng } = await import(join(REPO, "src/web-png.ts"));
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [], measured: {} };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };

// ── The characters: a robot on a 32×48 cell, frames side by side, one row a pose ──
const CW = 32, CH = 48, ROWS = ["idle", "working", "paused", "stand", "walkDown", "walkUp", "walkSide"], FRAMES: Record<string, number> = { idle: 4, working: 4, paused: 2, stand: 1, walkDown: 4, walkUp: 4, walkSide: 4 };
function robotSheet(body: [number, number, number]): Buffer {
  const width = 4 * CW, height = ROWS.length * CH, data = new Uint8Array(width * height * 4);
  const dark: [number, number, number] = [29, 29, 34], light = body.map(c => Math.min(255, c + 70)) as [number, number, number], shade = body.map(c => Math.round(c * 0.7)) as [number, number, number];
  const rect = (ox: number, oy: number, x: number, y: number, w: number, h: number, c: [number, number, number]) => {
    for (let yy = Math.max(0, y); yy < Math.min(CH, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(CW, x + w); xx++) data.set([...c, 255], ((oy + yy) * width + ox + xx) * 4);
  };
  ROWS.forEach((pose, row) => {
    for (let f = 0; f < FRAMES[pose]!; f++) {
      const ox = f * CW, oy = row * CH, bob = pose === "idle" ? (f % 2) : pose === "paused" ? 2 : 0, step = pose.startsWith("walk") ? (f % 2 ? 2 : -2) : 0;
      rect(ox, oy, 15, 2 + bob, 2, 4, dark); rect(ox, oy, 14, 1 + bob, 4, 2, pose === "working" && f % 2 ? [250, 210, 60] : [235, 80, 80]);   // antenna
      rect(ox, oy, 7, 6 + bob, 18, 14, dark); rect(ox, oy, 8, 7 + bob, 16, 12, body);                                                         // head
      if (pose === "walkUp") rect(ox, oy, 9, 9 + bob, 14, 2, shade);
      else if (pose === "paused") { rect(ox, oy, 10, 13 + bob, 4, 1, dark); rect(ox, oy, 18, 13 + bob, 4, 1, dark); }
      else if (pose === "walkSide") rect(ox, oy, 17, 11 + bob, 4, 4, [255, 255, 255]);
      else { rect(ox, oy, 10, 11 + bob, 4, 4, [255, 255, 255]); rect(ox, oy, 18, 11 + bob, 4, 4, [255, 255, 255]); rect(ox, oy, 11, 12 + bob, 2, 2, dark); rect(ox, oy, 19, 12 + bob, 2, 2, dark); }
      rect(ox, oy, 9, 21 + bob, 14, 14, dark); rect(ox, oy, 10, 22 + bob, 12, 12, shade); rect(ox, oy, 13, 25 + bob, 6, 4, light);            // body and its panel
      const up = pose === "working" ? (f % 2 ? -4 : 0) : 0;
      rect(ox, oy, 5, 22 + bob + up, 4, 10, dark); rect(ox, oy, 23, 22 + bob - up, 4, 10, dark);                                              // arms
      rect(ox, oy, 11, 35 + bob, 4, 11 - bob + Math.max(0, step), dark); rect(ox, oy, 17, 35 + bob, 4, 11 - bob + Math.max(0, -step), dark);   // legs
    }
  });
  return encodePng({ width, height, data });
}
const robotSet = (src: string) => Object.fromEntries(ROWS.map((pose, row) => [pose, { src, frames: FRAMES[pose], w: CW, h: CH, fps: pose === "paused" ? 1 : 4, ax: CW / 2, ay: CH - 2, dw: CW * 2, dh: CH * 2, row, col: 0 }]));
/** Noise: a set far over the Hub's 512 KB (dropped whole; its owner is told). */
function noiseSheet(): Buffer {
  const side = 256, frames = 16, data = new Uint8Array(side * frames * side * 4);
  let x = 2463534242; for (let i = 0; i < data.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; data[i] = i % 4 === 3 ? 255 : x & 255; }
  return encodePng({ width: side * frames, height: side, data });
}
const FOX = readFileSync(join(REPO, "tests/fixtures/office-skin-clinic/fox_idle.png"));
const SHEETS: Record<string, { set: Record<string, unknown>; sheet: Buffer }> = {
  atlas: { set: robotSet("robot.png"), sheet: robotSheet([232, 128, 64]) },
  nova: { set: robotSet("robot.png"), sheet: robotSheet([72, 132, 228]) },
  echo: { set: robotSet("robot.png"), sheet: robotSheet([84, 176, 112]) },
  quill: { set: { idle: { src: "robot.png", frames: 4, w: 32, h: 48, fps: 4, ax: 16, ay: 44, dw: 64, dh: 96 } }, sheet: FOX },
  notes: { set: { idle: { src: "robot.png", frames: 16, w: 256, h: 256, fps: 4, ax: 128, ay: 250, dw: 64, dh: 64 } }, sheet: noiseSheet() },
};
const characterOf = (agent: string) => {
  const s = SHEETS[agent];
  return s ? { key: `capture:${agent}`, load: () => { const plan = characterPlan(s.set as never); return plan ? { plan, pictures: new Map([["robot.png", s.sheet as Uint8Array]]) } : null; } } : null;
};

const scratch = mkdtempSync(join(OUT, ".owned-")), home = join(scratch, "home");
mkdirSync(join(home, ".local/share/fonts"), { recursive: true, mode: 0o700 }); copyFileSync(FONT, join(home, ".local/share/fonts/NotoSansCJKtc-Regular.otf"));
const pki = createOwnedPki(join(scratch, "pki")), pw = createRequire(join(resolve(PW), "package.json"))("playwright-core");
const env: Record<string, string | undefined> = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share") };
let r: any, browser: any; const errors: string[] = [];
const server = createHttps({ key: readFileSync(pki.key), cert: readFileSync(pki.cert) }, (req, res) => { if (!r?.http.handle(req, res)) { res.writeHead(404); res.end(); } });
try {
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  r = await s3bRig({ webOrigin: origin, realAudit: true, roomOffice: true });
  HUB_ROOM_INVITATIONS_MIGRATION.up(r.db); r.httpDeps.roomInvitations = createHubRoomInvitations;
  r.httpDeps.roomAssistant = { available: () => ({ enabled: true, backend: "inert", running: 0, cap: 3, state: "idle" }), ask: async () => ({ text: "ok" }), forget() {} };
  await r.restartHttp();
  check("the Hub offers agents' characters with their pictures", r.http.agentPicturesV1 === true && r.http.agentCharactersV1 === true);
  const manager = await r.signIn("admin");
  const alexKey = r.addPerson("alex-sample", "Alex Sample"), alex = await r.signIn("alex-sample");
  const caseyKey = r.addPerson("casey-sample", "Casey Sample"), casey = await r.signIn("casey-sample");
  const FLEETS = [
    { key: r.admin, session: manager, label: "Admin fleet", agents: [["Notes", "📝", "#e0b13a", "notes"], ["Reports", "📊", "#3aa675", "reports"]] },
    { key: alexKey, session: alex, label: "Alex fleet", agents: [["Atlas", "🦊", "#d97757", "atlas"], ["Quill", "🐙", "#9b6bff", "quill"], ["Sage", "🦉", "#4b8bf4", "sage"], ["Nova", null, "#4884e4", "nova"]] },
    { key: caseyKey, session: casey, label: "Casey fleet", agents: [["Echo", "🤖", "#54b070", "echo"]] },
  ] as const;
  const all: any[] = [];
  for (const f of FLEETS) {
    const fleetId = randomUUID();
    r.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture.fleet", result: "completed" }, (state: any) => {
      state.fleets.push({ id: fleetId, owner: f.key, generation: 1, credentialHash: null, status: "active", label: f.label }); });
    const link = r.link(fleetId, f.key, 1, ["welcome-caps-v1", "room-ask-v1", "agent-catalog-v1", "exposure-request-v1", "agent-pictures-v1", "agent-characters-v1"]);
    const mine = f.agents.map(([displayName, , , agent]) => ({ id: randomUUID(), agent, fleetId, owner: f.key, displayName, revision: 1, state: "published" as const, dataViewId: "agent", allowedTools: [], policyDigest: "c".repeat(64) }));
    await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: mine.map(({ agent: _a, ...x }) => x) }, link) as never, link);
    await r.http.receive(r.frame("agent.catalog", { revision: randomUUID().replace(/-/g, "").repeat(2), enabled: true, requests: true,
      agents: f.agents.map(([displayName, emoji, color, agent], i) => ({ instance: agent, displayName, description: "", avatar: emoji || color ? { emoji, color } : null,
        kind: "agent", general: false, shareable: true, exposure: { id: mine[i]!.id, revision: 1, state: "published" } })) }, link) as never, link);
    for (const x of mine) if (f.key !== r.admin) await r.call(f.session, "POST", "/hub/v1/grants", { exposureId: x.id, exposureRevision: 1, login: "admin", days: 7 });
    const memberLink: any = { linkEpoch: 1, features: new Set(["agent-pictures-v1", "agent-characters-v1"]), current: () => true, exchange: async (frame: any) => r.http.receive(frame, link) };
    const sender = new HubMemberAgentPictures({ current: () => true, reduce: reduceInProcess, crop: cropInProcess, exposures: () => mine.map((x) => ({ id: x.id, agent: x.agent })),
      sources: (agent: string) => ({ disc: null, portrait: null, character: characterOf(agent) }) });
    sender.connected(memberLink); await sender.refresh(); sender.close();
    all.push({ ...f, fleetId, mine, link });
  }
  const strips = r.db.prepare("SELECT exposure_id, pose, size FROM hub_agent_character_strips").all() as Array<{ exposure_id: string; pose: string; size: number }>;
  const byName = (name: string) => all.flatMap(f => f.mine).find((x: any) => x.displayName === name);
  const posesOf = (name: string) => strips.filter(s => s.exposure_id === byName(name)?.id).map(s => s.pose).sort();
  receipt.measured.stripsPerAgent = Object.fromEntries(["Atlas", "Quill", "Nova", "Echo", "Notes", "Sage", "Reports"].map(n => [n, posesOf(n)]));
  receipt.measured.bytesPerAgent = Object.fromEntries(["Atlas", "Quill", "Nova", "Echo"].map(n => [n, strips.filter(s => s.exposure_id === byName(n)?.id).reduce((a, s) => a + s.size, 0)]));
  check("Atlas, Nova and Echo: the robot's seven room poses and the filled paused (a robot has its own)", ["Atlas", "Nova", "Echo"].every(n => posesOf(n).join() === "idle,paused,stand,walkDown,walkSide,walkUp,working"), receipt.measured.stripsPerAgent);
  check("Quill: the fox has only idle — every room pose is drawn with it (one picture)", posesOf("Quill").join() === "idle,paused,stand,working", posesOf("Quill"));
  check("Notes: its set is far over 512 KB — none is sent; Sage and Reports have none", !posesOf("Notes").length && !posesOf("Sage").length && !posesOf("Reports").length);
  const tooLarge = (await r.call(manager, "GET", "/hub/v1/me/agents")).json.fleets.find((f: any) => f.id === all[0].fleetId)?.picturesTooLarge ?? null;
  check("Notes's owner is told its character is too large", JSON.stringify(tooLarge) === JSON.stringify({ [byName("Notes").id]: ["character"] }), tooLarge);
  browser = await pw.chromium.launch({ headless: true, env, args: ["--no-sandbox"] });
  for (const [device, lang, theme] of [["desk", "zh-TW", "light"], ["desk", "en", "dark"], ["phone", "zh-TW", "dark"], ["phone", "en", "light"]] as const) {
    const tag = `${device}-${lang}-${theme}`, phone = device === "phone";
    const made = await r.call(manager, "POST", "/hub/v1/rooms", { name: lang === "en" ? "Release planning" : "發版規劃", assistant: true, people: [personKeyString(alexKey), personKeyString(caseyKey)] });
    const roomId = made.json?.room?.id;
    if (!roomId) { errors.push(`${tag}: room ${made.status}`); continue; }
    for (const f of all) await r.call(manager, "POST", `/hub/v1/rooms/${roomId}/invitations`, { agents: f.mine.map((x: any) => x.id) });
    for (let round = 0; round < 4; round++) {
      for (const f of all) { const inv = await r.call(f.session, "GET", "/hub/v1/invitations"); for (const i of inv.json?.invitations ?? []) await r.call(f.session, "POST", `/hub/v1/invitations/${i.id}/accept`, {}); }
      await new Promise((res) => setTimeout(res, 200));
    }
    // States: Quill working, Nova paused, Echo offline (its Fleet away); Atlas and the rest idle.
    const st = (name: string, s: any) => { const f = all.find(x => x.mine.some((m: any) => m.displayName === name)); return r.http.receive(r.frame("agent.state", { exposureId: byName(name).id, ...s }, f.link) as never, f.link); };
    await st("Quill", { state: "working" }); await st("Nova", { state: "paused", reason: "quota" }); all[2].link.alive = false;
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 900 }, isMobile: phone, hasTouch: phone, deviceScaleFactor: 2,
      locale: lang === "en" ? "en-US" : "zh-TW", colorScheme: theme, ignoreHTTPSErrors: true, reducedMotion: "reduce" });
    await context.addInitScript({ content: `window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(lang)});localStorage.setItem('agend_theme',${JSON.stringify(theme)});localStorage.setItem('agend_tour_done','1');` });
    const fit = /^(\d+)x(\d+)$/.exec(process.env.FIT ?? "");
    if (fit) await context.route("**/ui/js/hub-room-office.js", async (route: any) => {
      const body = readFileSync(join(REPO, "src/ui/hub-room-office.js"), "utf8").replace("export const CHARACTER_FIT = { w: 88, h: 96 };", `export const CHARACTER_FIT = { w: ${fit[1]}, h: ${fit[2]} };`);
      await route.fulfill({ contentType: "text/javascript", body });
    });
    const page = await context.newPage(); page.setDefaultTimeout(20_000); page.on("pageerror", (e: Error) => errors.push(tag + ": " + e.message));
    const fetched = new Set<string>();
    page.on("response", (res: any) => { const m = /\/agents\/([^/]+)\/character\/([A-Za-z]+)/.exec(res.url()); if (m && res.status() === 200) fetched.add(`${m[1]}:${m[2]}`); });
    const shot = async (name: string, clip?: any) => {
      if (!phone) await page.mouse.move(2, 2); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(500);
      const path = `m3533-r2c-${tag}-${fit ? `fit${fit[1]}x${fit[2]}-` : ""}${name}.png`; await page.screenshot({ path: join(OUT, path), ...(clip ? { clip } : {}) });
      receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
    };
    try {
      await page.goto(`${origin}/ui/hub?room=${roomId}&view=office`); await page.fill("#hubLogin", "admin"); await page.fill("#hubPassword", "pw-admin"); await page.locator(".hub-signin button[type=submit]").click();
      await page.locator(".oo-stage canvas").first().waitFor(); await page.waitForTimeout(3500);
      const state = (await r.call(manager, "GET", `/hub/v1/rooms/${roomId}/office/state`)).json;
      const own = state.instances.filter((i: any) => i.character).map((i: any) => i.display_name).sort();
      check(`${tag}: the room office names Atlas, Echo, Nova and Quill's own characters, nobody else's`, own.join() === "Atlas,Echo,Nova,Quill", own);
      const words = Object.fromEntries(state.instances.map((i: any) => [i.display_name, i.presence]));
      check(`${tag}: the states shown are the member list's (Atlas idle, Quill working, Nova paused, Echo offline)`, words.Atlas === "idle" && words.Quill === "working" && words.Nova === "paused" && words.Echo === "offline", words);
      const loaded = (name: string) => [...fetched].filter(k => k.startsWith(byName(name).id + ":")).map(k => k.split(":")[1]).sort().join();
      check(`${tag}: each own character's every strip was loaded by the page (drawn whole)`, ["Atlas", "Nova", "Echo"].every(n => loaded(n) === "idle,paused,stand,walkDown,walkSide,walkUp,working") && loaded("Quill") === "idle,paused,stand,working",
        Object.fromEntries(["Atlas", "Quill", "Nova", "Echo"].map(n => [n, loaded(n)])));
      await shot("1-office");
      const stage = await page.locator(".oo-stage").first().boundingBox();
      // A close look at the desks (the scene's first row), where the own characters sit beside the figures.
      if (stage) await shot("1z-office-close", { x: stage.x, y: stage.y, width: Math.min(stage.width, phone ? 390 : 760), height: Math.min(stage.height, phone ? 360 : 420) });
      // The fox at its desk, close (Lumen R2c: its readability at the room's size on record).
      // Found by its own orange (235,130,40; Atlas's robot is 232,128,64) on the scene's canvas.
      const fox = await page.evaluate(() => {
        const cv = document.querySelector(".hub-room-office .oo-stage canvas") as HTMLCanvasElement | null; if (!cv) return null;
        const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data; let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
        for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - 235) <= 2 && Math.abs(d[i + 1]! - 130) <= 2 && Math.abs(d[i + 2]! - 40) <= 2) {
          const p = i / 4, x = p % cv.width, y = Math.floor(p / cv.width); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        if (x1 < 0) return null;
        const r = cv.getBoundingClientRect(), k = r.width / cv.width;
        return { x: r.x + ((x0 + x1) / 2) * k, y: r.y + ((y0 + y1) / 2) * k, w: (x1 - x0 + 1) * k, h: (y1 - y0 + 1) * k };
      });
      if (fox) await shot("1q-fox-close", { x: Math.max(0, fox.x - 60), y: Math.max(0, fox.y - 60), width: 120, height: 120 });
      check(`${tag}: the fox is found on the scene`, !!fox, fox);
      receipt.measured[`${tag}-foxDesk`] = fox;
      // Atlas's card: no portrait — the set's stand (Lumen R2c 4: portrait, else stand, else the figure).
      await page.evaluate(() => { const b = [...document.querySelectorAll(".hub-room-office .oo-desk")].find((e) => (e.textContent || "").startsWith("Atlas")) as HTMLElement | undefined; b?.click(); });
      await page.locator(".hub-room-office .oo-card").first().waitFor(); await page.waitForTimeout(1500);
      const avatar = await page.evaluate(() => { const cv = document.querySelector(".hub-room-office .oo-card .oo-card-avatar canvas") as HTMLCanvasElement | null; if (!cv) return null;
        const g = cv.getContext("2d")!, d = g.getImageData(0, 0, cv.width, cv.height).data; let orange = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3]! > 200 && d[i]! > 200 && d[i + 1]! > 100 && d[i + 1]! < 150 && d[i + 2]! < 90) orange++;
        return { size: `${cv.width}x${cv.height}`, orange }; });
      check(`${tag}: Atlas's card shows its own character's stand (its orange robot), not the figure`, !!avatar && avatar.orange > 50, avatar);
      await shot("2-card-atlas");
      await page.keyboard.press("Escape"); await page.waitForTimeout(400); await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
      // Quill's card: the clinic fox's own character (no portrait: the set's stand, filled from its idle) — the leader's check.
      await page.evaluate(() => { const b = [...document.querySelectorAll(".hub-room-office .oo-desk")].find((e) => (e.textContent || "").startsWith("Quill")) as HTMLElement | undefined; b?.click(); });
      await page.locator(".hub-room-office .oo-card").first().waitFor(); await page.waitForTimeout(1500);
      const foxAvatar = await page.evaluate(() => { const cv = document.querySelector(".hub-room-office .oo-card .oo-card-avatar canvas") as HTMLCanvasElement | null; if (!cv) return null;
        const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data; let fox = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3]! > 200 && Math.abs(d[i]! - 235) <= 3 && Math.abs(d[i + 1]! - 130) <= 3 && Math.abs(d[i + 2]! - 40) <= 3) fox++;
        return { size: `${cv.width}x${cv.height}`, fox }; });
      check(`${tag}: Quill's card shows its own character, the fox (its orange), not the figure`, !!foxAvatar && foxAvatar.fox > 20, foxAvatar);
      await shot("2b-card-quill");
      await page.keyboard.press("Escape"); await page.waitForTimeout(400); await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
      // Studio (large): the same agents in the large built-in style.
      const patched = await r.call(manager, "PATCH", `/hub/v1/rooms/${roomId}`, { office: { style: "studio-large" } });
      check(`${tag}: the room's style is Studio (large)`, patched.status === 200, patched.status);
      await page.reload(); await page.locator(".oo-stage canvas").first().waitFor(); await page.waitForTimeout(3500);
      await shot("3-office-studio-large");
      // A top-row seat under its area's name, close (Lumen R2c b): a room of Echo alone in Studio (large), so Echo takes the
      // nap area's first seat, right under its name; the scene zoomed in on a phone. The name is written again over its head (M-3539).
      const solo = await r.call(manager, "POST", "/hub/v1/rooms", { name: lang === "en" ? "Nap check" : "午睡檢查", people: [personKeyString(caseyKey)] });
      const soloId = solo.json?.room?.id;
      await r.call(manager, "POST", `/hub/v1/rooms/${soloId}/invitations`, { agents: [byName("Echo").id] });
      for (let round = 0; round < 3; round++) { const inv = await r.call(casey, "GET", "/hub/v1/invitations"); for (const i of inv.json?.invitations ?? []) await r.call(casey, "POST", `/hub/v1/invitations/${i.id}/accept`, {}); await new Promise((res) => setTimeout(res, 150)); }
      await r.call(manager, "PATCH", `/hub/v1/rooms/${soloId}`, { office: { style: "studio-large" } });
      await page.goto(`${origin}/ui/hub?room=${soloId}&view=office`); await page.locator(".oo-stage canvas").first().waitFor(); await page.waitForTimeout(3000);
      for (let z = 0; z < (phone ? 4 : 2); z++) { await page.locator(".hub-room-office .oo-zoom-in").first().click().catch(() => {}); await page.waitForTimeout(400); }
      await page.waitForTimeout(1200);
      const echo = await page.evaluate(() => {
        const cv = document.querySelector(".hub-room-office .oo-stage canvas") as HTMLCanvasElement | null; if (!cv) return null;
        const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data; let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
        for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - 84) <= 2 && Math.abs(d[i + 1]! - 176) <= 2 && Math.abs(d[i + 2]! - 112) <= 2) {
          const p = i / 4, x = p % cv.width, y = Math.floor(p / cv.width); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        if (x1 < 0) return null;
        const r = cv.getBoundingClientRect(), k = r.width / cv.width;
        return { x: r.x + x0 * k, y: r.y + y0 * k, w: (x1 - x0 + 1) * k, h: (y1 - y0 + 1) * k };
      });
      check(`${tag}: Echo alone takes a top-row seat under its area's name`, !!echo, echo);
      // The area's name is left of the seat (92 scene units, about two of Echo's widths): the crop reaches it and the top edge above.
      if (echo) { const x = Math.max(0, echo.x - echo.w * 4.8), y = Math.max(0, echo.y - echo.h * 1.6);
        await shot("3z-top-row-title-close", { x, y, width: Math.min(echo.w * 7.3, (phone ? 390 : 1366) - x), height: Math.min(echo.h * 3, (phone ? 844 : 900) - y) }); }
      await page.goto(`${origin}/ui/hub/exposures`); await page.locator("[data-my-agents]").waitFor(); await page.waitForTimeout(1500);
      const lines = await page.evaluate(() => [...document.querySelectorAll("[data-picture-large=character]")].map((e) => (e.textContent || "").trim()));
      check(`${tag}: My agents tells the owner Notes's character is too large`, lines.length === 1 && /512 KB/.test(lines[0]!), lines);
      await page.evaluate(() => document.querySelector("[data-picture-large]")?.closest(".hub-agent-choice")?.scrollIntoView({ block: "center" }));
      await shot("4-my-agents-too-large");
    } catch (e) { errors.push(tag + ": " + String(e).slice(0, 300)); }
    all[2].link.alive = true;
    await context.close();
  }
} catch (e) { errors.push("rig: " + String(e).slice(0, 400)); }
finally { await browser?.close().catch(() => {}); await r?.close().catch(() => {}); server.close(); rmSync(scratch, { recursive: true, force: true }); }
check("no page or rig errors", errors.length === 0, errors);
const failed = receipt.checks.filter((c: any) => !c.ok).length;
receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(`checks ${receipt.summary}`);
process.exit(failed ? 1 : 0);
