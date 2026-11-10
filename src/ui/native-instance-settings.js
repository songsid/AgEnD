// Windows uses the same staged instance settings flow, with its runtime's supported fields.
// AGEND-161: the form is a hook (useNativeForm) and its fields are grouped by category (NativeFields), so the Settings dialog
// and the Details & settings page (agent-details-settings.js) draw the same fields, each with its ⓘ.
import { html, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { Dialog } from "/assets/ui-dialog.js";
import { ChipList, ModelSelect } from "./settings-dialogs.js";
import { InfoTip } from "./settings-shared.js";
import { useWindowsCliCatalog } from "./windows-cli-catalog.js";
import { useRuntimeCatalog, instanceMachineId } from "./runtime-catalog.js";
import { NativeAgendToolsHint, tr } from "./agent-runtime.js";
import {AgentRuntimeSettings} from "./agent-runtime-settings.js";
import "./agent-page-strings.js";
import { pt } from "./agent-page-strings.js";
const tn = key => t(`settings.${key}`);
/** The categories a Windows native agent has (it has no channel binding, tool sets or idle settings: the page shows only these). */
export const NATIVE_CATEGORIES = ["basic", "runtime", "work", "adv"];
const Lab = ({ id, text, tip }) => html`<div class="s-lab"><label for=${id}>${text}</label><${InfoTip} text=${tip} name=${text} /></div>`;
const Card = ({ title, span, children }) => html`<section class=${`card${span ? " ap-span2" : ""}`}><h3>${title}</h3>${children}</section>`;

export function useNativeForm({ name, inst, ctx }) {
  const machineId = instanceMachineId(inst);
  const catalog = useWindowsCliCatalog(!machineId), machines = useRuntimeCatalog(!!machineId);
  const machine = machines.data?.machines?.find(item => item.id === machineId);
  const native = (machineId ? machine?.inventory : catalog.data)?.clis?.find(cli => cli.id === inst.backend);
  const [form,setForm] = useState(() => ({display_name:inst.display_name || name,description:inst.description || "",model:inst.model || "",systemPrompt:inst.systemPrompt || "",native_sandbox:inst.native_sandbox || "read-only",tags:Array.isArray(inst.tags) ? [...inst.tags] : []}));
  const set = key => value => setForm(current => ({...current,[key]:value}));
  const dirty=Object.entries(form).some(([key,value])=>JSON.stringify(typeof value==="string"?value.trim():value)!==JSON.stringify(key==="display_name"?inst.display_name||name:key==="native_sandbox"?inst.native_sandbox||"read-only":key==="tags"?inst.tags||[]:inst[key]||""));
  const ready = !!form.display_name.trim() && !(form.native_sandbox === "read-only" && native?.readOnlySupport === false);
  const pending = () => {
    const patch = {};
    for (const [key,value] of Object.entries(form)) {
      const before = key === "display_name" ? inst.display_name || name : key === "native_sandbox" ? inst.native_sandbox || "read-only" : key === "tags" ? inst.tags || [] : inst[key] || "";
      const next = typeof value === "string" ? value.trim() : value;
      if (JSON.stringify(next) !== JSON.stringify(before)) patch[key] = next;
    }
    return patch;
  };
  const stage = done => {
    if (!ready) return;
    const patch = pending();
    if (Object.keys(patch).length) ctx.stageAgent(name,inst,patch);
    if (done) done();
  };
  return { name, inst, ctx, form, set, dirty, ready, native, machine, machines, machineId, pending, stage };
}

export function NativeFields({ m, cat }) {
  const { name, inst, ctx, form, set, dirty, ready, native, machine, machines, machineId } = m;
  if (cat === "basic") return html`<div class="ap-grid"><${Card} title=${pt("cardName")} span=${true}>
      <div class="grid2">
        <div class="field"><${Lab} id="ni-dn" text=${tn("displayName")} tip=${pt("tip_displayName")} /><input id="ni-dn" value=${form.display_name} maxLength=${64} onInput=${event => set("display_name")(event.target.value)} /></div>
        <div class="field"><${Lab} id="ni-tags" text=${tn("tags")} tip=${pt("tip_tags")} /><${ChipList} items=${form.tags} onChange=${set("tags")} placeholder=${tn("tagPlaceholder")} label=${tn("tags")} /></div>
      </div>
      <div class="field"><${Lab} id="ni-desc" text=${tn("description")} tip=${pt("tip_description")} /><input id="ni-desc" value=${form.description} maxLength=${512} onInput=${event => set("description")(event.target.value)} /><p class="note">${pt("note_description")}</p></div></${Card}></div>`;
  if (cat === "runtime") return html`<div class="ap-grid">
    <${Card} title=${pt("cardRuntime")}><${AgentRuntimeSettings} name=${name} inst=${{...inst,machine_name:machine?.name||inst.machine_name,machine_status:machine?.status||inst.machine_status,machine_missing:!!machineId&&!!machines.data&&machines.data.enabled!==false&&!machine}} disabled=${dirty||ctx.staged?.size>0} onChanged=${()=>{ctx.reload();if(m.onChanged)m.onChanged();}}/></${Card}>
    <${Card} title=${pt("cardModel")}><div class="field"><${Lab} id="native-instance-model" text=${tn("model")} tip=${pt("tip_model")} /><${ModelSelect} id="native-instance-model" value=${form.model} onChange=${set("model")} backend=${inst.backend} instance=${name} runtime="windows" machineId=${machineId} inherit=${tr("model")} /></div></${Card}></div>`;
  if (cat === "work") return html`<div class="ap-grid"><${Card} title=${pt("cardWorkspace")} span=${true}>
      <div class="field"><${Lab} id="ni-wd" text=${tn("workingDir")} tip=${pt("tip_workdirNative")} /><input id="ni-wd" value=${inst.working_directory || ""} readOnly=${true} aria-readonly="true" /><small>${t("nativeInstance.workspace")}</small></div>
      <div class="field"><${Lab} id="ni-sb" text=${tr("access")} tip=${pt("tip_sandbox")} /><select id="ni-sb" value=${form.native_sandbox} onChange=${event => set("native_sandbox")(event.target.value)}><option value="read-only" disabled=${native?.readOnlySupport === false}>${tr("read")}</option><option value="workspace-write">${tr("write")}</option></select></div>
      <${NativeAgendToolsHint} cli=${native} sandbox=${form.native_sandbox} />
      ${!ready && form.native_sandbox === "read-only" && native?.readOnlySupport === false ? html`<p class="note">${tr("noReadOnly")}</p>` : null}
      <p class="s-info"><span aria-hidden="true">ⓘ</span><span>${pt("nativeLimits")}</span></p></${Card}></div>`;
  return html`<div class="ap-grid"><${Card} title=${pt("cardSystemPrompt")} span=${true}>
      <div class="field"><${Lab} id="ni-sys" text=${tn("systemPrompt")} tip=${pt("tip_systemPromptNative")} /><textarea id="ni-sys" rows="5" maxLength=${8000} value=${form.systemPrompt} onInput=${event => set("systemPrompt")(event.target.value)} /></div>
      <p class="note">${pt("note_systemPrompt")}</p></${Card}></div>`;
}

export function NativeInstanceSettings({ name, inst, ctx, onClose }) {
  const m = useNativeForm({ name, inst, ctx });
  m.onChanged = onClose;
  const stage = () => m.stage(onClose);
  return html`<${Dialog} title=${ctx.shortName(name,inst)} onClose=${onClose} wide=${true} drawer=${true} actions=${html`<button type="button" class="btn" onClick=${onClose}>${tn("cancel")}</button><button type="button" class="btn btn-primary" disabled=${!m.ready} onClick=${stage}>${tn("modalDone")}</button>`}>
    <div class="form native-instance-settings">${NATIVE_CATEGORIES.map(cat => html`<${NativeFields} key=${cat} m=${m} cat=${cat} />`)}</div>
  </${Dialog}>`;
}
