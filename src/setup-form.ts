import { SETUP_CODE_STRINGS, SETUP_FORM_STRINGS, setupI18nRuntime } from "./setup-i18n.js";

/**
 * The pre-fleet form, inline.
 *
 * Deliberately not `ui/settings.html`: that page is a panel for a running
 * fleet — it starts and stops agents, applies jobs, restarts AgEnD. Serving it
 * from a host that has none of those would be a page of controls that cannot
 * work, and it would put the whole panel on a surface that exists before any
 * fleet-level access control does.
 */
/**
 * What an unauthenticated visitor gets: a box to type the code into.
 *
 * Deliberately says nothing about this machine — no backend list, no existing
 * channels, no hostname. Whoever has the link has only the link, and until they
 * prove they also have the code they learn nothing from it.
 */
export const SETUP_CODE_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Proof that a request reached THIS listener and not merely something that
     answers 200. The tunnel's readiness probe looks for exactly this. It is the
     sid, which is already in the URL, so it discloses nothing new. -->
<meta name="agend-setup" content="__AGEND_SETUP_MARKER__">
<title>Set up AgEnD</title>
<style>
  body { font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #ffffff; color: #111827; }
  main { max-width: 420px; margin: 0 auto; padding: 64px 20px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: #6b7280; font-size: 13px; margin: 0 0 20px; }
  input { width: 100%; padding: 12px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 20px; letter-spacing: 3px; text-align: center; text-transform: uppercase; box-sizing: border-box; }
  button { width: 100%; margin-top: 12px; padding: 12px; border: 1px solid #2563eb; border-radius: 6px; background: #2563eb; color: #fff; font-size: 15px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .err { color: #dc2626; font-size: 13px; margin-top: 12px; min-height: 18px; }
  .lang { display: flex; justify-content: flex-end; }
  .lang button { width: auto; margin: 0; padding: 4px 10px; border-color: #e5e7eb; background: #fff; color: #111827; font-size: 13px; }
</style>
</head>
<body>
<main>
  <div class="lang"><button id="lang" type="button" data-i18n="otherLang" data-i18n-label="langTitle">中文</button></div>
  <h1 data-i18n="title">Set up AgEnD</h1>
  <p id="lead">Enter the setup code shown in the terminal where you ran <code>agend setup</code>.</p>
  <form id="f">
    <input id="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH" maxlength="12" autofocus>
    <button id="go" type="submit" data-i18n="continue">Continue</button>
  </form>
  <div class="err" id="msg"></div>
</main>
<script>
(() => {
  "use strict";
  ${setupI18nRuntime(SETUP_CODE_STRINGS)}
  show(document.getElementById("lead"), el => {
    const [before, after] = tr("lead").split("{0}"), command = document.createElement("code");
    command.textContent = "agend setup"; el.replaceChildren(before, command, after ?? "");
  });
  const msg = document.getElementById("msg");
  const go = document.getElementById("go");
  document.getElementById("f").addEventListener("submit", async (event) => {
    event.preventDefault();
    go.disabled = true;
    show(msg, el => { el.textContent = ""; });
    let res;
    try {
      res = await fetch("open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: document.getElementById("code").value }),
      });
    } catch {
      show(msg, el => { el.textContent = tr("unreachable"); });
      go.disabled = false;
      return;
    }
    if (res.ok) { location.reload(); return; }
    let body = null; try { body = await res.json(); } catch {}
    const error = body && body.error;
    show(msg, el => { el.textContent = error ? trHost(error) : tr("notAccepted"); });
    // A spent budget ends the page; there is nothing useful left to type into.
    if (res.status !== 410) go.disabled = false;
  });
})();
</script>
</body>
</html>
`;

export const SETUP_FORM_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up AgEnD</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #ffffff; color: #111827; }
  main { max-width: 640px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #6b7280; font-size: 13px; }
  .step { border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-top: 16px; }
  .step h2 { font-size: 14px; margin: 0 0 12px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 4px; }
  input, select { width: 100%; padding: 8px 10px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 14px; }
  button { padding: 8px 14px; border: 1px solid #e5e7eb; border-radius: 6px; background: #fff; font-size: 14px; cursor: pointer; }
  button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  button:disabled { opacity: .5; cursor: default; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
  .msg { font-size: 13px; }
  .ok { color: #059669; } .err { color: #dc2626; }
  pre { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px; font-size: 12px; overflow: auto; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  #lang { padding: 4px 10px; font-size: 13px; flex: none; }
</style>
</head>
<body>
<main>
  <div class="top"><h1 data-i18n="title">Set up AgEnD</h1><button id="lang" type="button" data-i18n="otherLang" data-i18n-label="langTitle">中文</button></div>
  <div class="sub" id="intro" data-i18n="intro">This page is open only while setup is running. It closes itself when you finish, or after 15 minutes.</div>
  <div class="sub msg" id="ttlMsg" role="status"></div>

  <div class="step" id="setupSignins" aria-label="AI backend sign-ins" data-i18n-label="signinsLabel"></div>

  <div class="step">
    <h2 data-i18n="stepAgent">1 · Agent</h2>
    <label for="backend" data-i18n="backend">Backend</label>
    <select id="backend"></select>
    <div class="sub" id="backendHint"></div>
    <label for="dir" data-i18n="dir">Working directory (optional)</label>
    <input id="dir" placeholder="/home/you/projects/app" data-i18n-placeholder="dirPlaceholder" aria-describedby="dirHint">
    <div class="sub" id="dirHint"></div>
    <label for="name" data-i18n="name">First agent name</label>
    <input id="name" value="agent-1">
  </div>

  <div class="step">
    <h2 data-i18n="stepPlatform">2 · Platform</h2>
    <div class="row">
      <button id="pickTelegram" class="primary">Telegram</button>
      <button id="pickDiscord">Discord</button>
      <button id="pickWeb" data-i18n="webOnly">Web only (no bot)</button>
    </div>
    <div class="sub" id="platformHint">Create a bot with @BotFather, then add it to a group.</div>
  </div>

  <div class="step" id="credStep">
    <h2 data-i18n="stepCredentials">3 · Credentials</h2>
    <label for="token" data-i18n="token">Bot token</label>
    <input id="token" type="password" placeholder="123456:ABC-DEF…">
    <div class="sub" data-i18n="tokenNote">Written to ~/.agend/.env and never shown again.</div>
    <label for="tokenEnv" data-i18n="tokenEnv">Environment variable</label>
    <input id="tokenEnv" value="AGEND_BOT_TOKEN">
    <div class="row"><button id="verify" data-i18n="verify">Verify</button><span class="msg" id="verifyMsg"></span></div>
    <div id="platformFields"></div>
  </div>

  <div class="step">
    <h2 data-i18n="stepReview">4 · Review and start</h2>
    <div class="row"><button id="preview" data-i18n="preview">Show what will be written</button></div>
    <pre id="planOut" hidden></pre>
    <div class="row"><button id="finish" class="primary" disabled>Create and start AgEnD</button><span class="msg" id="finishMsg"></span></div>
  </div>
</main>
<script>
(() => {
  "use strict";
  ${setupI18nRuntime(SETUP_FORM_STRINGS)}
  const $ = (id) => document.getElementById(id);
  const state = { platform: "telegram", identity: null, guilds: [], offset: 0, plan: null, workspaces: null };
  // Relative to the page's own directory, which is /s/<sid>/. An absolute path
  // would leave that namespace and 404 — the sid is where this page lives, not
  // a prefix bolted on to it.
  const api = async (path, opts) => {
    const res = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts || {}));
    let body = null; try { body = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, body };
  };
  // A line of this page in its language: a key and its values, or (host) the host's own words, translated when known.
  const say = (id, key, ...values) => show($(id), el => { el.textContent = tr(key, ...values); });
  const sayHost = (id, text, fallback) => show($(id), el => { el.textContent = text ? trHost(text) : tr(fallback); });

  // #2726: no directory is the agent's own workspace, <AGEND_HOME>/workspaces/<name> — said under the field, by name.
  const showDirHint = () => show($("dirHint"), el => {
    const name = $("name").value.trim();
    el.textContent = state.workspaces && name ? tr("dirDefault", state.workspaces + "/" + name) : tr("dirDefaultName");
  });

  async function loadEnvironment() {
    const res = await api("api/settings/quickstart/environment");
    if (formFrozen) return;
    const backends = res.body?.backends || [];
    if (typeof res.body?.workspaces_dir === "string") { state.workspaces = res.body.workspaces_dir; showDirHint(); }
    $("backend").innerHTML = "";
    for (const name of backends.length ? backends : ["claude-code"]) {
      const opt = document.createElement("option"); opt.value = name; opt.textContent = name; $("backend").append(opt);
    }
    if (backends.length) say("backendHint", "backendFound", backends.join(", "));
    else say("backendHint", "backendNone");
  }

  function setPlatform(platform) {
    if (formFrozen) return;
    state.platform = platform;
    state.identity = null; say("verifyMsg", "");
    $("pickTelegram").className = platform === "telegram" ? "primary" : "";
    $("pickDiscord").className = platform === "discord" ? "primary" : "";
    $("pickWeb").className = platform === "web" ? "primary" : "";
    say("platformHint", platform === "telegram" ? "hintTelegram" : platform === "discord" ? "hintDiscord" : "hintWeb");
    // #2233: web only has no credentials step — no token, no admin id, nothing to verify.
    $("credStep").hidden = platform === "web";
    state.plan = null; $("planOut").hidden = true; $("finish").disabled = true;
    renderPlatformFields();
  }

  // Only the ids that platform has — the same question the CLI asks.
  function renderPlatformFields() {
    if (formFrozen) return;
    const host = $("platformFields"); host.innerHTML = "";
    if (state.platform === "web") return;
    const field = (id, labelKey, hintKey) => {
      const label = document.createElement("label"); label.htmlFor = id; show(label, el => { el.textContent = tr(labelKey); });
      const input = document.createElement("input"); input.id = id;
      host.append(label, input);
      if (hintKey) { const h = document.createElement("div"); h.className = "sub"; show(h, el => { el.textContent = tr(hintKey); }); host.append(h); }
      return input;
    };
    if (state.platform === "discord") {
      const guild = document.createElement("select"); guild.id = "guild";
      const label = document.createElement("label"); label.htmlFor = "guild"; show(label, el => { el.textContent = tr("guild"); });
      host.append(label, guild);
      for (const g of state.guilds) { const opt = document.createElement("option"); opt.value = g.id; opt.textContent = g.name + " (" + g.id + ")"; guild.append(opt); }
      field("general", "general");
      field("admin", "discordAdmin", "firstAllowed");
    } else {
      field("group", "group", "groupHint");
      const row = document.createElement("div"); row.className = "row";
      const detect = document.createElement("button"); detect.id = "detect"; show(detect, el => { el.textContent = tr("detect"); });
      detect.onclick = detectGroup; row.append(detect);
      const msg = document.createElement("span"); msg.className = "msg"; msg.id = "detectMsg"; row.append(msg);
      host.append(row);
      field("admin", "telegramAdmin", "firstAllowed");
    }
  }

  async function detectGroup() {
    if (formFrozen) return;
    say("detectMsg", "detectWaiting");
    const res = await api("api/settings/quickstart/probe", { method: "POST", body: JSON.stringify({ action: "await-telegram-start", token: $("token").value.trim(), offset: state.offset }) });
    if (formFrozen) return;
    if (!res.ok) { sayHost("detectMsg", res.body?.error, "failed"); return; }
    state.offset = res.body.offset;
    if (res.body.found) {
      $("group").value = String(res.body.found.groupId);
      $("admin").value = String(res.body.found.userId);
      say("detectMsg", "detectFound");
    } else say("detectMsg", "detectNone");
  }

  function input() {
    // #2233: the agent alone; a web-only setup carries no connection field at all.
    // #2726: an empty directory is sent as it is — the host gives the agent its own workspace.
    if (state.platform === "web") return { web_only: true, backend: $("backend").value, working_directory: $("dir").value.trim(), instance_name: $("name").value.trim() };
    return {
      platform: state.platform,
      token_env: $("tokenEnv").value.trim(),
      backend: $("backend").value,
      working_directory: $("dir").value.trim(),
      instance_name: $("name").value.trim(),
      group_id: $("group") ? $("group").value.trim() || undefined : undefined,
      guild_id: $("guild") ? $("guild").value || undefined : undefined,
      general_channel_id: $("general") ? $("general").value.trim() || undefined : undefined,
      admin_user_id: $("admin") ? $("admin").value.trim() || undefined : undefined,
    };
  }

  $("verify").onclick = async () => {
    if (formFrozen) return;
    say("verifyMsg", "verifying");
    const token = $("token").value.trim();
    const res = await api("api/settings/quickstart/probe", { method: "POST", body: JSON.stringify({ action: "verify", platform: state.platform, token }) });
    if (formFrozen) return;
    const identity = state.identity = res.body?.identity || { valid: false };
    show($("verifyMsg"), el => {
      el.className = "msg " + (identity.valid ? "ok" : "err");
      el.textContent = identity.valid ? "✓ " + (identity.username || tr("verified")) : "✗ " + (identity.reason ? trHost(identity.reason) : tr("rejected"));
    });
    if (identity.valid && state.platform === "discord") {
      const guilds = await api("api/settings/quickstart/probe", { method: "POST", body: JSON.stringify({ action: "guilds", token }) });
      if (formFrozen) return;
      state.guilds = guilds.body?.guilds || [];
      renderPlatformFields();
    }
  };

  $("preview").onclick = async () => {
    if (formFrozen) return;
    const res = await api("api/settings/quickstart/plan", { method: "POST", body: JSON.stringify(input()) });
    if (formFrozen) return;
    if (!res.ok) { $("planOut").hidden = false; sayHost("planOut", res.body?.error, "failed"); return; }
    state.plan = res.body;
    $("planOut").hidden = false;
    show($("planOut"), el => { el.textContent = JSON.stringify(res.body, null, 2); });
    $("finish").disabled = !(state.platform === "web" || state.identity?.valid);
  };

  let approvedSetup = false;
  let formFrozen = false;
  let submission = null;
  let pollGeneration = 0;
  // #2650 item 10: how long this page has left, counted here from the host's own remaining time (no polling: a request
  // would keep an idle page open). After it, the page says it has closed and how to reopen it, instead of freezing.
  let closesAt = null, handedOver = false, pageClosed = false;
  const setFinishLabel = (key) => show($("finish"), el => { el.textContent = tr(key); });
  // finishMsg: a key of this page, or the host's words; with its colour.
  const finishSay = (cls, key, ...values) => show($("finishMsg"), el => { el.className = cls; el.textContent = tr(key, ...values); });
  const finishHost = (text, fallback) => show($("finishMsg"), el => { el.className = "msg err"; el.textContent = text ? trHost(text) : tr(fallback); });
  const closePage = () => {
    if (handedOver || pageClosed) return;
    pageClosed = true; pollGeneration++; freezeFields(true); $("finish").disabled = true;
    show($("ttlMsg"), el => { el.className = "sub msg err"; el.textContent = tr("closed"); });
    show($("finishMsg"), el => { el.className = "msg err"; el.textContent = tr("closedFinish", tr("reopen")); });
  };
  const showRemaining = () => {
    if (closesAt === null || handedOver || pageClosed) return;
    const left = closesAt - performance.now();
    if (left <= 0) { closePage(); return; }
    const total = Math.ceil(left / 1000), text = Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
    const soon = left <= 3 * 60_000;
    show($("ttlMsg"), el => {
      el.className = soon ? "sub msg err" : "sub msg";
      el.textContent = soon ? tr("closesSoon", tr("closesIn", text), tr("reopen")) : tr("closesIn", text);
    });
    setTimeout(showRemaining, 1000);
  };
  const trackRemaining = (status) => {
    const ms = status?.remaining_ms;
    if (closesAt !== null || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return;
    closesAt = performance.now() + ms; showRemaining();
  };

  const freezeFields = (frozen) => {
    formFrozen = frozen;
    for (const field of document.querySelectorAll("main input, main select, #verify, #preview, #pickTelegram, #pickDiscord, #pickWeb, #detect")) field.disabled = frozen;
  };
  const restoreEditing = (render) => {
    if (pageClosed) return;                       // a late answer never reopens a closed page (#2653 review)
    pollGeneration++; approvedSetup = false; submission = null; state.identity = null;
    freezeFields(false); $("finish").disabled = true; setFinishLabel("finish");
    render();
  };
  for (const field of document.querySelectorAll("main input, main select")) field.addEventListener("input", () => {
    approvedSetup = false; submission = null; setFinishLabel("finish");
  });
  // A host confirmation that did not apply: its outcome in this page's language (by its reason), else the host's words.
  const outcomeText = (pending) => {
    const reason = pending.outcome?.reason_code;
    if (reason && I18N.en["outcome_" + reason]) return tr("outcome_" + reason);
    return pending.outcome?.message ? trHost(pending.outcome.message) : tr("notApplied");
  };
  const watchPending = (pendingId) => {
    if (pageClosed) return;                       // a late pending list or commit answer: the page stays closed
    const generation = ++pollGeneration;
    freezeFields(true); $("finish").disabled = true;
    // #2650 item 1: the page asks; a person at the computer running AgEnD approves. Nothing on this page can.
    const ask = () => finishSay("msg", "approveHost", pendingId);
    ask();
    let misses = 0;
    const poll = async () => {
      if (generation !== pollGeneration) return;
      try {
        const result = await api("api/settings/pending/" + pendingId);
        if (generation !== pollGeneration) return;
        if (misses) { misses = 0; ask(); }
        if (!result.ok) { restoreEditing(() => finishSay("msg err", "confirmGone")); return; }
        const pending = result.body;
        if (pending.state === "pending" || pending.state === "applying") { setTimeout(poll, 1000); return; }
        if (pending.state !== "applied") { restoreEditing(() => show($("finishMsg"), el => { el.className = "msg err"; el.textContent = outcomeText(pending); })); return; }
        approvedSetup = true; submission = null; $("finish").disabled = false; setFinishLabel("start");
        finishSay("msg", "confirmed");
      } catch {
        if (generation !== pollGeneration) return;
        // #2650 item 10: a lost connection is said, not waited out silently; the pending confirmation keeps its id.
        if (++misses === 5) show($("finishMsg"), el => { el.className = "msg err"; el.textContent = tr("lostContact", tr("reopen")); });
        setTimeout(poll, misses < 5 ? 1000 : 3000);
      }
    };
    setTimeout(poll, 1000);
  };
  $("finish").onclick = async () => {
    if (pageClosed) return;
    if ($("setupSignins").dataset.ready === "false") {
      finishSay($("finishMsg").className, "finishSignins"); return;
    }
    $("finish").disabled = true;
    try {
      if (approvedSetup) {
        const finished = await api("setup/finish", { method: "POST" });
        if (!finished.ok) { restoreEditing(() => finishHost(finished.body?.error, "notCurrent")); return; }
        handedOver = true; show($("ttlMsg"), el => { el.textContent = ""; });
        finishSay($("finishMsg").className, state.platform === "web" ? "startingWeb" : "startingChat");
        if (finished.body?.watch !== false) waitForFleet();
        return;
      }
      // Preserve bytes and key on a lost HTTP response; a deliberate retry after
      // a terminal outcome receives a new key and requires secret reentry.
      submission ||= { key: crypto.randomUUID(), body: JSON.stringify(state.platform === "web" ? input() : Object.assign({}, input(), { token: $("token").value.trim() })) };
      freezeFields(true);
      finishSay($("finishMsg").className, "requesting");
      const commit = await api("api/settings/quickstart/commit", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": submission.key }, body: submission.body });
      if (!commit.ok) { restoreEditing(() => finishHost(commit.body?.error, "failed")); return; }
      if (commit.body?.result !== "pending_confirmation" || !commit.body.pending_change?.id) { restoreEditing(() => finishSay("msg err", "expectedPending")); return; }
      $("token").value = ""; submission = null;
      watchPending(commit.body.pending_change.id);
    } catch { if (pageClosed) return; finishSay($("finishMsg").className, "connectionFailed"); $("finish").disabled = false; }
  };
  // Same-cookie reloads rediscover an unresolved consent request without a secret.
  const status = api("setup/status").then(result => { if (result.ok) trackRemaining(result.body); return result; });
  status.catch(() => {});
  api("api/settings/pending").then(result => {
    const pending = result.ok && Array.isArray(result.body) && result.body.find(item => item.state === "pending" || item.state === "applying");
    if (pending) { watchPending(pending.id); return; }
    status.then(current => {
      if (pageClosed || !current.ok || !current.body?.finish_ready || submission || pollGeneration) return;
      approvedSetup = true; freezeFields(true); $("finish").disabled = false; setFinishLabel("start");
      finishSay($("finishMsg").className, "confirmed");
    }).catch(() => {});
  }).catch(() => {});

  // The host is gone; the fleet is binding the same port. Connection refused is
  // the expected state in between, so it is not an error until the cap.
  function waitForFleet() {
    const deadline = Date.now() + 60_000;
    const tick = async () => {
      try {
        const res = await fetch("/health", { cache: "no-store" });
        if (res.status) {
          // #1519 P7: the fleet answers on this address now — its dashboard is here too.
          // #2233: with no bot, the dashboard is where AgEnD is used; its sign-in code comes from the machine.
          show($("finishMsg"), el => {
            el.className = "msg ok";
            const link = document.createElement("a"); link.href = "/"; link.textContent = location.origin + "/";
            const [before, after] = tr(state.platform === "web" ? "upWeb" : "upChat").split("{0}");
            el.textContent = before; el.append(link, after ?? "");
          });
          return;
        }
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) {
        finishSay("msg err", "notUp");
        return;
      }
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 1500);
  }

  $("pickTelegram").onclick = () => setPlatform("telegram");
  $("pickDiscord").onclick = () => setPlatform("discord");
  $("pickWeb").onclick = () => setPlatform("web");
  $("name").addEventListener("input", showDirHint);
  setFinishLabel("finish");
  showDirHint();
  loadEnvironment();
  setPlatform("telegram");
})();
</script>
<script type="module" src="setup/signin.js"></script>
</body>
</html>
`;

/**
 * #1490: the setup pages' Content-Security-Policy. Their one `<script>` and one `<style>` are inline, so each response
 * gets a fresh nonce for exactly those (setupPage); nothing else may run, load from elsewhere, post elsewhere, or frame
 * the page. fetch() goes to this origin only (the setup host's own API).
 */
export function setupContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** A setup page with `nonce` on its inline `<script>` and `<style>` tags — the only ones the policy admits. */
export function setupPage(html: string, nonce: string): string {
  return html.replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`).replace(/<style>/g, `<style nonce="${nonce}">`);
}
