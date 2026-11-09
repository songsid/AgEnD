/** Shared presentation only. Hub-admin and D3 adapters supply independently authorized server calls. No fleet imports. */
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { Skeleton } from "/assets/ui-states.js";
import { Dialog } from "/assets/ui-dialog.js";
import { PageHead } from "/assets/page-head.js";
import { Icon } from "/assets/ui-icons.js";
import { hd, directoryError } from "./hub-directory-editor-strings.js";
const REF = /^[A-Za-z0-9_-]{32}$/, FP = /^[A-F0-9]{64}$/;
const fingerprint = value => String(value || "").replace(/:/g, "").toUpperCase();
const same = (a, b) => JSON.stringify(Object.keys(a).sort().map(k => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map(k => [k, b[k]]));
const fail = code => { throw Object.assign(Error(code), { code }); };
export function directoryEndpoint(value) {
  try { const u = new URL(value); return u.protocol === "ldaps:" && u.hostname && !u.username && !u.password && (!u.pathname || u.pathname === "/") && !u.search && !u.hash ? `ldaps://${u.hostname}:${u.port || "636"}` : null; } catch { return null; }
}
export function directoryView(value) {
  return value?.ok === true && Number.isSafeInteger(value.epoch) && value.epoch >= 0 && value.bindPasswordSet === true
    && ["host", "recent", "required"].includes(value.reauthentication) && typeof value.directory?.realm === "string"
    && typeof value.directory.profile === "string" && directoryEndpoint(value.directory.url)
    && typeof value.directory.baseDn === "string" && typeof value.directory.bindDn === "string";
}
export async function directoryCaFingerprints(pem) {
  const blocks = String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  if (!blocks.length || blocks.length > 4 || pem.length > 65536 || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()) fail("invalid");
  return (await Promise.all(blocks.map(async block => {
    const raw = atob(block.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, ""));
    const sha = await crypto.subtle.digest("SHA-256", Uint8Array.from(raw, c => c.charCodeAt(0)));
    return [...new Uint8Array(sha)].map(b => b.toString(16).padStart(2, "0").toUpperCase()).join("");
  }))).sort();
}
function Fingerprint({ value }) { const f = fingerprint(value); return html`<code class="hub-directory-fingerprint">${(f.match(/.{1,2}/g) || []).map((b, i) => html`<span>${b + (i < 31 ? ":" : "")}</span><wbr />`)}</code>`; }
const formOf = view => ({ ...view.directory, ca: view.directory.caPem === undefined ? "system" : "paste", caPem: view.directory.caPem || "", bindPassword: "", loginAttribute: view.directory.loginAttribute || "", userFilter: view.directory.userFilter || "", timeoutMs: String(view.directory.timeoutMs || 5000) });
export function directoryInput(form) {
  const directory = { url: form.url.trim(), baseDn: form.baseDn.trim(), bindDn: form.bindDn.trim(), timeoutMs: Number(form.timeoutMs),
    ...(form.ca === "paste" ? { caPem: form.caPem } : {}), ...(form.loginAttribute.trim() ? { loginAttribute: form.loginAttribute.trim() } : {}), ...(form.userFilter.trim() ? { userFilter: form.userFilter.trim() } : {}) };
  if (!directoryEndpoint(directory.url) || !directory.baseDn || !directory.bindDn || !Number.isSafeInteger(directory.timeoutMs) || directory.timeoutMs < 500 || directory.timeoutMs > 30000) fail("invalid");
  return { directory, ...(form.bindPassword !== "" ? { bindPassword: form.bindPassword } : {}) };
}
export function HubDirectoryEditor({ client, offered = false, host = false, login = "", afterSave = async () => true, showHeading = true }) {
  const [view, setView] = useState(null), [form, setForm] = useState(null), [busy, setBusy] = useState(false), [activity, setActivity] = useState("testing"), [error, setFailureCode] = useState(""), [notice, setNotice] = useState(""),
    [dialog, setDialog] = useState(null), [uncertain, setUncertain] = useState(false), [auth, setAuth] = useState({ login, password: "" }), [requireAuth, setRequireAuth] = useState(false);
  const life = useRef(0), ended = useRef(false), working = useRef(false), saveSent = useRef(false), requests = useRef(new Set()), draft = useRef(null);
  const current = n => n === life.current && !ended.current && offered && client?.directoryEditorV1 === true;
  const send = async (method, input, signal) => {
    const result = await client[method](input, signal);
    if (!result?.ok) throw Object.assign(Error("directory"), { code: result?.code || "unavailable" }); return result;
  };
  // A read's first argument is its signal; the other methods take (body, signal).
  const read = async signal => { const r = await client.directorySettings(signal); if (!r?.ok) fail(r?.code || "unavailable"); if (!directoryView(r)) fail("unsupported"); return r; };
  const cancel = () => { const ref = draft.current; draft.current = null; if (REF.test(ref || "")) void client.cancelDirectorySettings({ ref }).catch(() => {}); };
  const invalidate = () => { life.current++; for (const request of requests.current) request.abort(); working.current = false; setBusy(false); cancel(); setDialog(null); };
  const run = async work => {
    if (working.current || !current(life.current)) return;
    const n = life.current, abort = new AbortController(); requests.current.add(abort); working.current = true; setBusy(true); setFailureCode(""); setNotice("");
    try { await work(n, abort.signal); }
    catch (e) { if (current(n)) { cancel(); setDialog(null); setAuth(a => ({ ...a, password: "" }));
      if (saveSent.current && e.code !== "reauthentication") { setUncertain(true); setForm(f => f && ({ ...f, bindPassword: "" })); setFailureCode("uncertain"); }
      else if (e.code === "reauthentication") { saveSent.current = false; setRequireAuth(true); setFailureCode("reauthentication"); }
      else setFailureCode(e.code || "unavailable"); } }
    finally { requests.current.delete(abort); if (current(n)) { working.current = false; setBusy(false); } }
  };
  const load = () => run(async (n, signal) => { cancel(); const r = await read(signal); if (!current(n)) return;
    setView(r); setForm(formOf(r)); setRequireAuth(r.reauthentication === "required"); setUncertain(false); saveSent.current = false; setDialog(null); setAuth({ login, password: "" }); });
  useEffect(() => {
    life.current++; ended.current = false;
    if (!offered || client?.directoryEditorV1 !== true) { setFailureCode("unsupported"); return; }
    void load();
    const off = client.onSignedOut?.(() => { ended.current = true; invalidate(); setForm(null); setView(null); setAuth({ login: "", password: "" }); setFailureCode("denied"); });
    return () => { ended.current = true; invalidate(); off?.(); };
  }, [client, offered]);
  const update = (name, value) => { if (working.current) return; invalidate(); setFailureCode(""); setNotice(""); setForm(f => ({ ...f, [name]: value })); };
  const stop = () => { invalidate(); if (saveSent.current) { setUncertain(true); setFailureCode("uncertain"); } setAuth(a => ({ ...a, password: "" })); setForm(f => f && ({ ...f, bindPassword: "" })); };
  const prepare = async (candidate, n, signal) => {
    cancel(); const input = directoryInput(candidate);
    if (input.bindPassword === undefined && (input.directory.url !== view.directory.url || input.directory.bindDn !== view.directory.bindDn || input.directory.caPem !== view.directory.caPem)) fail("dirtySecret");
    const p = await send("prepareDirectorySettings", input, signal);
    if (!current(n)) { if (REF.test(p.ref || "")) void client.cancelDirectorySettings({ ref: p.ref }).catch(() => {}); return null; }
    if (!REF.test(p.ref || "") || !Number.isSafeInteger(p.expiresAt) || p.trust !== null && (typeof p.trust !== "object" || !p.trust)) fail("unsupported"); draft.current = p.ref;
    const latest = await read(signal); if (!current(n)) return null;
    if (latest.epoch !== view.epoch || !same(latest.directory, view.directory)) fail("stale");
    if (p.trust && (directoryEndpoint(p.trust.server) !== directoryEndpoint(candidate.url) || !FP.test(fingerprint(p.trust.leafFingerprint))
      || !Array.isArray(p.trust.caFingerprints) || p.trust.caFingerprints.some(f => !FP.test(fingerprint(f))) || typeof p.trust.challenge !== "string")) fail("unsupported");
    return p;
  };
  const finish = async (p, intent, n, signal) => {
    if (!p || draft.current !== p.ref || !current(n)) return;
    const input = { ref: p.ref, ...(p.trust ? { confirmation: p.trust.challenge } : {}) };
    if (intent === "test") { await send("testDirectorySettings", input, signal); if (current(n)) { cancel(); setDialog(null); setNotice("tested"); } return; }
    if (!host && requireAuth && (!auth.login || !auth.password)) fail("reauthentication");
    setActivity("saving"); draft.current = null; saveSent.current = true; // Never automatically replay a consumed or ambiguous Save.
    const result = await send("saveDirectorySettings", { ...input, ...(!host && auth.password ? { credentials: { ...auth } } : {}) }, signal);
    if (!current(n)) return;
    setAuth(a => ({ ...a, password: "" })); setForm(f => ({ ...f, bindPassword: "" })); setDialog(null);
    if (result.state !== "ready" || !Number.isSafeInteger(result.directoryEpoch) || result.directoryEpoch <= view.epoch) { setUncertain(true); setFailureCode(result.state === "restored" ? "restored" : "uncertain"); return; }
    if (await afterSave() !== true || !current(n)) { if (current(n)) { setUncertain(true); setFailureCode("uncertain"); } return; }
    const fresh = await read(signal); if (!current(n)) return;
    setView(fresh); setForm(formOf(fresh)); setRequireAuth(fresh.reauthentication === "required"); saveSent.current = false; setNotice("saved");
  };
  const submit = intent => run(async (n, signal) => {
    if (uncertain) return; setActivity(intent === "save" ? "saving" : "testing"); const p = await prepare(form, n, signal); if (!p || !current(n)) return;
    if (p.trust) setDialog({ phase: "ready", p, intent }); else await finish(p, intent, n, signal);
  });
  const inspect = () => run(async (n, signal) => {
    setActivity("fetching"); const probe = await send("inspectDirectoryCa", { url: form.url.trim() }, signal); if (!current(n)) return;
    if (!REF.test(probe.ref || "") || directoryEndpoint(probe.server) !== directoryEndpoint(form.url) || !FP.test(fingerprint(probe.certificate?.fingerprint256))) fail("unsupported");
    setDialog({ phase: "probe", probe, intent: "save" });
  });
  const fetchCa = credentials => run(async (n, signal) => {
    setActivity("fetching"); const previous = dialog.probe;
    // Every failed fetch consumed its ref. A credential retry re-probes and requires the same explicitly confirmed leaf.
    const probe = credentials ? await send("inspectDirectoryCa", { url: form.url.trim() }, signal) : previous;
    if (!current(n)) return;
    if (!REF.test(probe.ref || "") || directoryEndpoint(probe.server) !== directoryEndpoint(previous.server) || fingerprint(probe.certificate?.fingerprint256) !== fingerprint(previous.certificate?.fingerprint256)) fail("trust");
    let bundle;
    try { bundle = await send("fetchDirectoryCa", { ref: probe.ref, fingerprint: previous.certificate.fingerprint256,
      ...(credentials ? { bindDn: form.bindDn.trim(), bindPassword: form.bindPassword } : {}) }, signal); }
    catch (e) { if (e.code === "ca-auth-required" && current(n)) { setDialog({ ...dialog, phase: "auth" }); return; } throw e; }
    if (!current(n)) return;
    if (directoryEndpoint(bundle.server) !== directoryEndpoint(previous.server) || fingerprint(bundle.leafFingerprint) !== fingerprint(previous.certificate.fingerprint256) || typeof bundle.caPem !== "string") fail("trust");
    const fingerprints = await directoryCaFingerprints(bundle.caPem); if (!current(n)) return;
    const candidate = { ...form, ca: "paste", caPem: bundle.caPem }; setForm(candidate);
    const p = await prepare(candidate, n, signal); if (!p || !current(n)) return;
    if (!p.trust || fingerprint(p.trust.leafFingerprint) !== fingerprint(previous.certificate.fingerprint256) || directoryEndpoint(p.trust.server) !== directoryEndpoint(previous.server)
      || JSON.stringify(p.trust.caFingerprints.map(fingerprint).sort()) !== JSON.stringify(fingerprints)) fail("trust");
    setForm(candidate); setDialog({ phase: "ready", p, intent: "save" });
  });
  const field = (name, { type = "text", multiline = false, optional = false, max = 2048 } = {}) => html`<label class="field" for=${"hubDirectory-" + name}>${hd(name)}
    ${multiline ? html`<textarea id=${"hubDirectory-" + name} rows="4" value=${form[name]} maxlength=${max} spellcheck=${false} onInput=${e => update(name, e.target.value)} />`
      : html`<input id=${"hubDirectory-" + name} type=${type} value=${form[name]} required=${!optional} maxlength=${max} autocomplete=${type === "password" ? "new-password" : "off"} spellcheck=${false} onInput=${e => update(name, e.target.value)} />`}
  </label>`;
  const authentication = () => !host && requireAuth ? html`<div class="form hub-directory-auth"><h4>${hd("reauth")}</h4><p class="note">${hd("reauthHint")}</p>
    <label class="field">${hd("login")}<input autocomplete="username" disabled=${busy} value=${auth.login} maxlength="256" onInput=${e => setAuth(a => ({ ...a, login: e.target.value }))} /></label>
    <label class="field">${hd("password")}<input type="password" autocomplete="current-password" disabled=${busy} value=${auth.password} maxlength="4096" onInput=${e => setAuth(a => ({ ...a, password: e.target.value }))} /></label></div>` : null;
  const status = error ? html`<p class="err" role="alert">${error === "reauthentication" ? hd("reauthHint") : directoryError(error)}</p>` : null;
  return html`<section class="card s-group hub-directory-editor" id="hub-directory-editor">${showHeading ? html`<h3>${hd("title")}</h3><p class="note">${hd(host ? "hostLead" : "lead")}</p>` : null}
    ${!form && !error ? html`<${Skeleton} variant="form" lines=${3} />` : null}${status}
    ${notice ? html`<p class="note" role="status">${hd(notice)}</p>` : null}
    ${form && !uncertain ? html`<form class="form" onSubmit=${e => { e.preventDefault(); void submit("save"); }}><fieldset class="form" disabled=${busy}>
      <div class="grid2"><div class="field"><span>${hd("realm")}</span><code>${form.realm}</code></div><div class="field"><span>${hd("profile")}</span><code>${form.profile}</code></div></div>
      ${field("url", { type: "url" })}${field("baseDn", { max: 1024 })}${field("bindDn", { max: 1024 })}${field("bindPassword", { type: "password", optional: true, max: 4096 })}<p class="note">${hd("secretHint")}</p>
      <label class="field">${hd("ca")}<select id="hubDirectory-ca" value=${form.ca} onChange=${e => update("ca", e.target.value)}><option value="system">${hd("system")}</option><option value="paste">${hd("paste")}</option></select><small class="note">${hd("choose")}</small></label>
      ${form.ca === "paste" ? field("caPem", { multiline: true, max: 65536 }) : null}
      <div class="s-row"><button type="button" class="btn" onClick=${inspect}>${hd("fetch")}</button></div><p class="note">${hd("fetchingHint")}</p>
      <details class="s-ui-disclosure"><summary>${hd("advanced")}</summary><div class="s-disclosure-body form">${field("loginAttribute", { optional: true, max: 64 })}${field("userFilter", { optional: true, max: 8192 })}${field("timeoutMs", { type: "number" })}</div></details>
      ${authentication()}<div class="s-row"><button class="btn btn-primary" type="submit">${hd("save")}</button><button class="btn" type="button" onClick=${() => submit("test")}>${hd("test")}</button></div>
    </fieldset></form>` : null}
    ${!busy && error ? html`<div class="s-row"><button class="btn" type="button" disabled=${ended.current || !offered} onClick=${load}>${hd("reload")}</button></div>` : null}
    ${busy ? html`<p class="note" role="status">${hd(activity)}</p>` : null}
    ${dialog ? html`<${Dialog} title=${hd("trustTitle")} onClose=${stop} cls="hub-directory-editor" busy=${busy}
      actions=${html`<button class="btn" onClick=${stop}>${hd("stop")}</button>${dialog.phase === "ready"
        ? html`<button class="btn btn-primary" disabled=${busy} onClick=${() => run((n, signal) => finish(dialog.p, dialog.intent, n, signal))}>${hd(dialog.intent === "test" ? "confirmTest" : "confirmSave")}</button>`
        : html`<button class="btn btn-primary" disabled=${busy || dialog.phase === "auth" && !form.bindPassword} onClick=${() => fetchCa(dialog.phase === "auth")}>${hd(dialog.phase === "auth" ? "fetchAuth" : "fetchConfirm")}</button>`}`}>
      <p class="note">${hd("trustHint")}</p><div class="field"><span>${hd("server")}</span><code>${dialog.p?.trust.server || dialog.probe.server}</code></div>
      <div class="field"><span>${hd("leaf")}</span><${Fingerprint} value=${dialog.p?.trust.leafFingerprint || dialog.probe.certificate.fingerprint256} /></div>
      ${dialog.phase === "ready" ? html`${dialog.p.trust.caFingerprints.map(fp => html`<div class="field"><span>${hd("caPrint")}</span><${Fingerprint} value=${fp} /></div>`)}${dialog.p.trust.systemRoots ? html`<p class="note">${hd("system")}</p>` : null}${authentication()}` : null}
      ${dialog.phase !== "ready" ? html`<p class="note">${hd(dialog.phase === "auth" ? "fetchAuthHint" : "secretHint")}</p><div class="field"><span>${hd("bindDn")}</span><code>${form.bindDn}</code></div>
        <label class="field">${hd("bindPassword")}<input type="password" autocomplete="new-password" disabled=${busy} value=${form.bindPassword} maxlength="1024" onInput=${e => setForm(f => ({ ...f, bindPassword: e.target.value }))} /></label>` : null}
    </${Dialog}>` : null}
  </section>`;
}
export function HubDirectoryPage(props) {
  return html`<div class="col hub-owner"><a class="hub-crumb" href="/ui/hub/admin"><${Icon} name="back" size=${14} />${hd("back")}</a><${PageHead} title=${hd("title")} scope=${hd("scope")} lead=${hd("lead")} /><div class="s-section-layout"><${HubDirectoryEditor} ...${props} showHeading=${false} /></div></div>`;
}
