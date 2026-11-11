/**
 * Hub UX U2 (spec 1.2 / 2.6): the administrator's 「讓同仁加入」 card — three steps, each done from server state.
 * This module so far holds step 3 and the join-code slot that B2 (Ridge) mounts into; steps 1–2 follow in this PR.
 *
 * Slot contract (agreed with Ridge, hub-b2-mount-contract / hub-b2-create-gate):
 *   <div id="hubEnrolmentCodeSlot"> mounts `HubEnrolmentCode` from ./hub-enrolment-code.js, lazily, only when the session
 *   advertises "enrolment-code-v1" (an implementation capability, independent of the on/off switch) and the module exports
 *   `enrolmentCodeV1 === true`. A missing module, a failed import or a missing flag leaves the slot empty (upgrade skew).
 *   Props: { client, enabled, host, onChanged } — `enabled` = step 1 done (code creation needs only company join on; a live
 *   code then satisfies step 2), `host` = the display host of step 3's sentence, `onChanged()` after create/revoke so this
 *   card reads its steps again. Revoking stays the component's own (it lists retained codes even with creation off).
 */
import { html, useEffect, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { hubClient } from "./hub-client.js";
export const joinStepsV1 = true;
register("hubJoinSteps", {
  en: {
    step3: "Tell colleagues how to join", sentence: "In AgEnD, open Settings → Hub, enter {0}, then sign in with the company account.",
    copy: "Copy these instructions", copied: "Copied", copyFailed: "Copy failed. Select the sentence and copy it.",
    step3Off: "Finish steps 1 and 2 first.",
  },
  "zh-TW": {
    step3: "告訴同仁怎麼加入", sentence: "在 AgEnD 的「設定 → Hub」輸入 {0}，再用公司帳號登入。",
    copy: "複製這段說明", copied: "已複製", copyFailed: "複製失敗。請選取這段說明再複製。",
    step3Off: "請先完成步驟 1 和 2。",
  },
});
const sw = (key, ...args) => t(`hubJoinSteps.${key}`, ...args);
/** The web origin as people see it (spec 1.2): no https://, no :443. */
export function displayHost(webOrigin) {
  try { const u = new URL(String(webOrigin || "")); return u.protocol === "https:" ? u.host.replace(/:443$/, "") : ""; } catch { return ""; }
}
/** B2's join-code component in its slot, or nothing (see the contract above). */
// B2 ships the module; until then (and on a Hub that does not serve it) the import fails and the slot stays empty.
const CODE_MODULE = "./hub-enrolment-code.js";
const loadCode = () => import(/* @vite-ignore */ CODE_MODULE);
export function EnrolmentCodeSlot({ features = [], client = hubClient(), enabled = false, host = "", onChanged, load = loadCode } = {}) {
  const offered = Array.isArray(features) && features.includes("enrolment-code-v1");
  const [Code, setCode] = useState(null);
  useEffect(() => {
    let live = true;
    if (offered) Promise.resolve().then(load).then(m => { if (live && m && m.enrolmentCodeV1 === true && typeof m.HubEnrolmentCode === "function") setCode(() => m.HubEnrolmentCode); }, () => {});
    return () => { live = false; };
  }, [offered]);
  return html`<div id="hubEnrolmentCodeSlot">${offered && Code ? html`<${Code} client=${client} enabled=${enabled} host=${host} onChanged=${onChanged} />` : null}</div>`;
}
/** Step 3: the one sentence colleagues need, its copy button (only once steps 1 and 2 are done), and the join-code slot. */
export function JoinStep3({ webOrigin, step1 = false, step2 = false, features = [], client = hubClient(), onChanged, load } = {}) {
  const host = displayHost(webOrigin), ready = step1 && step2 && !!host, [copied, setCopied] = useState(null);
  const copy = async () => { try { await navigator.clipboard.writeText(sw("sentence", host)); setCopied("copied"); } catch { setCopied("copyFailed"); } };
  return html`<li class=${ready ? "now" : ""} data-step="3"><div class="hub-step-body"><span><b>${sw("step3")}</b>
      ${ready ? html`<small class="note hub-join-sentence">${sw("sentence", host)}</small>` : html`<small class="note" id="hubJoinStep3Off">${sw("step3Off")}</small>`}</span>
    <button type="button" class="btn btn-sm" disabled=${!ready} aria-describedby=${ready ? undefined : "hubJoinStep3Off"} onClick=${copy}>${copied === "copied" ? sw("copied") : sw("copy")}</button>
    ${copied === "copyFailed" ? html`<p class="note" role="alert">${sw("copyFailed")}</p>` : null}
    <${EnrolmentCodeSlot} features=${features} client=${client} enabled=${step1} host=${host} onChanged=${onChanged} ...${load ? { load } : {}} />
  </div></li>`;
}
