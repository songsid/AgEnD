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
      const detect = document.createElement("button"); detect.textContent = "Detect from a message";
      detect.onclick = detectGroup; row.append(detect);
      const msg = document.createElement("span"); msg.className = "msg"; msg.id = "detectMsg"; row.append(msg);
      host.append(row);
      field("admin", "Your Telegram user id", "Becomes the first allowed user.");
    }
  }

  async function detectGroup() {
    $("detectMsg").textContent = "Waiting for a message in the group…";
    const res = await api("api/settings/quickstart/probe", { method: "POST", body: JSON.stringify({ action: "await-telegram-start", token: $("token").value.trim(), offset: state.offset }) });
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
    $("verifyMsg").textContent = "Asking the provider…";
    const token = $("token").value.trim();
    const res = await api("api/settings/quickstart/probe", { method: "POST", body: JSON.stringify({ action: "verify", platform: state.platform, token }) });
    state.identity = res.body?.identity || { valid: false };
    $("verifyMsg").className = "msg " + (state.identity.valid ? "ok" : "err");
    $("verifyMsg").textContent = state.identity.valid ? "✓ " + (state.identity.username || "verified") : "✗ " + (state.identity.reason || "rejected");
    if (state.identity.valid && state.platform === "discord") {
      const guilds = await api("api/settings/quickstart/probe", { method: "POST", body: JSON.stringify({ action: "guilds", token }) });
      state.guilds = guilds.body?.guilds || [];
      renderPlatformFields();
    }
  };

  $("preview").onclick = async () => {
    const res = await api("api/settings/quickstart/plan", { method: "POST", body: JSON.stringify(input()) });
    if (!res.ok) { $("planOut").hidden = false; $("planOut").textContent = res.body?.error || "Failed."; return; }
    state.plan = res.body;
    $("planOut").hidden = false;
    $("planOut").textContent = JSON.stringify(res.body, null, 2);
    $("finish").disabled = !state.identity?.valid;
  };

  $("finish").onclick = async () => {
    $("finish").disabled = true;
    $("finishMsg").textContent = "Writing configuration…";
    const commit = await api("api/settings/quickstart/commit", { method: "POST", body: JSON.stringify(Object.assign({}, input(), { token: $("token").value.trim() })) });
    if (!commit.ok) { $("finishMsg").className = "msg err"; $("finishMsg").textContent = commit.body?.error || "Failed."; $("finish").disabled = false; return; }
    await api("setup/finish", { method: "POST" });
    $("finishMsg").className = "msg";
    $("finishMsg").textContent = "Starting AgEnD… this page will stop responding while the port changes hands.";
    waitForFleet();
  };

  // The host is gone; the fleet is binding the same port. Connection refused is
  // the expected state in between, so it is not an error until the cap.
  function waitForFleet() {
    const deadline = Date.now() + 60_000;
    const tick = async () => {
      try {
        const res = await fetch("/health", { cache: "no-store" });
        if (res.status) { $("finishMsg").className = "msg ok"; $("finishMsg").textContent = "AgEnD is up. Open /settings from the link AgEnD sends you."; return; }
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) {
        $("finishMsg").className = "msg err";
        $("finishMsg").textContent = "AgEnD has not come up within 60s — check fleet.log, or run \`agend start\` on the host.";
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
