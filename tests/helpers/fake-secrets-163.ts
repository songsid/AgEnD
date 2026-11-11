/**
 * AGEND-163: secret-shaped strings for the export's secret scan, put together at run time so that no committed line is itself
 * key-shaped (the repository's gitleaks scan reads the text of every commit). None is a credential: every one is filler characters.
 */
const r = (c: string, n: number): string => c.repeat(n);
export const fake = {
  anthropicKey: () => `s${"k-"}${r("a", 24)}`,
  githubToken: () => `gh${"p_"}${r("x", 36)}`,
  stripeKey: () => `r${"k_"}${"live_"}${r("a", 24)}`,
  hfToken: () => `h${"f_"}${r("a", 34)}`,
  privateKeyHeader: () => `-----BEGIN ${"RSA PRIVATE"} KEY-----`,
  telegramToken: () => `${r("1", 9)}:${r("A", 35)}`,
  jwt: () => ["ey" + "J" + r("a", 12), "ey" + "J" + r("b", 12), r("c", 20)].join("."),
  bearer: () => `Authorization: Bearer ${r("a", 32)}`,
  assignment: () => `api${"_"}key = ${r("Z", 20)}`,
  urlPassword: () => `postgres:${"//"}admin:${r("p", 8)}@db.local/x`,
  labelledToken: () => `tok${"en"}: ${r("a", 30)}`,
  discordToken: () => `M${r("T", 23)}.${r("C", 6)}.${r("Z", 27)}`,
  discordWebhook: () => `https:${"//"}discord.com/api/webhooks/${r("1", 18)}/${r("a", 40)}`,
  slackAppToken: () => `xa${"pp-"}1-${r("A", 12)}-${r("1", 12)}`,
  slackWebhook: () => `https:${"//"}hooks.slack.com/services/T${r("0", 8)}/B${r("0", 8)}/${r("a", 24)}`,
};
