// M-3710 (R21079937, 11-25: a pending contact request was in no list, not even on this computer). Needs you's line for an
// admin session with no verified person behind it: how many requests wait (the server sends the count only —
// reason "contact_verify_needed", contactVerify { count }; never which, who or what), and this browser's own
// "Authorize this browser" (web-authorize.js: the button, or why it can't be authorized here and where to fix that).
// Once the account confirms, the server sends Needs you again and the requests themselves replace this line.
// A module of its own, with its own words (#4447 review): a page still holding an older contact-needs.js or
// contact-auth-strings.js keeps working and says these words, never their keys.
import { html } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import { AuthorizeChip } from "/assets/web-authorize.js";

register("contactVerifyNeed", {
  en: {
    one: "1 contact request needs a verified browser", many: "{0} contact requests need a verified browser",
    body: "Authorize this browser to see who is asking, and to approve or decline.",
  },
  "zh-TW": {
    one: "有 1 個聯絡申請需要已驗證的瀏覽器", many: "有 {0} 個聯絡申請需要已驗證的瀏覽器",
    body: "授權這個瀏覽器後，才能看到是誰提出，並核准或拒絕。",
  },
});
const tv = (k, ...a) => t(`contactVerifyNeed.${k}`, ...a);
/** The line's title for `count` waiting requests (at least 1). */
export const verifyNeedTitle = (count) => (count === 1 ? tv("one") : tv("many", count));
export const verifyNeedBody = () => tv("body");

/** A Needs you item that says contact requests wait for a verified browser. */
export const isContactVerify = (item) => item?.type === "contact" && item.reason === "contact_verify_needed";
/** How many requests the line stands for: what Needs you's counts add for it (#4447 capture check). */
export const contactVerifyCount = (item) => Math.max(1, Math.floor(Number(item?.contactVerify?.count) || 1));

export function ContactVerifyNeed({ item }) {
  const count = contactVerifyCount(item);
  const title = verifyNeedTitle(count);
  return html`<section class="n-group n-contact-verify" aria-label=${title}>
    <article data-trust="permission" class="n-item contact-need contact-verify-need" data-reason="contact_verify_needed">
      <span class="n-icon"><${Icon} name="key" size=${18} /></span>
      <div class="n-body">
        <div class="n-title"><strong>${title}</strong></div>
        <p class="n-detail">${verifyNeedBody()}</p>
        <${AuthorizeChip} />
      </div>
    </article>
  </section>`;
}
