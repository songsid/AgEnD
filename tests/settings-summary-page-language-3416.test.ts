import { afterEach, expect, it, vi } from "vitest";
import { settingsChangeDiff } from "../src/settings-change.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { settingsFingerprint } from "../src/settings-transaction.js";
import { getLocale, setLocale } from "../src/locale.js";
import { SettingsControlServer } from "../src/settings-control.js";
const original = getLocale();
afterEach(() => setLocale(original));

it("carries display descriptors without changing the canonical diff or rendered chat summary", () => {
  setLocale("en");
  const operation = "PUT /api/settings/secrets/example/apply", secret = { key: "EXAMPLE_SECRET", before: "dummy-old", after: "dummy-next" };
  const diff: any = settingsChangeDiff(null, null, { operation, secret });
  expect(diff.fingerprint).toBe(settingsFingerprint([operation, null, null, secret]));
  expect(diff.summary[1]).toMatch(/^EXAMPLE\\_SECRET: fingerprint [a-f0-9]{12} → [a-f0-9]{12}$/);
  expect(diff.summary_i18n?.[1]).toMatchObject({ v: 1, fallback: diff.summary[1] });
  expect(diff.summary_i18n[1].parts).toContainEqual({ key: "settings_confirm.summary.fingerprint", args: [] });
  expect(JSON.stringify(diff)).not.toContain("dummy-old"); expect(JSON.stringify(diff)).not.toContain("dummy-next");
});

it.each([
  [["fleet", "access", "allowed_users"], "fleetAdmin"], [["classic", "channels", "room", "admin_users"], "classicAdmin"],
  [["classic", "channels", "room", "allowed_users"], "user"], [["access", "allowed_groups"], "group"], [["access", "allowed_guilds"], "guild"],
] as const)("keeps the exact identity and role for %j", (path, role) => {
  const wrap = (ids: string[]) => path.reduceRight<unknown>((value, key) => ({ [key]: value }), ids);
  const diff: any = settingsChangeDiff(wrap([]), wrap(["42"]), { operation: "PATCH access" });
  expect(diff.summary_i18n[1].fallback).toBe(diff.summary[1]);
  expect(diff.summary_i18n[1].parts).toContainEqual({ key: `settings_confirm.summary.role.${role}`, args: [] });
  expect(diff.summary_i18n[1].parts.join(" ")).toContain("42");
});

it("freezes display metadata at proposal and in each read, outside audit and execution authority", async () => {
  const summary = ["key: fingerprint absent → abcdef"], metadata = [{ v: 1, fallback: summary[0], parts: ["key: ", { key: "settings_confirm.summary.fingerprint", args: [] }, " absent → abcdef"] }];
  const apply = vi.fn(async () => ({ ok: true })), audit = vi.fn(), store = new SettingsConfirmationStore({ audit });
  try {
    const proposal: any = { session: "s", key: "k", fingerprint: "canonical", section: "secret", requestedBy: "operator", source: "web_session", summary, summary_i18n: metadata, bytes: 1,
      current: () => true, unchanged: async () => true, apply };
    const view: any = store.propose(proposal).view;
    expect(view.summary_i18n).toEqual(metadata); expect(apply).not.toHaveBeenCalled();
    const control = new SettingsControlServer("unused-without-listen", store, () => true);
    const ticket = (control as any).inspect(view.id).ticket;
    expect(ticket).toMatchObject({ fingerprint: "canonical", summary_fingerprint: settingsFingerprint(summary) });
    (metadata[0].parts[1] as any).key = "foreign"; view.summary_i18n[0].parts[0] = "changed";
    const fresh: any = store.get(view.id, "s");
    expect(fresh.summary).toEqual(summary); expect(fresh.summary_i18n[0].parts[0]).toBe("key: ");
    expect(fresh.summary_i18n[0].parts[1].key).toBe("settings_confirm.summary.fingerprint");
    expect((control as any).inspect(view.id).ticket).toEqual(ticket);
    expect(JSON.stringify(audit.mock.calls)).not.toContain("summary_i18n");
    expect((await store.decide(view.id, "confirm", { label: "admin", current: () => true })).state).toBe("applied");
    expect(apply).toHaveBeenCalledOnce();
  } finally { store.close(); }
});
