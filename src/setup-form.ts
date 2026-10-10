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
</style>
</head>
<body>
<main>
  <h1>Set up AgEnD</h1>
  <p>Enter the setup code shown in the terminal where you ran <code>agend setup</code>.</p>
  <form id="f">
    <input id="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH" maxlength="12" autofocus>
    <button id="go" type="submit">Continue</button>
  </form>
  <div class="err" id="msg"></div>
</main>
<script>
(() => {
  "use strict";
  const msg = document.getElementById("msg");
  const go = document.getElementById("go");
  document.getElementById("f").addEventListener("submit", async (event) => {
    event.preventDefault();
    go.disabled = true;
    msg.textContent = "";
    let res;
    try {
      res = await fetch("open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: document.getElementById("code").value }),
      });
    } catch {
      msg.textContent = "Could not reach the setup page.";
      go.disabled = false;
      return;
    }
    if (res.ok) { location.reload(); return; }
    let body = null; try { body = await res.json(); } catch {}
    msg.textContent = (body && body.error) || "That code was not accepted.";
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
</style>
</head>
<body>
<main>
  <h1>Set up AgEnD</h1>
  <div class="sub" id="intro">This page is open only while setup is running. It closes itself when you finish, or after 15 minutes.</div>

  <div class="step">
    <h2>1 · Agent</h2>
    <label for="backend">Backend</label>
    <select id="backend"></select>
    <div class="sub" id="backendHint"></div>
    <label for="dir">Working directory (absolute path)</label>
    <input id="dir" placeholder="/home/you/projects/app">
    <label for="name">First agent name</label>
    <input id="name" value="agent-1">
  </div>

  <div class="step">
    <h2>2 · Platform</h2>
    <div class="row">
      <button id="pickTelegram" class="primary">Telegram</button>
      <button id="pickDiscord">Discord</button>
    </div>
    <div class="sub" id="platformHint">Create a bot with @BotFather, then add it to a group.</div>
  </div>

  <div class="step">
    <h2>3 · Credentials</h2>
    <label for="token">Bot token</label>
    <input id="token" type="password" placeholder="123456:ABC-DEF…">
    <div class="sub">Written to ~/.agend/.env and never shown again.</div>
    <label for="tokenEnv">Environment variable</label>
    <input id="tokenEnv" value="AGEND_BOT_TOKEN">
    <div class="row"><button id="verify">Verify</button><span class="msg" id="verifyMsg"></span></div>
    <div id="platformFields"></div>
  </div>

  <div class="step">
    <h2>4 · Review and start</h2>
    <div class="row"><button id="preview">Show what will be written</button></div>
    <pre id="planOut" hidden></pre>
    <div class="row"><button id="finish" class="primary" disabled>Create and start AgEnD</button><span class="msg" id="finishMsg"></span></div>
  </div>
</main>
<script>
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const state = { platform: "telegram", identity: null, guilds: [], offset: 0, plan: null };
  // Relative to the page's own directory, which is /s/<sid>/. An absolute path
  // would leave that namespace and 404 — the sid is where this page lives, not
  // a prefix bolted on to it.
  const api = async (path, opts) => {
    const res = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts || {}));
    let body = null; try { body = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, body };
  };

  async function loadEnvironment() {
    const res = await api("api/settings/quickstart/environment");
    if (formFrozen) return;
    const backends = res.body?.backends || [];
    $("backend").innerHTML = "";
    for (const name of backends.length ? backends : ["claude-code"]) {
      const opt = document.createElement("option"); opt.value = name; opt.textContent = name; $("backend").append(opt);
    }
    $("backendHint").textContent = backends.length
      ? "Found on this host: " + backends.join(", ")
      : "No backend CLI found on this host — install one first.";
  }

  function setPlatform(platform) {
    if (formFrozen) return;
    state.platform = platform;
    state.identity = null; $("verifyMsg").textContent = "";
    $("pickTelegram").className = platform === "telegram" ? "primary" : "";
    $("pickDiscord").className = platform === "discord" ? "primary" : "";
    $("platformHint").textContent = platform === "telegram"
      ? "Create a bot with @BotFather, then add it to a group."
      : "Create an application in the Discord developer portal and invite the bot to your server.";
    renderPlatformFields();
  }

  // Only the ids that platform has — the same question the CLI asks.
  function renderPlatformFields() {
    if (formFrozen) return;
    const host = $("platformFields"); host.innerHTML = "";
    const field = (id, labelText, hint) => {
      const label = document.createElement("label"); label.textContent = labelText; label.htmlFor = id;
      const input = document.createElement("input"); input.id = id;
      host.append(label, input);
      if (hint) { const h = document.createElement("div"); h.className = "sub"; h.textContent = hint; host.append(h); }
      return input;
    };
    if (state.platform === "discord") {
      const guild = document.createElement("select"); guild.id = "guild";
      const label = document.createElement("label"); label.textContent = "Server (guild)"; label.htmlFor = "guild";
      host.append(label, guild);
      for (const g of state.guilds) { const opt = document.createElement("option"); opt.value = g.id; opt.textContent = g.name + " (" + g.id + ")"; guild.append(opt); }
      field("general", "General channel id");
      field("admin", "Your Discord user id", "Becomes the first allowed user.");
    } else {
      field("group", "Group id", "Or post any message in the group and press Detect.");
      const row = document.createElement("div"); row.className = "row";
      const detect = document.createElement("button"); detect.id = "detect"; detect.textContent = "Detect from a message";
      detect.onclick = detectGroup; row.append(detect);
      const msg = document.createElement("span"); msg.className = "msg"; msg.id = "detectMsg"; row.append(msg);
      host.append(row);
      field("admin", "Your Telegram user id", "Becomes the first allowed user.");
    }
  }

  async function detectGroup() {
    if (formFrozen) return;
    $("detectMsg").textContent = "Waiting for a message in the group…";
    const res = await api("api/settings/quickstart/probe", { method: "POST", body: JSON.stringify({ action: "await-telegram-start", token: $("token").value.trim(), offset: state.offset }) });
    if (formFrozen) return;
    if (!res.ok) { $("detectMsg").textContent = res.body?.error || "Failed."; return; }
    state.offset = res.body.offset;
    if (res.body.found) {
      $("group").value = String(res.body.found.groupId);
      $("admin").value = String(res.body.found.userId);
      $("detectMsg").textContent = "Found.";
    } else $("detectMsg").textContent = "No group message yet — post one and press Detect again.";
  }

  function input() {
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
    $("verifyMsg").textContent = "Asking the provider…";
    const token = $("token").value.trim();
    const res = await api("api/settings/quickstart/probe", { method: "POST", body: JSON.stringify({ action: "verify", platform: state.platform, token }) });
    if (formFrozen) return;
    state.identity = res.body?.identity || { valid: false };
    $("verifyMsg").className = "msg " + (state.identity.valid ? "ok" : "err");
    $("verifyMsg").textContent = state.identity.valid ? "✓ " + (state.identity.username || "verified") : "✗ " + (state.identity.reason || "rejected");
    if (state.identity.valid && state.platform === "discord") {
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
    if (!res.ok) { $("planOut").hidden = false; $("planOut").textContent = res.body?.error || "Failed."; return; }
    state.plan = res.body;
    $("planOut").hidden = false;
    $("planOut").textContent = JSON.stringify(res.body, null, 2);
    $("finish").disabled = !state.identity?.valid;
  };

  let approvedSetup = false;
  let formFrozen = false;
  let submission = null;
  let pollGeneration = 0;
  const freezeFields = (frozen) => {
    formFrozen = frozen;
    for (const field of document.querySelectorAll("main input, main select, #verify, #preview, #pickTelegram, #pickDiscord, #detect")) field.disabled = frozen;
  };
  const restoreEditing = (message) => {
    pollGeneration++; approvedSetup = false; submission = null; state.identity = null;
    freezeFields(false); $("finish").disabled = true; $("finish").textContent = "Create and start AgEnD";
    $("finishMsg").className = "msg err"; $("finishMsg").textContent = message;
  };
  for (const field of document.querySelectorAll("main input, main select")) field.addEventListener("input", () => {
    approvedSetup = false; submission = null; $("finish").textContent = "Create and start AgEnD";
  });
  const watchPending = (pendingId) => {
    const generation = ++pollGeneration;
    freezeFields(true); $("finish").disabled = true;
    $("finishMsg").textContent = "On the host, run: agend settings confirm " + pendingId;
    const poll = async () => {
      if (generation !== pollGeneration) return;
      try {
        const result = await api("api/settings/pending/" + pendingId);
        if (generation !== pollGeneration) return;
        if (!result.ok) { restoreEditing("Setup confirmation is no longer available. Review and enter the token again."); return; }
        const pending = result.body;
        if (pending.state === "pending" || pending.state === "applying") { setTimeout(poll, 1000); return; }
        if (pending.state !== "applied") { restoreEditing(pending.outcome?.message || "Change was not applied. Review and enter the token again."); return; }
        approvedSetup = true; submission = null; $("finish").disabled = false; $("finish").textContent = "Start AgEnD";
        $("finishMsg").textContent = "Configuration confirmed. Select Start AgEnD to finish setup.";
      } catch { if (generation === pollGeneration) setTimeout(poll, 1000); }
    };
    setTimeout(poll, 1000);
  };
  $("finish").onclick = async () => {
    $("finish").disabled = true;
    try {
      if (approvedSetup) {
        const finished = await api("setup/finish", { method: "POST" });
        if (!finished.ok) { restoreEditing(finished.body?.error || "Confirmation is no longer current."); return; }
        $("finishMsg").textContent = "AgEnD is starting. Continue in the channel you configured.";
        if (finished.body?.watch !== false) waitForFleet();
        return;
      }
      // Preserve bytes and key on a lost HTTP response; a deliberate retry after
      // a terminal outcome receives a new key and requires secret reentry.
      submission ||= { key: crypto.randomUUID(), body: JSON.stringify(Object.assign({}, input(), { token: $("token").value.trim() })) };
      freezeFields(true);
      $("finishMsg").textContent = "Requesting host confirmation…";
      const commit = await api("api/settings/quickstart/commit", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": submission.key }, body: submission.body });
      if (!commit.ok) { restoreEditing(commit.body?.error || "Failed."); return; }
      if (commit.body?.result !== "pending_confirmation" || !commit.body.pending_change?.id) { restoreEditing("Expected a pending host confirmation."); return; }
      $("token").value = ""; submission = null;
      watchPending(commit.body.pending_change.id);
    } catch { $("finishMsg").textContent = "Connection failed. Retry to find the same confirmation."; $("finish").disabled = false; }
  };
  // Same-cookie reloads rediscover an unresolved consent request without a secret.
  api("api/settings/pending").then(result => {
    const pending = result.ok && Array.isArray(result.body) && result.body.find(item => item.state === "pending" || item.state === "applying");
    if (pending) { watchPending(pending.id); return; }
    api("setup/status").then(status => {
      if (!status.ok || !status.body?.finish_ready || submission || pollGeneration) return;
      approvedSetup = true; freezeFields(true); $("finish").disabled = false; $("finish").textContent = "Start AgEnD";
      $("finishMsg").textContent = "Configuration confirmed. Select Start AgEnD to finish setup.";
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
          $("finishMsg").className = "msg ok";
          // #1519 P7: the fleet answers on this address now — its dashboard is here too.
          $("finishMsg").textContent = "AgEnD is up. Talk to it in the channel you just set up, or open its dashboard: ";
          const link = document.createElement("a"); link.href = "/"; link.textContent = location.origin + "/";
          $("finishMsg").append(link, " (sign in with agend web --code on the machine running AgEnD, or send /dashboard to your bot).");
          return;
        }
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) {
        $("finishMsg").className = "msg err";
        $("finishMsg").textContent = "AgEnD has not come up within 60 seconds. Run \`agend start\` on the machine itself and check fleet.log — this page cannot tell you any more.";
        return;
      }
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 1500);
  }

  $("pickTelegram").onclick = () => setPlatform("telegram");
  $("pickDiscord").onclick = () => setPlatform("discord");
  loadEnvironment();
  setPlatform("telegram");
})();
</script>
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
  return html.replace(/<script>/g, `<script nonce="${nonce}">`).replace(/<style>/g, `<style nonce="${nonce}">`);
}
