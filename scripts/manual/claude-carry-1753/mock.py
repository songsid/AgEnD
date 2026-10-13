# #1753 probe: a minimal Anthropic Messages mock. It answers with how many messages it got and whether the word
# PELICAN (said in an earlier turn) is among them, and logs the same to the file given. Args: <port> <log file>.
import json, sys, http.server, threading
LOG = open(sys.argv[2], "a")
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(404); self.end_headers()
    def do_POST(self):
        n = int(self.headers.get("content-length", 0)); body = json.loads(self.rfile.read(n) or b"{}")
        if not self.path.startswith("/v1/messages") or "count_tokens" in self.path:
            self.send_response(200); self.send_header("content-type","application/json"); self.end_headers()
            self.wfile.write(json.dumps({"input_tokens": 10}).encode()); return
        msgs = body.get("messages", [])
        text_all = json.dumps(msgs)
        users = [m for m in msgs if m.get("role") == "user"]
        LOG.write(json.dumps({"n_messages": len(msgs), "has_pelican": "PELICAN" in text_all, "model": body.get("model"), "stream": body.get("stream")}) + "\n"); LOG.flush()
        reply = f"I see {len(msgs)} messages; PELICAN seen={'PELICAN' in text_all}"
        if not body.get("stream"):
            self.send_response(200); self.send_header("content-type","application/json"); self.end_headers()
            self.wfile.write(json.dumps({"id":"msg_1","type":"message","role":"assistant","model":body.get("model"),"content":[{"type":"text","text":reply}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":5}}).encode()); return
        self.send_response(200); self.send_header("content-type","text/event-stream"); self.end_headers()
        def ev(t, d): self.wfile.write(f"event: {t}\ndata: {json.dumps(d)}\n\n".encode())
        ev("message_start", {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":body.get("model"),"content":[],"stop_reason":None,"usage":{"input_tokens":10,"output_tokens":1}}})
        ev("content_block_start", {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}})
        ev("content_block_delta", {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":reply}})
        ev("content_block_stop", {"type":"content_block_stop","index":0})
        ev("message_delta", {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}})
        ev("message_stop", {"type":"message_stop"})
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
