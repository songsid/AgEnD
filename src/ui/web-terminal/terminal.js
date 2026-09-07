/* Browser side of the AgEnD web terminal. No external origins (CSP). */
(function () {
  "use strict";
  var base = location.pathname.replace(/\/$/, "");
  var gate = document.getElementById("gate");
  var gateForm = document.getElementById("gate-form");
  var gateMsg = document.getElementById("gate-msg");
  var tokenInput = document.getElementById("token");
  var termEl = document.getElementById("term");
  var keys = document.getElementById("keys");
  var ttlEl = document.getElementById("ttl");
  var doneEl = document.getElementById("done");
  var closeBtn = document.getElementById("btn-close");
  var ws = null, term = null, fit = null, ttlTimer = null, expiresAt = 0;
  var finished = false, reconnectAttempts = 0;

  // A reload or a second tab within the TTL still holds the HttpOnly cookie:
  // try the WebSocket first and only fall back to the token gate on refusal.
  // This GET-free probe keeps the page itself side-effect free.
  connect(true);

  gateForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var token = tokenInput.value.trim();
    if (!token) return;
    gateMsg.textContent = "";
    fetch(base + "/open", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token })
    }).then(function (res) {
      if (res.status === 204) { tokenInput.value = ""; connect(); return; }
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (res.status === 403 && typeof body.remaining === "number") {
          gateMsg.textContent = "Invalid token. " + body.remaining + " attempt" + (body.remaining === 1 ? "" : "s") + " left before this session is destroyed.";
        } else if (res.status === 409) {
          gateMsg.textContent = "This token was already used. If that was not you, tell the fleet admin: the link may have leaked.";
        } else if (res.status === 410) {
          gateMsg.textContent = "This session has ended.";
        } else {
          gateMsg.textContent = "Could not open: " + (body.error || res.status);
        }
      });
    }).catch(function () { gateMsg.textContent = "Network error."; });
  });

  function connect(probe) {
    var proto = location.protocol === "https:" ? "wss://" : "ws://";
    var opened = false;
    // One live connection at a time: a new connect() supersedes the previous
    // one, and every callback below is fenced on `conn` so a stale socket's
    // events can never touch the current state (a pending cookie probe while
    // the user submits a token, or an old socket closing after a reconnect).
    if (ws && ws.readyState <= 1) { try { ws.close(); } catch (e) { /* ignore */ } }
    var conn = new WebSocket(proto + location.host + base + "/ws");
    ws = conn;
    conn.binaryType = "arraybuffer";
    conn.onopen = function () {
      if (ws !== conn) return;
      opened = true; reconnectAttempts = 0;
      gate.hidden = true; termEl.hidden = false; keys.hidden = false; closeBtn.hidden = false;
      if (!term) {
        term = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 2000, theme: { background: "#111" } });
        fit = new FitAddon.FitAddon();
        term.loadAddon(fit);
        term.loadAddon(new WebLinksAddon.WebLinksAddon());
        term.open(termEl);
        term.onData(function (s) { send(new TextEncoder().encode(s)); });
        term.onBinary(function (s) { var b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; send(b); });
        term.onResize(function (size) { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "resize", cols: size.cols, rows: size.rows })); });
        window.addEventListener("resize", function () { if (fit) fit.fit(); });
      } else {
        term.reset();                        // the server replays its buffer on (re)connect
      }
      fit.fit();
      term.focus();
    };
    conn.onmessage = function (ev) {
      if (ws !== conn) return;
      if (typeof ev.data === "string") {
        var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.t === "hello") {
          document.getElementById("title").textContent = "AgEnD · " + msg.kind + " · " + msg.backend;
          expiresAt = Date.now() + msg.ttlRemainingMs;
          if (ttlTimer) clearInterval(ttlTimer);   // exactly one countdown, however many reconnects
          ttlEl.hidden = false; tick(); ttlTimer = setInterval(tick, 1000);
          if (msg.truncated && term) term.writeln("\x1b[33m[earlier output truncated]\x1b[0m");
        } else if (msg.t === "exit") {
          finish(msg.ok, (msg.ok ? "Finished" : "Ended") + ": " + msg.detail + (typeof msg.exitCode === "number" ? " (exit " + msg.exitCode + ")" : ""));
        }
        return;
      }
      if (term) term.write(new Uint8Array(ev.data));
    };
    conn.onclose = function (ev) {
      if (ws !== conn || finished) return;
      if (!opened && probe) { gate.hidden = false; return; }   // initial cookie probe refused → token gate
      if (opened && ev.code === 4000) { finish(false, "Replaced by a newer connection."); return; }
      if (opened && (ev.code === 1000 || ev.code === 1001 || ev.code === 1008)) { finish(false, "Connection closed (" + (ev.reason || ev.code) + ")."); return; }
      // Transient drop, or a reconnect attempt that failed before opening: the
      // process is still running; keep trying within the TTL and the budget.
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (reconnectAttempts < 5 && Date.now() < expiresAt) {
      reconnectAttempts++;
      setTimeout(function () { if (!finished) connect(false); }, 500 * reconnectAttempts);
      return;
    }
    finish(false, "Connection lost.");
  }

  function send(bytes) { if (ws && ws.readyState === 1 && bytes.length) ws.send(bytes); }

  function tick() {
    var left = Math.max(0, expiresAt - Date.now());
    var m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    ttlEl.textContent = "closes in " + m + ":" + (s < 10 ? "0" : "") + s;
  }

  function finish(ok, text) {
    finished = true;
    if (ttlTimer) clearInterval(ttlTimer);
    doneEl.hidden = false; doneEl.className = ok ? "ok" : "bad"; doneEl.textContent = text;
    keys.hidden = true; closeBtn.hidden = true;
    if (term) term.options.disableStdin = true;
  }

  keys.addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-seq]");
    if (!b) return;
    send(new TextEncoder().encode(JSON.parse('"' + b.getAttribute("data-seq") + '"')));
    if (term) term.focus();
  });
  // Stop = end the session for real (server-side cancel), not just a Ctrl-C the CLI may ignore.
  closeBtn.addEventListener("click", function () { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "cancel" })); });
})();
