// M-3710 (R21079937, 11-25: a pending contact request was in no list, not even on this computer). Needs you's line for an
// admin session with no verified person behind it: how many requests wait (the server sends the count only —
// reason "contact_verify_needed", contactVerify { count }; never which, who or what), and this browser's own
// "Authorize this browser" (web-authorize.js: the button, or why it can't be authorized here and where to fix that).
// Once the account confirms, the server sends Needs you again and the requests themselves replace this line.
// A module of its own: a page still holding an older contact-needs.js keeps working (new exports go in a new module).
import { html } from "/assets/app-html.js";
import { Icon } from "/assets/ui-icons.js";
import { AuthorizeChip } from "/assets/web-authorize.js";
import { ca } from "./contact-auth-strings.js";

/** A Needs you item that says contact requests wait for a verified browser. */
export const isContactVerify = (item) => item?.type === "contact" && item.reason === "contact_verify_needed";

export function ContactVerifyNeed({ item }) {
  const count = Math.max(1, Math.floor(Number(item?.contactVerify?.count) || 1));
  const title = count === 1 ? ca("verifyNeedOne") : ca("verifyNeedMany", count);
  return html`<section class="n-group n-contact-verify" aria-label=${title}>
    <article data-trust="permission" class="n-item contact-need contact-verify-need" data-reason="contact_verify_needed">
      <span class="n-icon"><${Icon} name="key" size=${18} /></span>
      <div class="n-body">
        <div class="n-title"><strong>${title}</strong></div>
        <p class="n-detail">${ca("verifyNeedBody")}</p>
        <${AuthorizeChip} />
      </div>
    </article>
  </section>`;
}
