// Display only: an app's registered name never establishes a vendor identity or room membership.
import { html, render } from "/assets/app-html.js";
import { Icon } from "/assets/ui-icons.js";
import { toast } from "/assets/ui-toast.js";
import { hsource } from "./hub-room-source-strings.js";

export function roomSource(author) {
  if (!author) return null;
  if (author.via?.kind === "app") return { kind: "app", label: hsource("app", String(author.name || ""), String(author.via.name || "")) };
  const agent = author.kind === "agent" || author.kind === "later";
  if (!agent && author.via?.kind !== "agent") return null;
  const owner = agent ? author.owner?.name : author.name;
  const label = owner && author.agentKind ? hsource(author.agentKind === "personal" ? "personal" : "fleet", String(owner)) : hsource("agend");
  return { kind: "agend", label };
}

export function RoomSourceMark({ source, decorative = false }) {
  if (!source) return null;
  return html`<span class="hub-source-mark" data-room-source=${source.kind} role=${decorative ? undefined : "img"}
    aria-hidden=${decorative ? "true" : undefined} aria-label=${decorative ? undefined : source.label} title=${source.label}>
    ${source.kind === "agend" ? html`<img src="/assets/agend-mark.svg" width="16" height="16" alt="" aria-hidden="true" />` : html`<${Icon} name="view" size=${16} />`}
  </span>`;
}

/** Stateless island inside the shared thread's sender node. No raw markup comes from the message. */
export function mountSourceAuthor(sender, message) {
  const source = message?.sourceBadge;
  if (!sender || !source) return;
  sender.textContent = "";
  render(html`<button type="button" class="hub-source-trigger" title=${source.label}
    aria-label=${`${message.sender}. ${source.label}`} onClick=${() => toast(source.label, true, { detail: true })}>
    <${RoomSourceMark} source=${source} decorative=${true} /><span>${message.sender}</span>
  </button>`, sender);
}
