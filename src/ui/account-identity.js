import { register, t } from "/assets/app-i18n.js";

/**
 * Which account is a sign-in? A masked e-mail and a plan, as the AgEnD host or a Windows Runtime reported them; nothing else is shown and nothing
 * is ever unmasked here. Strings are registered by this module itself (not a shell-held strings file), so a browser tab that holds an older
 * copy of another module never renders a raw key; and an old server that does not send an identity simply shows nothing.
 */
register("accountIdentity", {
  en: { sep: " · ", unknownPlan: "Unknown plan", apiKey: "No account email (API key)" },
  "zh-TW": { sep: " · ", unknownPlan: "未知方案", apiKey: "沒有帳號 email（API key）" },
});
const text = key => t(`accountIdentity.${key}`);
/** The same contract as MASKED_EMAIL in src/claude-auth-status.ts (a test pins them equal); a value that does not match is not displayed. */
export const MASKED_EMAIL = /^[A-Za-z0-9._%+-]{1,2}\*\*\*@(?=.{1,253}$)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
/** Plan names are product names: shown as they are, not translated. Anything not listed (including `unknown`) is the generic label. */
const PLAN_NAMES = new Map([["free", "Free"], ["pro", "Pro"], ["max", "Max"], ["team", "Team"], ["enterprise", "Enterprise"]]);

/** The parts to show, in order: `[ab***@example.com, Team]`, `[No account email (API key)]`, or `[]` when nothing usable was reported. */
export function identityParts(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return [];
  if (identity.apiKey === true) return [text("apiKey")];
  const parts = [];
  if (typeof identity.maskedEmail === "string" && identity.maskedEmail.length <= 260 && MASKED_EMAIL.test(identity.maskedEmail)) parts.push(identity.maskedEmail);
  if (typeof identity.plan === "string") parts.push(PLAN_NAMES.get(identity.plan) ?? text("unknownPlan"));
  return parts;
}
export const identityText = identity => identityParts(identity).join(text("sep"));
