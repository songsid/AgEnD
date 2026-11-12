/** Five independent owned Fleet web/settings/join/member services. Agent lifecycle is an explicit refusal boundary. */
import { createServer as httpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
const built = '/tmp/b1-dist';
const { FleetManager } = await import(built + '/fleet-manager.js');
const { CompanyJoinClient } = await import(built + '/hub/join/client.js');
const { currentLocalJoinId, readLocalJoin } = await import(built + '/hub/join/local-journal.js');
const { makeTestCerts } = await import('../../../tests/support/hub-init-fixtures.js');
const wait = async (fn: () => boolean, ms = 30_000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise(r => setTimeout(r, 40)); if (!fn()) throw Error('Owned Fleet fixture deadline'); };
export function campaignUi(rig: any, browser: any, receipt: any, check: (name: string, pass: boolean) => void, online: Set<string>) {
  const environmentHome=process.env.AGEND_HOME;
  let sequence = 0;
  const active: any[] = [];
  const out = process.env.OUT!;
  async function context(lang = 'en', phone = false, theme = 'light') {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: phone ? 390 : 1366, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone, colorScheme: theme, locale: lang });
    await ctx.addInitScript(({ lang, theme }: any) => {
      (window as any).__name = (fn: any) => fn;
      try { for (const [k,v] of Object.entries({ agend_lang: lang, agend_theme: theme, agend_tour_done: '1', agend_firstrun_dismissed: '1' })) localStorage.setItem(k,v); } catch {}
      (window as any).__csp = []; document.addEventListener('securitypolicyviolation', (e: any) => (window as any).__csp.push(e.violatedDirective));
    }, { lang, theme });
    return ctx;
  }
  async function shot(page: any, name: string) {
    check(name + ' no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check(name + ' no raw i18n keys', !/enrolmentCode\.[A-Za-z]|hubJoinSteps\.[A-Za-z]/.test(await page.locator('body').innerText()));
    await page.screenshot({ path: join(out, name + '.png'), fullPage: true }); receipt.screenshots.push(name + '.png');
  }
  async function adminPage(lang = 'en', phone = false, theme = 'light', overlay: string[] = []) {
    const ctx = await context(lang, phone, theme);
    if (overlay.length) await skew(ctx, overlay, true);
    const page = await ctx.newPage(), errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(rig.webOrigin + '/ui/hub');
    await page.locator('#hubLogin').fill('alice'); await page.locator('#hubPassword').fill('Dummy-alice-only');
    await page.getByRole('button', { name: lang === 'zh-TW' ? '登入' : 'Sign in', exact: true }).click();
    await page.locator('.p-hub-signin').waitFor({ state: 'detached' });
    await page.goto(rig.webOrigin + '/ui/hub/admin'); await page.locator('.hub-join-card').waitFor();
    return { ctx, page, errors };
  }
  // Actual old bytes, identified per response. Current server headers/CSP remain on the response.
  const legacyIndex = new Map<string,string>();
  let oldHubHtml: { body: string; headers: Record<string,string> } | null = null;
  const cachedHubHtml = async () => {
    if (oldHubHtml !== null) return oldHubHtml;
    const oldWeb = await import('/legacy/src/web-api.ts');let status = 0, body = '';const headers: Record<string,string> = {};
    oldWeb.serveHubWorkspaceShell({ writeHead(s:number,h:Record<string,string>){status=s;Object.assign(headers,h);return this;}, setHeader(k:string,v:string){headers[k]=v;return this;},end(value:any){body=String(value??'');} } as any,{name:rig.config.name});
    if(status!==200||!body.includes('data-hub="hub"'))throw Error('Old Hub HTML renderer did not produce its real shell');
    receipt.cachedHubHtmlSha256 = createHash('sha256').update(body).digest('hex');oldHubHtml={body,headers};return oldHubHtml;
  };
  const collect = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir,e.name); if (e.isDirectory()) collect(path); else if (!legacyIndex.has(e.name)) legacyIndex.set(e.name,path);
  } };
  collect('/legacy/src/ui');
  async function skew(ctx: any, names: string[], html = false) {
    await ctx.route('**/*', async (route: any) => {
      const url = new URL(route.request().url()), name = url.pathname.split('/').at(-1)!;
      const file = names.includes(name) ? legacyIndex.get(name) : html && /^\/(ui(?:\/hub(?:\/admin)?)?|settings\/hub)$/.test(url.pathname) ? legacyIndex.get('app.html') : null;
      if (!file) return route.continue();
      const response = await route.fetch(), cached = html && file === legacyIndex.get('app.html') ? await cachedHubHtml() : null, bytes = cached ? Buffer.from(cached.body) : readFileSync(file);
      receipt.cachedAssets ??= {}; receipt.cachedAssets[file.replace('/legacy/','')] = createHash('sha256').update(bytes).digest('hex');
      return route.fulfill({ response, body: bytes, ...(cached ? {headers:{...response.headers(),...cached.headers}} : {}) });
    });
  }
  async function prepareFleet(index: number, prefix: string) {
    const number = sequence++, host = 'fleet-' + number + '.example.test', dir = mkdtempSync(join(tmpdir(),'campaign-fleet-'));
    process.env.AGEND_HOME = dir;
    const port = 55100 + number * 2, certs = makeTestCerts(host);
    writeFileSync(join(dir,'fleet.yaml'), yaml.dump({ health_port: port, instances: { recorder: { backend: 'codex', working_directory: dir, display_name: '測試 Agent' } }, web: { preview_port: port + 1, allowed_hosts: [host] } }));
    const fm: any = new FleetManager(dir), quiet = () => {};
    fm.healthPortRetried = true; fm.logger = { info:quiet,warn:quiet,error:quiet,debug:quiet,trace:quiet,fatal:quiet,child:()=>fm.logger };
    fm.notifyFleetError = () => true; fm.loadConfig(join(dir,'fleet.yaml'));
    fm.lifecycle = { isPaused:()=>false,hasWorkLease:()=>false,daemons:new Map() };
    for (const name of ['startInstance','startInstanceUnattended','restartInstance','restartFleet','stopInstance']) fm[name] = async () => { throw Error('Forbidden Agent lifecycle: ' + name); };
    let approvals = 0; fm.promptSettingsChange = async () => { approvals++; throw Error('Unexpected per-Fleet admin approval'); };
    fm.initializeWebAuthTokens(); fm.startHealthServer(port);
    await wait(() => fm.healthServerListening && fm.healthServer?.address()?.port === port);
    // An owned HTTPS reverse proxy, as a local TLS terminator would. No public/gateway headers or external ingress.
    const proxy = httpsServer({ key:readFileSync(certs.key),cert:readFileSync(certs.cert) }, (req,res) => {
      const forward = httpRequest({ hostname:'127.0.0.1',port,path:req.url,method:req.method,headers:{ ...req.headers,'x-forwarded-proto':'https' } }, r => { res.writeHead(r.statusCode!,r.headers);r.pipe(res); });
      forward.on('error',()=>{res.writeHead(502);res.end();}); req.pipe(forward); res.on('close',()=>forward.destroy());
    });
    await new Promise<void>((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
    const base = 'https://' + host + ':' + (proxy.address() as any).port;
    fm.hubEffectsReady = true;
    const controller = await fm.hubCompanyJoin();
    controller.client = new CompanyJoinClient({ ca:readFileSync(rig.certs.caCert),lookup:(_h:any,o:any,done:any)=>o.all?done(null,[{address:'127.0.0.1',family:4}]):done(null,'127.0.0.1',4) });
    const lang = index % 2 ? 'zh-TW' : 'en', phone = index % 2 === 1, theme = index % 3 ? 'dark' : 'light';
    fm.webPrefs.write('operator',new Map([['lang',lang],['theme',theme]]));
    const ctx = await context(lang,phone,theme), page = await ctx.newPage(), errors: string[] = [];
    page.on('pageerror',(e:Error)=>errors.push(e.message));
    const { tokenEpoch } = await import(built + '/web-session.js'); fm.initializeWebSessions();
    const code = fm.webLoginCodes.issue({ tier:'admin',epoch:tokenEpoch(fm.webToken),host:true }).display;
    await page.goto(base + '/signin'); await page.locator('#code').fill(code);
    // The current sign-in auto-submits; legacy manual pages use the same form.
    await page.locator('#code').evaluate((el:HTMLInputElement)=>el.form!.requestSubmit()).catch(()=>{});
    await page.waitForURL(base + '/ui'); await page.goto(base + '/settings/hub'); await page.locator('#hubCompanyAddress').waitFor();
    const f = { fm,dir,base,ctx,page,errors,lang,phone,theme,controller,proxy,certs,label:prefix+'-'+index,approvals:()=>approvals,close:async()=>{
      await ctx.close(); fm.hubEffectsReady = false; controller.close(); fm.hubRuntime?.fence(); await fm.hubRuntime?.close();
      proxy.closeAllConnections(); await new Promise<void>(done=>proxy.close(()=>done()));
      fm.healthServer?.closeAllConnections(); await new Promise<void>(done=>fm.healthServer?fm.healthServer.close(()=>done()):done());
      await fm.stopPreviewListener?.(); rmSync(dir,{recursive:true,force:true}); rmSync(certs.dir,{recursive:true,force:true});
    } };
    active.push(f); return f;
  }
  async function joinFleet(f: any, code: string, login: string, beforeSignIn: () => Promise<void> = async()=>{}, onQueued: () => void = ()=>{}) {
    const started = Date.now(); await f.page.locator('#hubCompanyAddress').fill(rig.webOrigin + ' ' + code); await f.page.locator('#hubCompanyAddress').blur();
    const rename = f.page.getByRole('button',{name:f.lang==='zh-TW'?'改名':'Rename',exact:true}); await rename.waitFor(); await rename.click();
    await f.page.locator('#hubCompanyFleetName').fill(f.label);
    await shot(f.page,f.label+'-01-fleet-start');
    const opened = f.ctx.waitForEvent('page'); await f.page.getByRole('button',{name:f.lang==='zh-TW'?'以公司帳號登入':'Sign in with company account',exact:true}).click();
    const hub = await opened; await hub.waitForURL(rig.webOrigin+'/ui/hub?join=*'); await hub.locator('#hubLogin').fill(login); await hub.locator('#hubPassword').fill('Dummy-'+login+'-only');
    await shot(hub,f.label+'-02-hub-signin'); await beforeSignIn();
    await hub.getByRole('button',{name:f.lang==='zh-TW'?'登入並連接 Fleet':'Sign in and connect Fleet',exact:true}).click();
    const queued = hub.getByText(f.lang==='zh-TW'?'目前很多人同時加入，正在排隊…':'Many people are connecting at once. Waiting in the queue…',{exact:true});
    const queueProof = queued.waitFor({timeout:10_000}).then(async()=>{ await shot(hub,f.label+'-03-queued');receipt.queueTextObserved=(receipt.queueTextObserved??0)+1;onQueued(); }).catch(()=>{});
    await wait(()=>f.fm.hubMemberLink==='online',300_000); await queueProof;
    const id = currentLocalJoinId(f.dir), journal = readLocalJoin(f.dir,id!); online.add(journal.binding.fleetId);
    check(f.label+' current production join is durably active',journal.stage==='active'&&journal.profileDigest!==null);
    check(f.label+' no per-Fleet admin approval',f.approvals()===0); check(f.label+' no page errors',f.errors.length===0);
    await shot(f.page,f.label+'-04-connected');
    receipt.visibleFleets ??= []; receipt.visibleFleets.push({label:f.label,login,origin:f.base,fleetId:journal.binding.fleetId,lang:f.lang,phone:f.phone,started,connected:Date.now(),agentLifecycle:'refused',transport:'owned HTTPS proxy to production Fleet HTTP'});
    return { started,issued:true,binding:journal.binding,connected:Date.now() };
  }
  async function adminShots() {
    // Reuse one real code across locales: captures must not bypass the ten-creations/hour policy.
    let created: any = null;
    const captures: any[] = [];
    for (const phone of [false,true]) for (const lang of ['en','zh-TW']) for (const theme of ['light','dark']) {
      const {ctx,page,errors} = await adminPage(lang,phone,theme), tag=(phone?'phone':'desk')+'-'+theme+'-'+lang;
      try {
        const create = page.getByRole('button',{name:lang==='zh-TW'?'建立加入碼':'Create join code',exact:true}); await create.waitFor(); await create.scrollIntoViewIfNeeded();
        await page.waitForFunction(()=>{const b=document.querySelector('[data-enrolment-codes] .n-actions button') as HTMLButtonElement|null;return b!==null&&!b.disabled;});
        await shot(page,tag+'-admin-before'); await create.click(); await page.locator('#hubEnrolmentCreate').waitFor(); await shot(page,tag+'-create-dialog');
        await page.locator('#hubCodeScope').selectOption('group');await page.locator('#hubEnrolmentScopeSearch').fill('Own');
        check(tag+' scoped picker input and note are distinct',await page.locator('#hubEnrolmentScopeSearch').count()===1
          &&await page.locator('#hubEnrolmentScopeSearch').getAttribute('aria-describedby')==='hubEnrolmentScopeSearchNote'
          &&await page.locator('#hubEnrolmentScopeSearchNote').count()<=1
          &&await page.locator('#hubGroupSearch').count()<=1);
        await page.locator('dialog .hub-group-hits button').first().click();
        await page.locator('#hubEnrolmentScopeSearch').waitFor({state:'detached'});
        await page.locator('dialog').getByText('CN=Owners,DC=example,DC=test',{exact:false}).waitFor();await shot(page,tag+'-resolved-group');
        check(tag+' resolved picker retires its input',await page.locator('#hubEnrolmentScopeSearch').count()===0);
        await page.locator('#hubCodeScope').selectOption('directory');
        if (created === null) {
          const answer = page.waitForResponse((r:any)=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/hub/v1/admin/enrolment-codes');
          await page.locator('button[form="hubEnrolmentCreate"]').click(); created = await (await answer).json();
        } else {
          await page.getByRole('button',{name:lang==='zh-TW'?'取消':'Cancel',exact:true}).click();
        }
        const row = page.locator('[data-enrolment-code="'+created.id+'"]'); await row.locator('code').waitFor(); await shot(page,tag+'-active-code');
        await page.reload(); await page.locator('[data-enrolment-code="'+created.id+'"] code').waitFor();
        check(tag+' admin page errors',errors.length===0); captures.push({lang,phone,theme,tag});
      } finally { await ctx.close(); }
    }
    // End it once through the real UI, then capture the retained ended row in each presentation.
    for (const [index,{lang,phone,theme,tag}] of captures.entries()) {
      const {ctx,page,errors}=await adminPage(lang,phone,theme);
      try {
        const row=page.locator('[data-enrolment-code="'+created.id+'"]'); await row.waitFor();
        if(index===0) { await row.locator('button.btn-danger').click(); await row.locator('code').waitFor({state:'detached'}); }
        check(tag+' ended code is not redisplayed',await row.locator('code').count()===0);
        await shot(page,tag+'-ended-code');check(tag+' ended page errors',errors.length===0);
      } finally { await ctx.close(); }
    }
  }

  async function cachedShots() {
    for (const phone of [false,true]) for (const lang of ['en','zh-TW']) {
      const names=['app-shell.js','app-html.js','app-i18n.js','app.css','hub-client.js'];
      const {ctx,page,errors}=await adminPage(lang,phone,'dark',names);
      try { await shot(page,(phone?'phone':'desk')+'-dark-'+lang+'-cached-shell-client-css');
        check('cached client safely omits code manager',await page.locator('[data-enrolment-codes]').count()===0);
        check('cached shell no script errors',errors.length===0);
      } finally { await ctx.close(); }
    }
  }
  return { adminShots,cachedShots,prepareFleet,joinFleet,shot,adminPage,closeVisible:async()=>{ const failures:unknown[]=[];try{for(const f of active.splice(0).reverse()){try{await f.close();}catch(e){failures.push(e);}}}finally{process.env.AGEND_HOME=environmentHome;}if(failures.length)throw new AggregateError(failures,'Owned Fleet cleanup failed'); } };
}
