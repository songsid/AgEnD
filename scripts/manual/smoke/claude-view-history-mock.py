"""Anthropic Messages stand-in for smoke-claude-view-history.mts (no account, no network). Scripts by keyword in the user's text:
  VHFIX  Read -> Grep -> Edit -> Bash (20 lines of output) -> a closing reply
  VHSLOW a reply streamed over ~30 s (busy)
  VHLONG a long multi-paragraph reply
otherwise "mock reply N". Every request is appended to requests.log."""
import json, sys, time, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
counter = [0]
WORK = os.environ["VH_WORK"]

def convo(body):
    msgs = body.get("messages") or []
    prompt, results = "", 0
    for m in msgs:
        if m.get("role") != "user": continue
        c = m.get("content")
        parts = [{"type": "text", "text": c}] if isinstance(c, str) else (c or [])
        texts = [p.get("text", "") for p in parts if p.get("type") == "text" and not p.get("text", "").startswith("<system-reminder>")]
        has_result = any(p.get("type") == "tool_result" for p in parts)
        if has_result: results += 1
        elif texts: prompt, results = texts[-1], 0
    return prompt, results

FIX = [
    ("tool", "Read", {"file_path": f"{WORK}/src/forecast.ts"}),
    ("tool", "Grep", {"pattern": "encodeURIComponent", "path": f"{WORK}/src"}),
    ("tool", "Edit", {"file_path": f"{WORK}/src/forecast.ts", "old_string": "  const url = `${BASE}/forecast?q=${city}`;", "new_string": "  const url = `${BASE}/forecast?q=${encodeURIComponent(city)}`;"}),
    ("tool", "Bash", {"command": "for i in $(seq 1 20); do echo \"test $i passed\"; done", "description": "Run the forecast tests"}),
    ("text", "Fixed: the city is now URL-encoded, so \"New York\" no longer breaks the query string. All 20 forecast tests pass."),
]

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        if self.path.startswith("/v1/models"):
            return self._json(200, {"data": [{"id": "claude-sonnet-4-5", "type": "model", "display_name": "Sonnet"}], "has_more": False})
        self._json(200, {})
    def do_HEAD(self):
        self.send_response(200); self.send_header("content-length", "0"); self.end_headers()
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        try: body = json.loads(self.rfile.read(n) if n else b"{}")
        except Exception: body = {}
        prompt, results = convo(body)
        with open(os.environ.get("VH_LOG", "requests.log"), "a") as f: f.write(json.dumps({"t": time.time(), "path": self.path, "prompt": prompt[-120:], "results": results}) + "\n")
        if "count_tokens" in self.path: return self._json(200, {"input_tokens": 100})
        if not self.path.startswith("/v1/messages"): return self._json(200, {})
        # Claude's side requests (titles, summaries) are not streamed with tools: answer them briefly.
        if not body.get("tools"):
            return self._json(200, {"id": "msg_side", "type": "message", "role": "assistant", "model": body.get("model"), "content": [{"type": "text", "text": "Forecast fix"}], "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 2}})
        counter[0] += 1
        delay, stop = 0.0, "end_turn"
        if "VHFIX" in prompt:
            step = FIX[min(results, len(FIX) - 1)]
            blocks = [step]; stop = "tool_use" if step[0] == "tool" else "end_turn"
            if results == 0: blocks = [("text", "I'll check how the city argument reaches the weather API."), step]
        elif "VHSLOW" in prompt and results == 0:
            blocks = [("text", "Working through it slowly. " * 30)]; delay = 0.25
        elif "VHLONG" in prompt and results == 0:
            blocks = [("text", "\n\n".join(f"Paragraph {i}: the forecast module builds a URL, sends it, and formats the answer; this is line {i} of a long explanation." for i in range(1, 9)))]
        else:
            blocks = [("text", f"mock reply {counter[0]}")]
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.send_header("cache-control", "no-cache"); self.send_header("connection", "close"); self.end_headers()
        def ev(name, obj): self.wfile.write(f"event: {name}\ndata: {json.dumps(obj)}\n\n".encode()); self.wfile.flush()
        ev("message_start", {"type": "message_start", "message": {"id": f"msg_{counter[0]}", "type": "message", "role": "assistant", "model": body.get("model"), "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 50, "output_tokens": 1}}})
        for i, b in enumerate(blocks):
            if b[0] == "text":
                ev("content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}})
                words = b[1].split(" ") if delay else [b[1]]
                for w in words:
                    ev("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": w + (" " if delay else "")}})
                    if delay: time.sleep(delay)
            else:
                ev("content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "tool_use", "id": f"toolu_{counter[0]}_{i}", "name": b[1], "input": {}}})
                ev("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "input_json_delta", "partial_json": json.dumps(b[2])}})
            ev("content_block_stop", {"type": "content_block_stop", "index": i})
        ev("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 5}})
        ev("message_stop", {"type": "message_stop"})
        self.close_connection = True

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
