// Windows uses the same staged instance settings flow, with its runtime's supported fields.
import { html, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { Dialog } from "/assets/ui-dialog.js";
import { ChipList, ModelSelect } from "./settings-dialogs.js";
import { CliProductMark, cliLabel } from "./cli-picker.js";
import { useWindowsCliCatalog } from "./windows-cli-catalog.js";
import { NativeAgendToolsHint, tr } from "./agent-runtime.js";
register("nativeInstance", {
  "zh-TW": { fixed:"Runtime 與 CLI 隨此對話保留。", workspace:"此 Agent 的對話會沿用這個工作區。" },
  en: { fixed:"This conversation keeps its runtime and CLI.", workspace:"This agent's conversation keeps this workspace." },
});
const tn = key => t(`settings.${key}`);
export function NativeInstanceSettings({ name, inst, ctx, onClose }) {
  const catalog = useWindowsCliCatalog();
  const native = catalog.data?.clis?.find(cli => cli.id === inst.backend);
  const [form,setForm] = useState(() => ({display_name:inst.display_name || name,description:inst.description || "",model:inst.model || "",systemPrompt:inst.systemPrompt || "",native_sandbox:inst.native_sandbox || "read-only",tags:Array.isArray(inst.tags) ? [...inst.tags] : []}));
  const set = key => value => setForm(current => ({...current,[key]:value}));
  const ready = !!form.display_name.trim() && !(form.native_sandbox === "read-only" && native?.readOnlySupport === false);
  const stage = () => {
    if (!ready) return;
    const patch = {};
    for (const [key,value] of Object.entries(form)) {
      const before = key === "display_name" ? inst.display_name || name : key === "native_sandbox" ? inst.native_sandbox || "read-only" : key === "tags" ? inst.tags || [] : inst[key] || "";
      const next = typeof value === "string" ? value.trim() : value;
      if (JSON.stringify(next) !== JSON.stringify(before)) patch[key] = next;
    }
    if (Object.keys(patch).length) ctx.stageAgent(name,inst,patch);
    onClose();
  };
  return html`<${Dialog} title=${ctx.shortName(name,inst)} onClose=${onClose} wide=${true} actions=${html`<button type="button" class="btn" onClick=${onClose}>${tn("cancel")}</button><button type="button" class="btn btn-primary" disabled=${!ready} onClick=${stage}>${tn("modalDone")}</button>`}>
    <div class="form native-instance-settings"><p class="note"><${CliProductMark} id=${inst.backend} size=${20} /> Windows · ${cliLabel(inst.backend)} — ${t("nativeInstance.fixed")}</p>
      <label class="field"><span>${tn("displayName")}</span><input value=${form.display_name} maxLength=${64} onInput=${event => set("display_name")(event.target.value)} /></label>
      <label class="field"><span>${tn("description")}</span><input value=${form.description} maxLength=${512} onInput=${event => set("description")(event.target.value)} /></label>
      <div class="field"><label for="native-instance-model">${tn("model")}</label><${ModelSelect} id="native-instance-model" value=${form.model} onChange=${set("model")} backend=${inst.backend} instance=${name} runtime="windows" inherit=${tr("model")} /></div>
      <label class="field"><span>${tn("workingDir")}</span><input value=${inst.working_directory || ""} readOnly=${true} aria-readonly="true" /><small>${t("nativeInstance.workspace")}</small></label>
      <label class="field"><span>${tr("access")}</span><select value=${form.native_sandbox} onChange=${event => set("native_sandbox")(event.target.value)}><option value="read-only" disabled=${native?.readOnlySupport === false}>${tr("read")}</option><option value="workspace-write">${tr("write")}</option></select></label>
      <${NativeAgendToolsHint} cli=${native} sandbox=${form.native_sandbox} />
      ${!ready && form.native_sandbox === "read-only" && native?.readOnlySupport === false ? html`<p class="note">${tr("noReadOnly")}</p>` : null}
      <label class="field"><span>${tn("systemPrompt")}</span><textarea rows="5" maxLength=${8000} value=${form.systemPrompt} onInput=${event => set("systemPrompt")(event.target.value)} /></label>
      <div class="field"><span>${tn("tags")}</span><${ChipList} items=${form.tags} onChange=${set("tags")} placeholder=${tn("tagPlaceholder")} label=${tn("tags")} /></div>
    </div>
  </${Dialog}>`;
}
