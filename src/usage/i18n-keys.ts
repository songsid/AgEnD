/**
 * Usage copy shared by the server renderers and the browser-only View renderer.
 * Keep this list explicit: the parity test rejects a key missing from either
 * locale surface before a mixed-language release can ship.
 */
export const USAGE_I18N_KEYS = [
  "usage.title", "usage.title_plain", "usage.empty_active", "usage.not_logged_in",
  "usage.error_fallback", "usage.no_data", "usage.reset.in", "usage.reset.soon",
  "usage.duration.days_hours", "usage.duration.hours_minutes", "usage.duration.minutes",
  "usage.metric.session", "usage.metric.weekly", "usage.metric.monthly", "usage.metric.days_window",
  "usage.metric.named", "usage.metric.named_session", "usage.metric.named_weekly",
  "usage.metric.named_monthly", "usage.metric.named_days", "usage.metric.extra_usage",
  "usage.metric.rate_limit_resets", "usage.metric.credits", "usage.metric.weekly_limit",
  "usage.metric.pay_as_you_go", "usage.metric.bonus_credits", "usage.metric.overage_charges",
  "usage.metric.pay_per_use", "usage.unit.available", "usage.unit.credits",
  "usage.metric.usage_monthly", "usage.note.used_limit_unit", "usage.note.bonus_codes",
  "usage.value.disabled", "usage.value.cap", "usage.note.binding",
  "usage.note.binding_severity", "usage.note.busiest_model", "usage.note.busiest_models",
  "usage.metric.agy_claude_others", "usage.metric.agy_claude_others_session", "usage.metric.agy_claude_others_weekly",
  "usage.hint.statusline_now", "usage.hint.statusline_minutes", "usage.hint.claude_api_key",
  "usage.hint.login_claude", "usage.hint.login_agy", "usage.hint.no_quota",
  "usage.hint.login_codex", "usage.hint.codex_no_oauth", "usage.hint.login_grok",
  "usage.hint.grok_no_login", "usage.hint.login_kiro", "usage.hint.kiro_signed_out",
  "usage.hint.token_refreshing", "usage.hint.subscription_no_credit", "usage.hint.no_quota_account",
  "usage.error.unreachable", "usage.error.token_rejected", "usage.error.rate_limited",
  "usage.error.http", "usage.error.billing_http", "usage.error.invalid_response",
  "usage.error.invalid_billing_response", "usage.error.invalid_kiro_response",
  "usage.error.claude_token_expired", "usage.error.codex_token_expired",
  "usage.error.grok_expired", "usage.error.grok_response_changed", "usage.error.agy_cap",
  "usage.error.agy_no_refresh", "usage.error.agy_token_expired", "usage.error.agy_login_expired",
  "usage.error.agy_refresh_empty", "usage.error.grok_auth_readonly", "usage.error.grok_no_refresh",
  "usage.error.grok_refresh_unreachable", "usage.error.grok_invalid_refresh", "usage.error.grok_persist",
] as const;

export type UsageI18nKey = typeof USAGE_I18N_KEYS[number];
