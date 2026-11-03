"""Drives tutor._call through the real SDK against a local stub of the Messages API.
Checks the DeepSeek path (schema in prompt, fenced JSON parsed, bad reply rejected)
and the Anthropic path (structured output and fallback fields sent). Skips without the SDK."""
import importlib
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import anthropic  # noqa: F401
except ImportError:
    print("SKIP: anthropic SDK not installed")
    sys.exit(0)

REQUESTS, REPLIES = [], []


class Stub(BaseHTTPRequestHandler):
    def do_POST(self):
        REQUESTS.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
        body = json.dumps({"id": "msg_1", "type": "message", "role": "assistant", "model": "stub",
                           "content": [{"type": "text", "text": REPLIES.pop(0)}],
                           "stop_reason": "end_turn", "stop_sequence": None,
                           "usage": {"input_tokens": 1, "output_tokens": 1}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


srv = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
threading.Thread(target=srv.serve_forever, daemon=True).start()
port = srv.server_address[1]
os.environ["ANTHROPIC_API_KEY"] = "test-key"
os.environ["ANTHROPIC_MAX_RETRIES"] = "0"
prof = {"current_level": "B1", "target_level": "C1", "explain_lang": "vi"}
good = {"reply": "Bien.", "errors": [{"category": "subjonctif", "original": "que tu es", "correction": "que tu sois",
                                       "explanation": "après il faut"}], "vocab": []}

# DeepSeek path: base url contains "deepseek", schema goes in the prompt, fenced JSON is parsed.
os.environ["ANTHROPIC_BASE_URL"] = f"http://127.0.0.1:{port}/deepseek"
os.environ.pop("FA_MODEL", None)
import tutor
importlib.reload(tutor)
assert tutor.DEEPSEEK and tutor.MODEL == "deepseek-flash" and tutor.status()["provider"] == "deepseek"
REPLIES.append("Voici la réponse :\n```json\n" + json.dumps(good, ensure_ascii=False) + "\n```")
out = tutor.chat("grammar", [], "Il faut que tu es là.", prof)
assert out["reply"] == "Bien." and out["errors"][0]["category"] == "subjonctif" and out["mock"] is False
req = REQUESTS[-1]
assert req["model"] == "deepseek-flash" and "fallbacks" not in req and "format" not in req["output_config"]
assert "schéma JSON" in req["system"][0]["text"] and '"required": ["reply", "errors", "vocab"]' in req["system"][0]["text"]

for bad, want in [({"reply": "x", "vocab": []}, "thiếu trường $.errors"),
                  ({"reply": "x", "errors": [{"category": "nope", "original": "", "correction": "", "explanation": ""}],
                    "vocab": []}, "ngoài danh sách"),
                  ({"reply": 5, "errors": [], "vocab": []}, "sai kiểu tại $.reply"),
                  ("pas de json", "không đọc được")]:
    REPLIES.append(bad if isinstance(bad, str) else json.dumps(bad))
    try:
        tutor.chat("grammar", [], "x", prof)
        raise AssertionError(f"accepted bad reply {bad}")
    except tutor.TutorError as e:
        assert want in str(e), (want, str(e))

# Anthropic path: structured output and server-side fallback are sent, model default is Claude.
os.environ["ANTHROPIC_BASE_URL"] = f"http://127.0.0.1:{port}/anthropic"
importlib.reload(tutor)
assert not tutor.DEEPSEEK and tutor.MODEL == "claude-opus-5-5"
REPLIES.append(json.dumps(good))
out = tutor.chat("grammar", [], "x", prof)
assert out["errors"][0]["correction"] == "que tu sois"
req = REQUESTS[-1]
assert req["fallbacks"] == "default" and req["output_config"]["format"]["type"] == "json_schema"
assert "schéma JSON" not in req["system"][0]["text"]
srv.shutdown()
print("TUTOR OK")
