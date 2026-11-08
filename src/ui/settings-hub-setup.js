/** First setup only, on this computer's D3 host page. Every effect reauthorizes on the server. */
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { Skeleton, ErrorState } from "/assets/ui-states.js";
import { api } from "./settings-confirm.js";
import { hs, setupError } from "./settings-hub-setup-strings.js";
const PREFIX = "/api/settings/hub/setup";
const REF = /^[A-Za-z0-9_-]{32}$/;
export function hubSetupMarked(doc = typeof document !== "undefined" ? document : null) {
  return doc?.body?.dataset.hubSetup === "1" && doc.body.dataset.publicLink !== "1" && doc.body.dataset.hub !== "hub";
}
/** Display-only PEM fingerprints. The server independently parses, validates and confirms every CA before bind. */
export async function setupCaFingerprints(pem) {
  const blocks = String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  if (!blocks.length || blocks.length > 4 || pem.length > 65536 || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()) throw Error("caInvalid");
  return Promise.all(blocks.map(async block => {
    const raw = atob(block.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, ""));
    const sha = await crypto.subtle.digest("SHA-256", Uint8Array.from(raw, c => c.charCodeAt(0)));
    return [...new Uint8Array(sha)].map(b => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
  }));
}
const defaults = () => ({ name: "", webOrigin: "", memberOrigin: "", webHost: "127.0.0.1", webPort: "19443", memberHost: "127.0.0.1", memberPort: "19444", coexistence: "dedicated",
  certificate: "generate", certPem: "", keyPem: "", realm: "", profile: "ad", url: "", baseDn: "", bindDn: "", bindPassword: "", ca: "system", caPem: "", loginAttribute: "", userFilter: "", timeoutMs: "5000", administratorLogin: "", contentDays: "30", eventDays: "90" });
const httpsOrigin = value => { try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash; } catch { return false; } };
const directoryEndpoint = value => {
  try {
    const u = new URL(value);
    if (u.protocol !== "ldaps:" || !u.hostname || u.username || u.password || (u.pathname && u.pathname !== "/") || u.search || u.hash) return null;
    return `ldaps://${u.hostname}:${u.port || "636"}`;
  } catch { return null; }
};
const validInt = (v, lo, hi) => /^\d+$/.test(v) && Number(v) >= lo && Number(v) <= hi;
export function setupInput(f, confirmedCa) {
  const optional = v => v.trim() || undefined;
  return { ...(f.name.trim() ? { name: f.name.trim() } : {}), webOrigin: f.webOrigin.trim(), memberOrigin: f.memberOrigin.trim(),
    webListen: { host: f.webHost.trim(), port: Number(f.webPort) }, memberListen: { host: f.memberHost.trim(), port: Number(f.memberPort) }, coexistence: f.coexistence,
    ...(f.certificate === "import" ? { browserTls: { certPem: f.certPem, keyPem: f.keyPem } } : {}),
    directory: { realm: f.realm.trim(), profile: f.profile, url: f.url.trim(), baseDn: f.baseDn.trim(), bindDn: f.bindDn.trim(), ...(f.ca !== "system" ? { caPem: f.caPem } : {}),
      loginAttribute: optional(f.loginAttribute), userFilter: optional(f.userFilter), timeoutMs: Number(f.timeoutMs) }, bindPassword: f.bindPassword,
    administratorLogin: f.administratorLogin.trim(), confirmedCa: f.ca === "system" ? [] : confirmedCa, retention: { contentDays: Number(f.contentDays), eventDays: Number(f.eventDays) } };
}
function Fingerprint({ value }) {
  const bytes = String(value).split(":");
  return html`<code class="mono hub-setup-fingerprint">${bytes.map((byte, i) => html`<span>${byte + (i + 1 < bytes.length ? ":" : "")}</span><wbr />`)}</code>`;
}
function Field({ name, form, update, type = "text", hint, required = true, max = 2048, min, maxNumber, multiline = false }) {
  const id = "hubSetup-" + name;
  const props = { id, name, value: form[name], required, maxLength: max, autoComplete: type === "password" ? "new-password" : "off", spellcheck: false,
    onInput: e => update(name, e.target.value), ...(type === "number" ? { min, max: maxNumber, step: 1, inputmode: "numeric" } : {}) };
  return html`<label class="field" for=${id}>${hs(name)}${multiline ? html`<textarea ...${props} rows="4" />` : html`<input ...${props} type=${type} />`}${hint ? html`<small class="note">${hs(hint)}</small>` : null}</label>`;
}
export function HubSetupSettings() {
  const [view, setView] = useState(null), [step, setStep] = useState(0), [form, setForm] = useState(defaults), [busy, setBusy] = useState(false), [error, setFailureCode] = useState(""),
    [probe, setProbe] = useState(null), [fingerprints, setFingerprints] = useState([]), [caChecked, setCaChecked] = useState(false), [caError, setCaError] = useState(false),
    [review, setReview] = useState(null), [created, setCreated] = useState(null), [uncertain, setUncertain] = useState(false);
  const life = useRef(0), running = useRef(false), requests = useRef(new Set()), draft = useRef(null), probeRef = useRef(null), caGeneration = useRef(0);
  const current = n => n === life.current && hubSetupMarked() && !(typeof window !== "undefined" && window.AgendAuth?.sessionEnded?.());
  const send = async (action, body, signal) => {
    const r = await api(PREFIX + action, { cache: "no-store", credentials: "same-origin", ...(signal ? { signal } : {}), ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    if (!r.ok) throw Object.assign(Error("setup"), { code: r.body?.error || "unavailable" });
    return r.body;
  };
  const cancelRef = ref => { if (REF.test(ref || "")) void send("/cancel", { ref }).catch(() => {}); };
  const clearDraft = () => { cancelRef(draft.current); draft.current = null; setReview(null); };
  const clearProbe = () => { cancelRef(probeRef.current); probeRef.current = null; setProbe(null); };
  const run = async work => {
    if (running.current || !current(life.current)) return;
    running.current = true; setBusy(true); setFailureCode("");
    const n = life.current, abort = new AbortController(); requests.current.add(abort);
    try { await work(n, abort.signal); } catch (e) { if (current(n)) setFailureCode(e.code || "unavailable"); }
    finally { requests.current.delete(abort); running.current = false; if (current(n)) setBusy(false); }
  };
  useEffect(() => {
    const n = ++life.current;
    if (!hubSetupMarked()) { setFailureCode("host_session_required"); return; }
    const abort = new AbortController(); requests.current.add(abort);
    send("", undefined, abort.signal).then(v => {
      if (!current(n)) return;
      if (v?.v !== 1 || typeof v.initialized !== "boolean" || typeof v.incomplete !== "boolean" || typeof v.existingFleet !== "boolean") { setFailureCode("unsupported"); return; }
      setView(v); setForm(f => ({ ...f, coexistence: v.existingFleet ? "" : "dedicated" }));
    }, e => { if (current(n)) setFailureCode(e.code || "unavailable"); }).finally(() => requests.current.delete(abort));
    const off = typeof window !== "undefined" ? window.AgendAuth?.onSessionEnd?.(() => {
      life.current++; for (const r of requests.current) r.abort(); setForm(defaults()); setReview(null); setProbe(null); setFailureCode("denied");
    }) : null;
    return () => { life.current++; off?.(); for (const r of requests.current) r.abort(); cancelRef(draft.current); cancelRef(probeRef.current); draft.current = null; probeRef.current = null; };
  }, []);
  useEffect(() => {
    const generation = ++caGeneration.current;
    setCaChecked(false); setFingerprints([]); setCaError(false);
    if (form.ca === "system" || !form.caPem) return;
    setupCaFingerprints(form.caPem).then(fps => { if (generation === caGeneration.current) setFingerprints(fps); }, () => { if (generation === caGeneration.current) setCaError(true); });
    return () => { caGeneration.current++; };
  }, [form.ca, form.caPem]);
  const update = (name, value) => {
    clearDraft(); setFailureCode("");
    if (["url", "ca"].includes(name)) { clearProbe(); setCaChecked(false); setFingerprints([]); }
    setForm(f => ({ ...f, [name]: value, ...(name === "url" ? { caPem: "" } : {}) }));
  };
  const field = (name, props = {}) => html`<${Field} name=${name} form=${form} update=${update} ...${props} />`;
  const select = (name, choices, hint) => html`<label class="field" for=${"hubSetup-" + name}>${hs(name)}<select id=${"hubSetup-" + name} value=${form[name]} onChange=${e => update(name, e.target.value)} required>
    ${choices.map(([value, key]) => html`<option value=${value}>${hs(key)}</option>`)}
    </select>${hint ? html`<small class="note">${hs(hint)}</small>` : null}</label>`;
  const next = e => {
    e.preventDefault(); if (running.current) return;
    if (step === 1 && (!httpsOrigin(form.webOrigin.trim()) || !httpsOrigin(form.memberOrigin.trim()) || !validInt(form.webPort, 1, 65535) || !validInt(form.memberPort, 1, 65535) || Number(form.webPort) === Number(form.memberPort) || !form.coexistence)) { setFailureCode("invalid"); return; }
    if (step === 2 && !directoryEndpoint(form.url.trim())) { setFailureCode("invalid"); return; }
    if (step === 2 && form.ca !== "system" && (!fingerprints.length || !caChecked || caError)) { setFailureCode("trust"); return; }
    setFailureCode(""); setStep(step + 1);
  };
  const prepare = e => { e.preventDefault(); void run(async (n, signal) => {
    if (form.ca !== "system" && (!caChecked || !fingerprints.length || caError)) throw { code: "trust" };
    const p = await send("/prepare", setupInput(form, fingerprints), signal);
    if (!current(n)) { cancelRef(p?.ref); return; }
    if (p?.v !== 1 || !REF.test(p.ref) || !httpsOrigin(p.webOrigin) || !httpsOrigin(p.memberOrigin) || !p.certificate?.fingerprint || !Number.isSafeInteger(p.expiresAt)) { cancelRef(p?.ref); throw { code: "unsupported" }; }
    draft.current = p.ref;
    try {
      const tested = await send("/test", { ref: p.ref }, signal);
      if (!current(n)) return;
      if (tested?.ok !== true) throw { code: "unavailable" };
      setReview(p); setForm(f => ({ ...f, bindPassword: "", keyPem: "" })); setStep(4);
    } catch (e) { clearDraft(); throw e; }
  }); };
  const inspect = () => void run(async (n, signal) => {
    clearProbe(); const p = await send("/ca/inspect", { url: form.url.trim() }, signal);
    if (!current(n)) { cancelRef(p?.ref); return; }
    if (!REF.test(p?.ref || "") || !p.certificate?.fingerprint256 || directoryEndpoint(p.server) !== directoryEndpoint(form.url.trim()) || !directoryEndpoint(p.server)) { cancelRef(p?.ref); throw { code: "unsupported" }; }
    probeRef.current = p.ref; setProbe(p);
  });
  const fetchCa = () => void run(async (n, signal) => {
    if (!probe || probeRef.current !== probe.ref) return;
    const ca = await send("/ca/fetch", { ref: probe.ref, fingerprint: probe.certificate.fingerprint256,
      ...(form.bindDn && form.bindPassword ? { bindDn: form.bindDn, bindPassword: form.bindPassword } : {}) }, signal);
    if (!current(n)) return;
    if (typeof ca?.caPem !== "string") throw { code: "unavailable" };
    clearProbe(); update("caPem", ca.caPem);
  });
  const commit = () => void run(async (n, signal) => {
    if (!review || draft.current !== review.ref || uncertain) return;
    const ref = draft.current; draft.current = null; // Never replay an ambiguous/consumed commit.
    try {
      const r = await send("/commit", { ref }, signal);
      if (!current(n)) return;
      if (r?.ok !== true || r.webOrigin !== review.webOrigin) throw { code: "uncertain" };
      setCreated({ webOrigin: review.webOrigin }); setReview(null); setForm(defaults());
    } catch { if (current(n)) { setUncertain(true); setReview(null); setForm(defaults()); setFailureCode("uncertain"); } }
  });
  const cancel = () => { clearDraft(); clearProbe(); setForm({ ...defaults(), coexistence: view?.existingFleet ? "" : "dedicated" }); setStep(0); setFailureCode(""); };
  const blocked = view?.initialized ? "initialized" : view?.incomplete ? "incomplete" : "";
  const message = error === "unsupported" || error === "caInvalid" || error === "uncertain" ? hs(error) : setupError(error);
  const titles = ["title", "hub", "directory", "administrator", "review"];
  return html`<section class="card s-group hub-setup" id="hub-setup"><h3>${hs(created ? "created" : "title")}</h3>
    <p class="note">${hs(created ? "createdHint" : "hint")}</p>
    ${!view && !error ? html`<${Skeleton} variant="form" lines=${2} />` : null}
    ${error ? html`<${ErrorState} message=${message} />` : null}
    ${blocked || uncertain || error === "unsupported" || (!view && error) ? html`<p class="note">${blocked ? hs(blocked) : ""}</p><div class="s-row"><a class="btn" href="/settings/hub">${hs("reload")}</a></div>` : null}
    ${created ? html`<div class="s-row"><a class="btn btn-primary" href=${created.webOrigin + "/ui/hub"} target="_blank" rel="noopener noreferrer">${hs("open")}</a><a class="btn" href="/settings/hub">${hs("reload")}</a></div>` : null}
    ${view && !blocked && !created && !uncertain && !error?.match(/^(unsupported|denied|host_session_required)$/) ? step === 0 ? html`<div class="s-row"><button class="btn" onClick=${() => setStep(1)}>${hs("start")}</button></div>` : html`
      <p class="note" role="status">${step} / 4 · ${hs(titles[step])}</p>
      <form class="form" onSubmit=${step === 3 ? prepare : step === 4 ? e => e.preventDefault() : next}>
      <fieldset class="form" disabled=${busy}>
      ${step === 1 ? html`${field("name", { required: false, max: 64, hint: "nameHint" })}<div class="grid2">${field("webOrigin", { type: "url" })}${field("memberOrigin", { type: "url" })}</div><p class="note">${hs("addressHint")}</p>
        <div class="grid2">${field("webHost")}${field("webPort", { type: "number", min: 1, maxNumber: 65535 })}${field("memberHost")}${field("memberPort", { type: "number", min: 1, maxNumber: 65535 })}</div><p class="note">${hs("listenHint")}</p>
        ${select("coexistence", [["", "choose"], ["dedicated", "dedicated"], ["same-user-pilot", "shared"]], "coexistenceHint")}
        ${select("certificate", [["generate", "generate"], ["import", "import"]], "certificateHint")}
        ${form.certificate === "import" ? html`${field("certPem", { multiline: true, max: 65536 })}${field("keyPem", { multiline: true, max: 16384 })}` : null}` : null}
      ${step === 2 ? html`<div class="grid2">${field("realm", { max: 64, hint: "realmHint" })}${select("profile", [["ad", "ad"], ["openldap", "openldap"]])}</div>${field("url", { type: "url" })}${field("baseDn", { max: 1024 })}${field("bindDn", { max: 1024 })}${field("bindPassword", { type: "password", max: 4096, hint: "secretHint" })}
        ${select("ca", [["system", "system"], ["paste", "paste"], ["fetch", "fetch"]])}
        ${form.ca === "fetch" ? html`<p class="note">${hs("inspectHint")}</p><div class="s-row"><button class="btn" type="button" disabled=${!form.url} onClick=${inspect}>${hs("inspect")}</button></div>
          ${probe ? html`<div class="form"><p class="note">${probe.server}</p><label class="field">${hs("leaf")}<${Fingerprint} value=${probe.certificate.fingerprint256} /></label><p class="note">${probe.certificate.subject}</p><p class="note">${probe.certificate.issuer}</p><p class="note">${hs("validTo")}: ${probe.certificate.validTo}</p>
            <div class="s-row"><button class="btn btn-primary" type="button" onClick=${fetchCa}>${hs("fetchConfirm")}</button><button class="btn" type="button" onClick=${clearProbe}>${hs("stop")}</button></div></div>` : null}` : null}
        ${form.ca === "paste" ? field("caPem", { multiline: true, max: 65536 }) : null}
        ${form.ca !== "system" && fingerprints.length ? html`<div class="form"><p class="note">${hs("caHint")}</p>${fingerprints.map(fp => html`<${Fingerprint} value=${fp} />`)}<label class="check"><input type="checkbox" class="s-ui-toggle" checked=${caChecked} onChange=${e => setCaChecked(e.target.checked)} />${hs("caConfirm")}</label></div>` : null}
        ${caError ? html`<p class="err" role="alert">${hs("caInvalid")}</p>` : null}
        <details class="s-ui-disclosure"><summary>${hs("advanced")}</summary><div class="s-disclosure-body form">${field("loginAttribute", { required: false, max: 64 })}${field("userFilter", { required: false, max: 4096 })}${field("timeoutMs", { type: "number", min: 500, maxNumber: 30000 })}</div></details>` : null}
      ${step === 3 ? html`${field("administratorLogin", { max: 256, hint: "adminHint" })}<div class="grid2">${field("contentDays", { type: "number", min: 1, maxNumber: 3650 })}${field("eventDays", { type: "number", min: 1, maxNumber: 3650 })}</div>` : null}
      ${step === 4 && review ? html`<p class="note">${hs("tested")}</p><div class="form">${[
          ["name", form.name.trim() || "AgEnD Hub"], ["webOrigin", review.webOrigin], ["memberOrigin", review.memberOrigin],
          ["webHost", form.webHost + ":" + form.webPort], ["memberHost", form.memberHost + ":" + form.memberPort],
          ["coexistence", hs(form.coexistence === "dedicated" ? "dedicated" : "shared")], ["administratorLogin", review.administrator],
          ["browserFingerprint", review.certificate.fingerprint], ["validTo", review.certificate.validTo], ["contentDays", form.contentDays], ["eventDays", form.eventDays]
        ].map(([key, value]) => html`<div class="kv"><span class="k">${hs(key)}</span><span class="v mono">${key === "browserFingerprint" ? html`<${Fingerprint} value=${value} />` : value}</span></div>`)}</div>
        <details class="s-ui-disclosure" open><summary>${hs("directory")}</summary><div class="s-disclosure-body form">${[
          ["url", directoryEndpoint(form.url.trim())], ["realm", form.realm.trim()], ["profile", hs(form.profile)], ["baseDn", form.baseDn.trim()], ["bindDn", form.bindDn.trim()],
          ["bindPassword", hs("provided")], ...(form.loginAttribute.trim() ? [["loginAttribute", form.loginAttribute.trim()]] : []),
          ...(form.userFilter.trim() ? [["userFilter", form.userFilter.trim()]] : []), ["timeoutMs", form.timeoutMs]
        ].map(([key, value]) => html`<div class="kv"><span class="k">${hs(key)}</span><span class="v mono">${value}</span></div>`)}
        <div class="kv"><span class="k">${hs("ca")}</span><span class="v">${form.ca === "system" ? hs("system") : html`<span>${fingerprints.map(fp => html`<${Fingerprint} value=${fp} />`)}</span>`}</span></div>
        </div></details>
        <p class="note">${hs("expires")}: ${new Date(review.expiresAt).toLocaleString()}</p><p class="note">${hs("reviewHint")}</p>` : null}
      <div class="s-row">
        ${step > 1 ? html`<button class="btn" type="button" onClick=${() => { clearDraft(); setFailureCode(""); setStep(step === 4 ? (form.certificate === "import" ? 1 : 2) : step - 1); }}>${hs("back")}</button>` : null}
        ${step < 4 ? html`<button class="btn btn-primary" type="submit">${hs(step === 3 ? "test" : "next")}</button>` : html`<button class="btn btn-primary" type="button" disabled=${!review} onClick=${commit}>${hs("create")}</button>`}
        <button class="btn btn-ghost" type="button" onClick=${cancel}>${hs("cancel")}</button>
      </div></fieldset></form>${busy ? html`<p class="note" role="status">${hs(step === 4 ? "creating" : "testing")}</p>` : null}` : null}
  </section>`;
}
