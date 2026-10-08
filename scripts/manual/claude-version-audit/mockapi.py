"""Minimal Anthropic Messages API stand-in for driving the real Claude Code TUI.

Behaviour is chosen by a keyword in the last user text:
  SLOW     stream a reply over ~25 s (busy spinner)
  TOOLWAIT tool_use Bash `sleep 25` (the turn sits in a running tool)
  BASHPERM tool_use Bash `echo perm-check` (permission prompt when not bypassing)
  BGWORK   tool_use Bash `sleep 900` with run_in_background (background shell)
  E529     HTTP 529 overloaded            E401  HTTP 401
  E429     HTTP 429 rate limit            E500  HTTP 500
  BIG      reply with huge usage numbers (to make the session look large)
otherwise a short text reply. Every request is appended to requests.log.
"""
import json, sys, time, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = os.environ.get("MOCK_LOG", "requests.log")
counter = [0]


def last_user_text(body):
    msgs = body.get("messages") or []
    for m in reversed(msgs):
        if m.get("role") != "user":
            continue
        c = m.get("content")
        if isinstance(c, str):
            return c, False
        texts, tool_result = [], False
        for part in c or []:
            if part.get("type") == "text":
                texts.append(part.get("text", ""))
            if part.get("type") == "tool_result":
                tool_result = True
        return (texts[-1] if texts else ""), tool_result
    return "", False


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/v1/models"):
            return self._json(200, {"data": [{"id": "claude-sonnet-4-5", "type": "model", "display_name": "Sonnet"}], "has_more": False})
        self._json(200, {})

    def do_HEAD(self):
        self.send_response(200); self.send_header("content-length", "0"); self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw)
        except Exception:
            body = {}
        text, tool_result = last_user_text(body)
        with open(LOG, "a") as f:
            f.write(json.dumps({"t": time.time(), "path": self.path, "stream": body.get("stream"), "max_tokens": body.get("max_tokens"), "last": text[-200:], "tool_result": tool_result}) + "\n")
        if "count_tokens" in self.path:
            return self._json(200, {"input_tokens": 100})
        if not self.path.startswith("/v1/messages"):
            return self._json(200, {})
        for kw, code, etype in (("E529", 529, "overloaded_error"), ("E401", 401, "authentication_error"), ("E429", 429, "rate_limit_error"), ("E500", 500, "api_error")):
            if kw in text and not tool_result:
                return self._json(code, {"type": "error", "error": {"type": etype, "message": f"mock {etype}"}})
        counter[0] += 1
        blocks = []
        stop = "end_turn"
        delay = 0.0
        usage_in = 50
        if tool_result:
            blocks = [("text", "tool finished")]
        elif "BASHPERM" in text:
            blocks = [("tool", {"command": "touch perm-probe.txt", "description": "Create a marker file"})]; stop = "tool_use"
        elif "DANGER" in text:
            blocks = [("tool", {"command": "bash -c 'rm -rf \"$(echo /tmp/agend-safe-probe)\"/*'", "description": "cleanup"})]; stop = "tool_use"
        elif "BGWORK" in text:
            blocks = [("tool", {"command": "sleep 900", "description": "Long background sleep", "run_in_background": True})]; stop = "tool_use"
        elif "TOOLWAIT" in text:
            blocks = [("tool", {"command": "sleep 25; echo waited", "description": "Wait 25 seconds"})]; stop = "tool_use"
        elif "QUOTEMARK" in text:
            blocks = [("quote", None)]
        elif "SLOW" in text:
            blocks = [("text", "slow " * 50)]; delay = 0.5
        elif "HUGE" in text:
            blocks = [("text", ("lorem ipsum dolor sit amet " * 12000) + f"end {counter[0]}")]; usage_in = 150000
        elif "BIG" in text:
            blocks = [("text", "big reply")]; usage_in = 180000
        else:
            blocks = [("text", f"mock reply {counter[0]}")]
        if not body.get("stream"):
            content = []
            for kind, val in blocks:
                content.append({"type": "text", "text": val} if kind == "text" else {"type": "tool_use", "id": f"toolu_{counter[0]}", "name": "Bash", "input": val})
            return self._json(200, {"id": f"msg_{counter[0]}", "type": "message", "role": "assistant", "model": body.get("model", "claude-sonnet-4-5"), "content": content, "stop_reason": stop, "stop_sequence": None, "usage": {"input_tokens": usage_in, "output_tokens": 5}})
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()

        def ev(name, obj):
            self.wfile.write(f"event: {name}\ndata: {json.dumps(obj)}\n\n".encode()); self.wfile.flush()

        ev("message_start", {"type": "message_start", "message": {"id": f"msg_{counter[0]}", "type": "message", "role": "assistant", "model": body.get("model", "claude-sonnet-4-5"), "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": usage_in, "output_tokens": 1}}})
        for i, (kind, val) in enumerate(blocks):
            if kind == "quote":
                ev("content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}})
                ev("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": "The hint reads:\n\nctrl+x ctrl+s to send now\n\n"}})
                time.sleep(30)
                ev("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": "done."}})
            elif kind == "text":
                ev("content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}})
                words = val.split(" ") if delay else [val]
                for w in words:
                    ev("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": w + (" " if delay else "")}})
                    if delay:
                        time.sleep(delay)
            else:
                ev("content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "tool_use", "id": f"toolu_{counter[0]}", "name": "Bash", "input": {}}})
                ev("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "input_json_delta", "partial_json": json.dumps(val)}})
            ev("content_block_stop", {"type": "content_block_stop", "index": i})
        ev("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 5}})
        ev("message_stop", {"type": "message_stop"})
        self.close_connection = True


if __name__ == "__main__":
    port = int(sys.argv[1])
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
