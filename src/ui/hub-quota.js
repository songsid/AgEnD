// #3226 G (quota band, Cairn): the representative agent's subscription quota in the Hub chat — the right-hand panel's
// card, the chat header's chip and the banner while it is used up — and the owner's switch on My shared agents. B ships
// this module empty (nothing drawn: no quota is known yet); G fills these four exports and nothing else in the panel.
/** The panel's second card (between the agent and its access). */
export function QuotaCard() { return null; }
/** The header's tag when the band is not "available"; `fallback` (the plain "Can ask" tag) otherwise. */
export function QuotaChip({ fallback = null } = {}) { return fallback; }
/** Above the composer while the quota is used up (the composer stays on: questions queue). */
export function QuotaBanner() { return null; }
/** On the owner's agent page: whether askers see the band. */
export function QuotaVisibilityRow() { return null; }
