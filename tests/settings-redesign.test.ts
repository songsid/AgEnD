import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../src/ui/settings.html", import.meta.url), "utf8");

describe("Settings P0 redesign shell", () => {
  it("keeps advanced settings one click away and the YAML escape hatch intact", () => {
    // Two levels now: what is shown, and one drawer per object. The global
    // "show advanced" mode is gone — a mode that hides settings is the thing
    // the redesign replaced, not a feature to keep.
    expect(html).not.toContain('id="advancedToggle"');
    expect(html).not.toContain("advanced-only");
    expect(html).toContain('class: "drawer"');
    expect(html).toContain('drawer(t("advancedSection")');
    // The escape hatch stays exactly where it was.
    expect(html).toContain("Developer · Level 3");
    expect(html).toContain("Developer YAML");
  });

  it("provides the global pending-change apply bar and human impact labels", () => {
    expect(html).toContain('id="pendingBar"');
    expect(html).toContain('id="applyChanges"');
    expect(html).toContain("changes not applied");
    expect(html).toContain("Restart this Agent");
    expect(html).toContain("Restart AgEnD");
  });

  it("stages tool-progress defaults and overrides, then requests a hot reload", () => {
    expect(html).toContain('select(inst.tool_progress ?? defaults.tool_progress ?? "off", ["off", "standard", "verbose"])');
    expect(html).toContain('select(d.tool_progress ?? "off", ["off", "standard", "verbose"])');
    expect(html).toContain('tool_progress: toolProgress.toggle.checked ? null : toolProgress.input.value');
    expect(html).toContain('tool_progress: fToolProgress.value');
    // The hot set lives in instance-config-impact.ts and arrives over
    // /api/settings/schema; the page classifies a staged edit with it.
    expect(html).toContain('const impactOf = (field) => state.schema.impacts[field] || "instance"');
    expect(html).toContain('impact: batchImpact(Object.keys(patch), key => impactOf(`instance.${key}`))');
    // Apply is a job now, not a signal: the page asks for one and watches it.
    expect(html).toContain('await api("/api/settings/apply"');
    expect(html).toContain('"Idempotency-Key": key');
    expect(html).toContain('await watchApplyJob(started.body)');
  });

  it("wires the reply completion guard at global, fleet-instance, and Classic levels", () => {
    expect(html).toContain('fReplyGuard.checked = d.reply_completion_guard ?? true');
    expect(html).toContain('reply_completion_guard: replyGuard.toggle.checked ? null : replyGuard.input.checked');
    expect(html).toContain('reply_completion_guard: fClassicReplyGuard.toggle.checked ? null : fClassicReplyGuard.input.checked');
    expect(html).toContain('backend === "claude-code" && mode === "mcp"');
    expect(html).toContain('Stored but inactive: {0} in {1} mode does not support reply-drop recovery.');
  });

  it("surfaces the ClassicBot access and editable channel workflow", () => {
    expect(html).toContain("Who can use ClassicBot");
    expect(html).toContain("Classic default backend");
    expect(html).toContain("/api/settings/classic/channels/");
  });

  it("stages primary access mode and allowed users with lockout confirmations", () => {
    // Access is edited on the connection it belongs to — one modal, one object.
    expect(html).toContain('const fMode = select(ch.access.mode || "locked", ["open", "locked", "pairing"])');
    expect(html).toContain('mode: stagedAccessMode, allowed_users: stagedAllowedUsers');
    // Still confirmed against the immutable staged snapshot at Apply time, not
    // against controls the user may have edited again since.
    expect(html).toContain('confirmAccessChange(previousAccess, stagedAccessMode, stagedAllowedUsers)');
    expect(html).toContain('if (change.confirm && !change.confirm())');
    expect(html).toContain('confirmOpenAccess: "Open access allows anyone in this channel to operate the bot. Continue?"');
    expect(html).toContain('accessLockedEmpty: "Locked mode has no allowed users; add at least one administrator to avoid lockout."');
  });

  it("shows shortened names plus effective model and effort for fleet and ClassicBot agents", () => {
    expect(html).toContain('name.replace(/-t\\d+$/, "")');
    expect(html).toContain('const summary = effectiveSummary(name, inst)');
    expect(html).toContain('const summary = effectiveSummary(c.instanceName, c, true)');
    expect(html).toContain('summary.model');
    expect(html).toContain('`effort: ${summary.effort}`');
    expect(html).toContain('model_display: i.model_display');
    expect(html).toContain('effort_supported: i.effort_supported');
  });

  it("localizes settings validation, confirmation, and apply feedback", () => {
    expect(html).toContain('noAgentMatch: "沒有符合「{0}」的 Agent。"');
    expect(html).toContain('configLoadFailed: "載入設定失敗 — 請重新開啟 Settings 連結。"');
    expect(html).toContain('removeBot: "確定移除機器人「{0}」嗎？（.env 中的 token 會保留）"');
    expect(html).toContain('setValidation(fAutoPause, autoFeedback, !Number.isFinite(auto) || auto < 0 ? t("mustNonNegative") : "")');
    expect(html).toContain('t("changesApplied")');
    expect(html).toContain('confirm(tf("deleteAgent", name))');
  });

  it("keeps unsupported provider verifiers fail-closed in the UI", () => {
    const helper = html.match(/function providerSecretInputAllowed\(spec\) \{[^\n]+\}/)?.[0];
    expect(helper).toBeTruthy();
    const allowsInput = vm.runInNewContext(`(${helper})`) as (spec: { verifier?: string }) => boolean;
    expect(allowsInput({ verifier: "unsupported" })).toBe(false);
    expect(allowsInput({ verifier: "available" })).toBe(true);
    expect(html).toContain("if (!providerSecretInputAllowed(spec))");
    expect(html).toContain("no key input is offered");
  });
});
