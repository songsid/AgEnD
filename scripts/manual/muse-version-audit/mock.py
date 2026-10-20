# Logging stand-in for muse's Meta provider (Responses-style SSE). Behaviour per request from /home/rh/audit/mockmode:
#   text (default) | tool (a muse.bash call; args from /home/rh/audit/mockargs) | 429 | 500
import json, sys, time, os
from http.server import BaseHTTPRequestHandler, HTTPServer
SENT = set()
LOG = "/home/rh/audit/mock.log"
def log(s):
    with open(LOG, "a") as f: f.write(s + "\n")
def mode():
    try: return open("/home/rh/audit/mockmode").read().strip() or "text"
    except Exception: return "text"
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    def log_message(self, *a): pass
    def _body(self):
        n = int(self.headers.get("content-length") or 0)
        return self.rfile.read(n) if n else b""
    def do_GET(self):
        log(f"GET {self.path}")
        if os.path.exists("/home/rh/audit/mockcatalog") and "models" in self.path:
            body = open("/home/rh/audit/mockcatalog", "rb").read()
            self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("connection", "close"); self.end_headers(); self.wfile.write(body); return
        self.send_response(404); self.send_header("connection", "close"); self.end_headers()
    def do_POST(self):
        raw = self._body()
        try: req = json.loads(raw)
        except Exception: req = {}
        tools = [t.get("name") or t.get("type") for t in req.get("tools", [])] if isinstance(req, dict) else []
        log(f"POST {self.path} model={req.get('model')} tools={tools[:12]} bytes={len(raw)}")
        with open("/home/rh/audit/mock-last-request.json", "wb") as f: f.write(raw)
        m = mode()
        if m in ("429", "402", "500", "401"):
            code = int(m)
            self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("connection", "close")
            if code == 429: self.send_header("retry-after", "2")
            self.end_headers(); self.wfile.write(json.dumps({"error": {"message": "Usage limit reached" if code==402 else "Too many requests" if code==429 else "audit failure", "type": "usage_limit_reached" if code==402 else "rate_limit_exceeded" if code==429 else "server_error"}}).encode()); return
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.send_header("connection", "close"); self.end_headers()
        rid = f"resp_{int(time.time()*1000)}"
        seq = [0]
        def ev(t, d):
            d["type"] = t
            d["sequence_number"] = seq[0]; seq[0] += 1
            self.wfile.write(f"event: {t}\ndata: {json.dumps(d)}\n\n".encode()); self.wfile.flush()
        ev("response.created", {"response": {"id": rid, "object": "response", "status": "in_progress", "model": "mock-model", "output": []}})
        inner = [x.get("name") for t in req.get("tools", []) for x in (t.get("tools") or [])] if isinstance(req, dict) else []
        # The reminder child's only tool is submit_reminder_decision; the main agent's namespace holds bash and the rest.
        reminder = "bash" not in inner
        log(f"  inner={inner[:8]} reminder={reminder}")
        if not reminder: open("/home/rh/audit/main-request.json", "w").write(json.dumps(req))
        key = req.get("prompt_cache_key")
        if m == "tool" and not reminder and key not in SENT:
            SENT.add(key)
            args = open("/home/rh/audit/mockargs").read() if os.path.exists("/home/rh/audit/mockargs") else json.dumps({"command": "echo hi"})
            name = open("/home/rh/audit/mocktool").read().strip() if os.path.exists("/home/rh/audit/mocktool") else "bash"
            item = {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": name, "namespace": "muse", "arguments": args, "status": "completed"}
            ev("response.output_item.added", {"output_index": 0, "item": {**item, "arguments": ""}})
            ev("response.function_call_arguments.delta", {"item_id": "fc_1", "output_index": 0, "delta": args})
            ev("response.function_call_arguments.done", {"item_id": "fc_1", "output_index": 0, "arguments": args})
            ev("response.output_item.done", {"output_index": 0, "item": item})
            out = [item]
        else:
            text = "mock reply ok"
            msg = {"type": "message", "id": "msg_1", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": text, "annotations": []}]}
            ev("response.output_item.added", {"output_index": 0, "item": {**msg, "content": [], "status": "in_progress"}})
            ev("response.content_part.added", {"item_id": "msg_1", "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}})
            ev("response.output_text.delta", {"item_id": "msg_1", "output_index": 0, "content_index": 0, "delta": text})
            ev("response.output_text.done", {"item_id": "msg_1", "output_index": 0, "content_index": 0, "text": text})
            ev("response.content_part.done", {"item_id": "msg_1", "output_index": 0, "content_index": 0, "part": msg["content"][0]})
            ev("response.output_item.done", {"output_index": 0, "item": msg})
            out = [msg]
        ev("response.completed", {"response": {"id": rid, "object": "response", "status": "completed", "model": "mock-model", "output": out, "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}})
HTTPServer(("127.0.0.1", 18800), H).serve_forever()
