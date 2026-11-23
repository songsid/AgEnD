// New main task (Fleet › Tasks), quick: a title is enough. Project, assignee and priority are chips under it, all
// optional; the rest of the fields (goal, scope, definition of done, context, size, whether it stops for the person's
// confirmation) are under "More options" and can as well be filled in on the card after it is made. Enter in the title
// or Ctrl+Enter anywhere creates it. The request is the board's own (`boardApi.create`), unchanged.
// No style attribute anywhere (the CSP).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { Dialog } from "/assets/ui-dialog.js";
import { toast } from "/assets/ui-toast.js";
import { AssigneeOption, boardApi, errorText } from "./fleet-task-common.js";

/** What a new main task is created with: the chosen values, empty ones left out or null as the board takes them. */
export function createSpec(f) {
  return {
    kind: "main", project: f.project === "" ? null : Number(f.project), title: f.title.trim(), goal: f.goal, scope: f.scope,
    acceptance: f.acceptance.split("\n").map((l) => l.trim()).filter(Boolean), context: f.context,
    size: f.size || null, priority: f.priority, assignee: f.assignee.trim() || null, needsReview: f.needsReview,
  };
}

export function CreateMainDialog({ projects, project, boardOff = [], onClose, onCreated }) {
  const { instances } = useStore(appStore);
  const active = projects.filter((p) => !p.archived);
  const [f, setF] = useState({ project: project === null || project === undefined ? "" : String(project), title: "", goal: "", scope: "", acceptance: "", context: "", size: "", priority: "normal", assignee: "", needsReview: true });
  const [busy, setBusy] = useState(false);
  const titleBox = useRef(null);
  // After the dialog has opened (its own focus goes to the box, then the title takes it).
  useEffect(() => { if (titleBox.current) titleBox.current.focus(); }, []);
  const set = (k) => (e) => { const v = e.target.type === "checkbox" ? e.target.checked : e.target.value; setF((cur) => ({ ...cur, [k]: v })); };
  async function submit() {
    if (busy) return;
    if (!f.title.trim()) { toast(t("tasks.titleRequired"), false); return; }
    setBusy(true);
    try {
      const { card } = await boardApi.create(createSpec(f));
      toast(t("tasks.created", card.id));
      onCreated(card.id);
    } catch (err) { toast(errorText(err), false); setBusy(false); }
  }
  const field = (label, input) => html`<label class="field"><span>${label}</span>${input}</label>`;
  const chip = (label, input) => html`<label class="tb-qc-chip"><span>${label}</span>${input}</label>`;
  const onKey = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } };
  return html`<${Dialog} title=${t("tasks.createMain")} onClose=${onClose} busy=${busy} wide
    actions=${html`<button type="button" class="btn" onClick=${onClose} disabled=${busy}>${t("tasks.cancel")}</button>
      <button type="button" class="btn btn-primary" onClick=${submit} disabled=${busy || !f.title.trim()}>${t("tasks.create")}</button>`}>
    <form class="form tb-qc" onSubmit=${(e) => { e.preventDefault(); void submit(); }} onKeyDown=${onKey}><fieldset class="form" disabled=${busy}>
      <input class="tb-qc-title" ref=${titleBox} value=${f.title} maxlength="100" placeholder=${t("tasks.titleHint")} aria-label=${t("tasks.title")} onInput=${set("title")} required />
      <p class="note tb-qc-hint">${t("tasks.quickHint")}</p>
      <div class="tb-qc-chips" role="group" aria-label=${t("tasks.createMore")}>
        ${chip(t("tasks.project"), html`<select value=${f.project} onChange=${set("project")}><option value="">${t("tasks.noProject")}</option>${active.map((p) => html`<option key=${p.id} value=${String(p.id)}>${p.name}</option>`)}</select>`)}
        ${chip(t("tasks.assignee"), html`<select value=${f.assignee} onChange=${set("assignee")}><option value="">${t("tasks.nobody")}</option>${instances.map((i) => html`<${AssigneeOption} key=${i.name} name=${i.name} boardOff=${boardOff} />`)}</select>`)}
        ${chip(t("tasks.priority"), html`<select value=${f.priority} onChange=${set("priority")}>${["urgent", "high", "normal", "low"].map((p) => html`<option key=${p} value=${p}>${t(`tasks.${p}`)}</option>`)}</select>`)}
      </div>
      <details class="tb-qc-more">
        <summary>${t("tasks.moreOptions")}</summary>
        ${field(t("tasks.goal"), html`<textarea rows="2" maxlength="300" placeholder=${t("tasks.goalHint")} value=${f.goal} onInput=${set("goal")}></textarea>`)}
        ${field(t("tasks.scope"), html`<textarea rows="2" maxlength="600" placeholder=${t("tasks.scopeHint")} value=${f.scope} onInput=${set("scope")}></textarea>`)}
        ${field(t("tasks.definition"), html`<textarea rows="3" placeholder=${t("tasks.definitionHint")} value=${f.acceptance} onInput=${set("acceptance")}></textarea>`)}
        ${field(t("tasks.context"), html`<textarea rows="2" maxlength="1000" placeholder=${t("tasks.contextHint")} value=${f.context} onInput=${set("context")}></textarea>`)}
        <div class="tb-form-row">
          ${field(t("tasks.size"), html`<select value=${f.size} onChange=${set("size")}><option value="">${t("tasks.sizeNone")}</option><option value="S">${t("tasks.sizeS")}</option><option value="M">${t("tasks.sizeM")}</option><option value="L">${t("tasks.sizeL")}</option></select>`)}
        </div>
        <label class="tb-check"><input type="checkbox" checked=${f.needsReview} onChange=${set("needsReview")} />${t("tasks.reviewBox")}</label>
      </details>
    </fieldset></form></${Dialog}>`;
}
