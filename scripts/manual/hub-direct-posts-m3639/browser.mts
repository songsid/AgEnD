/** Real Hub HTTP/SQLite/UI, synthetic directory/member; headless, loopback-only. No live Fleet, CLI or model. */
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { s3bRig } from "../../../tests/helpers/hub-s3b-rig.js";
import { personKeyString } from "../../../src/hub/identity.js";
import { createOwnedPki } from "../hub-connector-4c/rig.mjs";
import { createHubRoomInvitations, HUB_ROOM_INVITATIONS_MIGRATION } from "../../../src/hub/invitations.js";

if (!process.env.CHROME?.startsWith("/home/") || !process.env.CJK_FONT || !process.env.EMOJI_FONT || !process.env.PW_DIR) throw Error("Supply Linux Chrome, CJK/emoji fonts and Playwright");
const out = resolve(process.env.OUT!), stage = process.env.STAGE === "before" ? "before" : "after";
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(out, ".owned-")), home = join(scratch, "home");
mkdirSync(join(home, ".local/share/fonts"), { recursive: true }); copyFileSync(process.env.CJK_FONT, join(home, ".local/share/fonts/Chinese.ttf"));
if(process.env.EMOJI_FONT)copyFileSync(process.env.EMOJI_FONT,join(home,".local/share/fonts/Emoji.ttf"));
const pki = createOwnedPki(join(scratch, "pki")), pw = createRequire(join(resolve(process.env.PW_DIR), "package.json"))("playwright-core");
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share") };
for (const k of ["DISPLAY", "WAYLAND_DISPLAY", "WSL_INTEROP"]) delete env[k];
let r: Awaited<ReturnType<typeof s3bRig>> | undefined, browser: any;
const captureHead=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();
const covers=(path:string)=>execFileSync("fc-query",["--format","%{charset}",path],{encoding:"utf8"}).trim().split(/\s+/).some(range=>{const [a,b=a]=range.split("-").map(n=>parseInt(n,16));return a!<=0x1f4ce&&b!>=0x1f4ce;});
const fontProbe={paperclip:"U+1F4CE",cjkHasGlyph:covers(process.env.CJK_FONT!),emojiHasGlyph:covers(process.env.EMOJI_FONT!)};
const errors: string[] = [], checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: unknown) => { checks.push({ name, ok: !!ok }); if (!ok) throw Error(name); };
const server = createServer({ key: readFileSync(pki.key), cert: readFileSync(pki.cert) }, (req, res) => { if (!r?.http.handle(req, res)) { res.writeHead(404); res.end(); } });
try {
  await new Promise<void>(yes => server.listen(0, "127.0.0.1", yes));
  const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  let clock=Date.now()-600_000;
  r = await s3bRig({ webOrigin: origin, realAudit: true,attachments:true,now:()=>clock });
  HUB_ROOM_INVITATIONS_MIGRATION.up(r.db); r.httpDeps.roomInvitations = (core, host) => createHubRoomInvitations(core, host); await r.restartHttp();
  const asker = r.addPerson("example-asker", "Example colleague"), owner = r.admin, fleetId = randomUUID(), exposureId = randomUUID();
  r.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture", result: "completed" }, s => {
    s.fleets.push({ id: fleetId, owner, generation: 1, credentialHash: "a".repeat(64), status: "active", label: "Example Fleet" });
  });
  const link = r.link(fleetId, owner, 1, ["welcome-caps-v1", "room-ask-v1", "agent-catalog-v1", "exposure-request-v1", "agent-catalog-lapse-v1","direct-posts-v1","room-post-v1","attachments-v1"]);
  r.http.memberConnected!(link);
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposureId, fleetId, owner, displayName: "Notes",
    revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link) as never, link);
  const o = await r.signIn("admin"), a = await r.signIn("example-asker");
  const grant = await r.call(o, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, login: "example-asker", days: 7 });
  check("grant created", grant.status === 200);
  const direct = await r.call(a, "POST", "/hub/v1/rooms", { exposureId, grantId: grant.json.grant.id });
  check("direct created", direct.status === 200); const directId = direct.json.room.id;
  const question=await r.call(a,"POST",`/hub/v1/rooms/${directId}/messages`,{text:"Please prepare the notes.",idempotencyKey:randomUUID()});check("question accepted",question.status===200);
  const answerId=randomUUID(),text="I will prepare the notes.",digest=createHash("sha256").update(text).digest("hex");
  const release=await r.http.receive(r.frame("authorize.request",{messageId:question.json.id,operationId:randomUUID(),exposureRevision:1,phase:"release-answer",answer:{answerId,contentDigest:digest}},link) as never,link) as any;
  check("earlier answer authorized",release.payload.ok);
  await r.http.receive(r.frame("answer",{messageId:question.json.id,answerId,text,contentDigest:digest,releaseLease:release.payload.lease},link) as never,link);
  clock+=600_000;
  browser = await pw.chromium.launch({ executablePath: process.env.CHROME, headless: true, env, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking", "--disable-component-update"] });
  for (const device of ["desk", "phone"]) for (const theme of ["light", "dark"]) for (const lang of ["en", "zh-TW"]) {
    if(process.env.ONLY_TAG&&`${device}-${theme}-${lang}`!==process.env.ONLY_TAG)continue;
    if(process.env.ONE&&!(device==="desk"&&theme==="light"&&lang==="en"))continue;
    if (process.env.MATRIX === "phone" && device !== "phone") continue;
    const tag = `${device}-${theme}-${lang}`, ctx = await browser.newContext({ viewport: device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 }, locale: lang === "en" ? "en-US" : "zh-TW", colorScheme: theme, ignoreHTTPSErrors: true });
    await ctx.addInitScript({ content: `window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(lang)});localStorage.setItem('agend_theme',${JSON.stringify(theme)});localStorage.setItem('agend_tour_done','1');` });
    await ctx.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await ctx.newPage(); page.setDefaultTimeout(15_000); page.on("pageerror", (e: Error) => errors.push(e.message));
    try {
      r.db.prepare("DELETE FROM hub_direct_post_reads").run();r.db.prepare("DELETE FROM hub_direct_posts").run();r.db.prepare("DELETE FROM hub_direct_mutes").run();
      await page.goto(origin + `/ui/hub?room=${directId}`);
      await page.fill("#hubLogin", "example-asker"); await page.fill("#hubPassword", "pw-example-asker"); await page.locator(".hub-signin button[type=submit]").click();
      const connected=page.waitForResponse((res:any)=>res.url().includes("/hub/v1/rooms/events")&&res.status()===200);
      await page.goto(origin+`/ui/hub?room=${directId}`);await connected;
      await page.getByText("I will prepare the notes.",{exact:true}).first().waitFor();
      const bytes=Buffer.from("Notes prepared in this synthetic fixture."),sha256=createHash("sha256").update(bytes).digest("hex"),fileId=randomUUID();
      await r.http.receive(r.frame("attachment.put",{id:fileId,offset:0,total:bytes.length,sha256,data:bytes.toString("base64")},link) as never,link);
      const pushed=await r.http.receive(r.frame("room.post",{exposureId,room:directId,direct:true,text:"The notes are ready. Here is the summary.",attachments:[{id:fileId,name:"summary.txt",size:bytes.length,mime:"text/plain",sha256}],idempotencyKey:randomUUID()},link) as never,link) as any;
      check(`${tag} actual room.post accepted`,pushed.payload.ok);
      const timeline=(await r.call(a,"GET",`/hub/v1/rooms/${directId}/messages`)).json;
      const standalone=timeline.messages.find((m:any)=>m.id===pushed.payload.messageId);
      check(`${tag} no new question or answer relation`,standalone&&!standalone.replyTo&&!standalone.answerTo&&!standalone.stage&&timeline.entries.filter((e:any)=>!e.ownPost).length===1);
      check(`${tag} earlier question already answered`,timeline.entries.find((e:any)=>!e.ownPost)?.receipt.stage==="answered");
      await page.getByText("The notes are ready. Here is the summary.",{exact:true}).first().waitFor().catch(async(e:unknown)=>{writeFileSync(join(out,"debug.txt"),JSON.stringify({errors,body:await page.locator("body").innerText(),page:(await r!.call(a,"GET",`/hub/v1/rooms/${directId}/messages`)).json},null,2));await page.screenshot({path:join(out,"debug.png")});throw e;});
      await page.getByText("summary.txt",{exact:true}).first().waitFor();await page.evaluate(()=>document.fonts.ready);
      check(`${tag} no stale pending status`,await page.locator(".hub-dock .work-bar").count()===0);
      const cdp=await ctx.newCDPSession(page);await cdp.send("DOM.enable");await cdp.send("CSS.enable");const doc=await cdp.send("DOM.getDocument");const node=await cdp.send("DOM.querySelector",{nodeId:doc.root.nodeId,selector:".att-file"});const fonts=await cdp.send("CSS.getPlatformFontsForNode",{nodeId:node.nodeId});
      check(`${tag} paperclip has real emoji fallback`,fonts.fonts.some((f:any)=>/Segoe UI Emoji|Noto Color Emoji/.test(f.familyName)&&f.glyphCount>0));await cdp.detach();
      if(!process.env.MUTED_ONLY)await page.screenshot({path:join(out,`${tag}-message.png`)});
      await page.locator(".hub-room-menu button[aria-haspopup]").click();
      const mute=page.getByRole("menuitemcheckbox",{name:lang==="en"?"Mute this agent’s own messages":"關閉這個 Agent 主動發來的訊息"});
      check(`${tag} initially unchecked`,await mute.getAttribute("aria-checked")==="false");await page.screenshot({path:join(out,`${tag}-unmuted-menu.png`)});await mute.click();
      await page.waitForFunction(()=>[...document.querySelectorAll('[role="menuitemcheckbox"]')].some(e=>e.getAttribute("aria-checked")==="true"));
      await mute.getAttribute("aria-checked").then((v:string)=>check(`${tag} muted check`,v==="true"));
      check(`${tag} mute persisted`,(await r.call(a,"GET",`/hub/v1/rooms/${directId}`)).json.room.directMessagesMuted);
      await page.locator(".hub-dock .note[role=status]").waitFor();
      check(`${tag} previous post remains while muted`,await page.getByText("The notes are ready. Here is the summary.",{exact:true}).count()>0);
      if(await page.locator(".hub-room-menu button[aria-haspopup]").getAttribute("aria-expanded")==="true")await page.locator(".hub-room-menu button[aria-haspopup]").click();await page.locator(".toast").waitFor();
      const toastStyle=await page.locator(".toast").evaluate((e:Element)=>{const s=getComputedStyle(e);return {color:s.color,background:s.backgroundColor,rootTheme:document.documentElement.dataset.theme,text:e.textContent,width:e.clientWidth,scrollWidth:e.scrollWidth};});writeFileSync(join(out,`${tag}-toast-style.json`),JSON.stringify(toastStyle));
      await page.screenshot({path:join(out,`${tag}-muted-toast.png`)});
      await page.locator(".toast").waitFor({state:"hidden"});if(await page.locator(".hub-room-menu button[aria-haspopup]").getAttribute("aria-expanded")!=="true")await page.locator(".hub-room-menu button[aria-haspopup]").click();
      await page.screenshot({path:join(out,`${tag}-muted.png`)});
      const refused=await r.http.receive(r.frame("room.post",{exposureId,room:directId,direct:true,text:"This must not arrive",idempotencyKey:randomUUID()},link) as never,link) as any;
      check(`${tag} subsequent send refused`,!refused.payload.ok&&refused.payload.message.includes("turned off"));
      check(`${tag} no horizontal overflow`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    } finally { await ctx.close(); }
  }
  check("no page errors", errors.length === 0);
  writeFileSync(join(out, `receipt-${stage}${process.env.MATRIX === "phone" ? "-phone-wrap" : ""}.json`), JSON.stringify({ captureHead,stage,fontProbe,checks,errors }, null, 2));
  console.log(JSON.stringify({ stage, checks: checks.length }));
} finally { await browser?.close(); server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); await r?.close(); rmSync(scratch, { recursive: true, force: true }); }
