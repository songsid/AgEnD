/**
 * Hub UX U3 (spec 1.4): the vocabulary rules the gate applies (tests/hub-u3-vocabulary-gate-2933.test.ts), in one place so other
 * checks (the A-L15 rendered-text pass) use exactly the same ones.
 */
import { readdirSync } from "node:fs";
import type { UiString } from "./ui-dictionaries.js";

export const MODULES = ["hub-strings.js", "hub-company-join-strings.js", "hub-quick-strings.js", "hub-owner-strings.js", "hub-group-strings.js", "hub-chat-strings.js",
  "hub-grant-strings.js", "hub-pairing-progress-strings.js", "hub-read-strings.js", "settings-hub-setup-strings.js",
  "settings-hub-connection.js", "settings-hub-membership.js", "settings-hub-company-join.js",
  // U1 / U2's own dictionaries (written after the spec's list).
  "hub-join-one-strings.js", "hub-join-steps.js", "hub-group-search.js"].map((f) => `src/ui/${f}`);
/** Everything else on the Hub's and Fleet-Hub's screens (A-L15 found words there too): every hub-* and settings-hub* module. */
export const ALL = [...new Set([...MODULES, ...readdirSync("src/ui").filter((f) => /^(hub-|settings-hub).*\.js$/.test(f)).map((f) => `src/ui/${f}`)])];

/** The pairing-code path's own keys: 配對 / pair may appear here (and only the "pair" class of terms is excused). */
export const PAIRING_CODE_KEYS = new Set([
  "hub.pairingsTitle", "hub.pairTitle", "hub.pendingPairings", "hub.pairingFp",
  "hubQuick.ownerStep", "hubQuick.mismatchStop", "hubQuick.stop", "hubQuick.stopped", "hubQuick.unavailable", "hubQuick.limit", "hubQuick.expired",
  "hubOwner.pairSteps", "hubOwner.pendingPairings",
  "hubPairingProgress.connectFailed", "hubPairingProgress.notApplied", "hubPairingProgress.unknown",
  "pendingSummary.hub.pairing.summary.confirm",             // the pairing-code path's fingerprint step, in the Settings confirmation
]);
/**
 * #3700 r1 (Fable): Hub words that live in shared modules — the Settings confirmation of a Hub change (app-shell's pendingSummary
 * hub.* keys, and the shell's own Hub namespaces) and the access overview's Hub row. Only these keys are the Hub's.
 */
export const SHARED: { file: string; hub: (s: UiString) => boolean }[] = [
  { file: "src/ui/shared/app-shell.js", hub: (s) => s.ns === "hubShell" || s.ns === "pendingHub" || s.ns === "pendingSummary" && s.key.startsWith("hub.") },
  { file: "src/ui/settings-access-overview.js", hub: (s) => s.ns === "accessov" && /^hub/.test(s.key) },
];
// Network links (not the Fleet–Hub relationship), and 公開連結 — the public-link feature's own name, not "publish".
const ZH_NETWORK = /網路連線|目錄連線|服務連線|測試連線|重新連線|連線中斷|AD 連線|離線|公開連結/g;
const ZH_ALWAYS = /手動配對碼|一次性配對碼|同仁連線連結|組織帳號|公開|連線/;
const EN_ALWAYS = /one-time pairing code|manual pairing code|\bexposures?\b|\bexpose[ds]?\b|organisation|\bHub admin\b(?!istrator)/i;

/** The banned terms in one string, as the gate sees them (empty: clean). */
export function offences(s: UiString): string[] {
  const pairOk = PAIRING_CODE_KEYS.has(`${s.ns}.${s.key}`);
  if (s.lang === "zh-TW") {
    const t = s.text.replace(ZH_NETWORK, ""), out: string[] = [];
    const always = t.match(new RegExp(ZH_ALWAYS.source, "g")) ?? []; out.push(...always);
    if (!pairOk && /配對(?!碼)/.test(t.replace(/手動配對碼|一次性配對碼/g, ""))) out.push("配對");
    return out;
  }
  if (s.lang === "en") {
    const out = (s.text.match(new RegExp(EN_ALWAYS.source, "gi")) ?? []).slice();
    const rest = s.text.replace(/(one-time |manual )?pairing codes?/gi, "");   // the legacy name (its banned forms were counted above)
    if (!pairOk && /\bpair(s|ed|ing)?\b/i.test(rest)) out.push("pair");
    return out;
  }
  return [];
}
