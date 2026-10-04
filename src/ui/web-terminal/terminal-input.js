/*
 * The decisions the browser side of the AgEnD web terminal makes about input, as pure functions: no DOM, no xterm, no
 * socket, no logging. terminal.js wires them to the page; tests/web-terminal-input.test.ts runs this file as it is
 * served. A classic script (CSP: script-src 'self') that also exports itself for the tests.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.AgendTerminalInput = api;
})(this, function () {
  "use strict";

  /** What a sign-in code can be at most: far above any real one, far below the 4096-byte frame the server accepts. */
  var MAX_CODE_LENGTH = 1024;

  function isCopyKey(ev) {
    var key = String(ev && ev.key || "").toLowerCase();
    return key === "c" || (ev && ev.code === "KeyC");
  }

  /**
   * What to do with a key the terminal is about to turn into bytes.
   *   "copy"    leave it to the browser: there is a selection, and Ctrl/Cmd+C then means "copy it", not "interrupt"
   *   "swallow" send nothing: a login session is one command that a stray ^C kills (the Stop button cancels it)
   *   "pass"    let xterm handle it as it always did
   * Only Ctrl/Cmd+C is ever anything but "pass". With no selection a normal terminal keeps its ^C (`kind` other than
   * "login": an installer that is running must still be stoppable).
   */
  function classifyKey(ev, ctx) {
    if (!ev || !isCopyKey(ev) || ev.altKey || !(ev.ctrlKey || ev.metaKey)) return "pass";
    if (ctx && ctx.hasSelection) return "copy";
    if (ev.ctrlKey && !ev.metaKey && ctx && ctx.kind === "login") return "swallow";
    return "pass";
  }

  /** The login page has the sign-in code row, and no raw Ctrl-C button; every other kind of terminal is the other way round. */
  function showCodeRow(kind) { return kind === "login"; }
  function showCtrlCButton(kind) { return kind !== "login"; }

  /**
   * One submission of the sign-in code box. A code has no whitespace, so every run of it is dropped (a copy that wrapped
   * across lines, a trailing newline); what is left is sent ONCE as the code followed by Enter, and the box is cleared so a
   * second click, or a second Enter, has nothing to send. `send` receives a string and is called at most once.
   * The result never contains the code and nothing here logs: the code is a credential.
   */
  function submitCode(raw, send) {
    var code = String(raw == null ? "" : raw).replace(/\s+/g, "");
    if (code === "") return { sent: false, clear: false, notice: "empty" };
    if (code.length > MAX_CODE_LENGTH) return { sent: false, clear: false, notice: "too-long" };
    send(code + "\r");
    return { sent: true, clear: true, notice: "sent" };
  }

  /** Fixed wording for each `notice` (kept out of submitCode so the result carries no free text derived from the input). */
  var NOTICES = {
    empty: "Paste the code from the browser first.",
    "too-long": "That is far longer than a sign-in code — copy only the code.",
    sent: "Sent. The terminal does not show the code; wait for the result above."
  };

  return { classifyKey: classifyKey, showCodeRow: showCodeRow, showCtrlCButton: showCtrlCButton, submitCode: submitCode, NOTICES: NOTICES, MAX_CODE_LENGTH: MAX_CODE_LENGTH };
});
