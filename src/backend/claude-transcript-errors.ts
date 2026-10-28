/**
 * Claude's own records of an error in its session transcript — the only evidence AgEnD takes for these, never pane
 * text (an agent printing or quoting the words paused itself: #2822, #2834). The upstream CLI watch reads these literals
 * (scripts/manual/cli-upstream-precheck/sources.json), so a changed wording in a new claude release is caught.
 */

/** #2822: an `isApiErrorMessage` 429 — a model's own usage credits are spent; no reset time. */
export const CLAUDE_MODEL_USAGE_LIMIT = /^You['’]ve reached your ([A-Za-z0-9][A-Za-z0-9 .-]{0,40}?) limit\./;

/**
 * #2834 (#816): the `system` / `informational` note Claude writes when it pauses itself until its usage window opens
 * (2.1.312: "Usage limit reached · continuing automatically at 6:53pm · esc to cancel"; "again" when re-armed).
 */
export const CLAUDE_USAGE_LIMIT_PAUSE = /^Usage limit reached(?: again)? · continuing automatically (.+?) · esc to cancel$/i;

/**
 * #2834: an `isApiErrorMessage` 400 whose `error` is `billing_error` — the account is out of API credits. 2.1.312 records
 * "Credit balance is too low" while the screen says "Credit balance too low · Add funds…" (which the old pane pattern
 * never matched).
 */
export const CLAUDE_CREDIT_BALANCE_LOW = /credit balance (?:is )?too low/i;
