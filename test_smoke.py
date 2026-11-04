"""End to end API check. Starts the server on a scratch database and walks the learner flow."""
import http.cookiejar
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Client:
    def __init__(self, base):
        self.base = base
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, method, path, body=None, expect=200):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with self.opener.open(req) as r:
                status, raw = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        assert status == expect, f"{method} {path}: {status} {raw[:200]!r}"
        return json.loads(raw) if raw.startswith(b"{") else raw


def correct_answers(questions):
    out = {}
    for q in questions:
        out[q["id"]] = q["answer"][0] if q["type"] == "gap" else q["answer"]
    return out


def main():
    tmp = tempfile.mkdtemp()
    port = free_port()
    env = dict(os.environ, FA_DB=os.path.join(tmp, "t.db"), FA_PORT=str(port), FA_INVITE="letmein")
    env.pop("ANTHROPIC_API_KEY", None)
    srv = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py")], env=env, cwd=ROOT,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        c = Client(f"http://127.0.0.1:{port}")
        html = c.call("GET", "/")
        assert b"French Academy" in html
        assert b"French Academy" in c.call("GET", "/../store.py")  # SPA fallback, no traversal
        c.call("GET", "/api/me", expect=401)
        c.call("POST", "/api/register", {"username": "ab", "password": "12345678", "invite": "letmein"}, expect=400)
        c.call("POST", "/api/register", {"username": "tham_test", "password": "secret123", "invite": "letmein"})
        c.call("POST", "/api/register", {"username": "tham_test", "password": "secret123", "invite": "letmein"}, expect=400)
        c.call("POST", "/api/register", {"username": "no_invite", "password": "secret123"}, expect=403)
        me = c.call("GET", "/api/me")
        assert me["ai"]["mock"] is True and me["profile"]["onboarded"] == 0
        c.call("PUT", "/api/profile", {"display_name": "Tham", "daily_minutes": 240, "target_level": "C1"})
        assert c.call("GET", "/api/me")["profile"]["daily_minutes"] == 240

        # diagnostic: all correct, self rating for productive skills
        diag = json.load(open(os.path.join(ROOT, "content", "diagnostic.json"), encoding="utf-8"))
        answers = {}
        for s in diag["sections"]:
            answers.update(correct_answers(s["questions"]))
        r = c.call("POST", "/api/diagnostic", {"answers": answers, "self_rating": {"speaking": 30, "writing": 55}})
        assert r["scores"]["listening"] == 100 and r["scores"]["reading"] == 100, r["scores"]
        assert r["skill_scores"]["speaking"] == 30 and r["weak_skills"][0] == "speaking", r
        assert r["level"] == "B1"
        d = c.call("GET", "/api/dashboard")
        assert d["diagnostic_done"] and d["skills"]["speaking"]["last_score"] == 30
        assert d["cefr"]["skills"]["speaking"]["confidence"] == "none"  # self rating carries no level

        # lesson, exercise with mistakes, quiz passed
        les = c.call("GET", "/api/lessons/b1-w1-l1")
        assert "answer" not in les["sections"][3]["questions"][0]
        full = json.load(open(os.path.join(ROOT, "content", "lessons", "b1-w1-l1.json"), encoding="utf-8"))
        ex_idx = next(i for i, s in enumerate(full["sections"]) if s["type"] == "exercise")
        quiz_idx = next(i for i, s in enumerate(full["sections"]) if s["type"] == "quiz")
        wrong = {q["id"]: "xxx" for q in full["sections"][ex_idx]["questions"]}
        r = c.call("POST", "/api/attempts", {"lesson_id": "b1-w1-l1", "section_idx": ex_idx, "answers": wrong})
        assert r["score"] == 0 and r["completed"] is None
        r = c.call("POST", "/api/attempts", {"lesson_id": "b1-w1-l1", "section_idx": quiz_idx,
                                               "answers": correct_answers(full["sections"][quiz_idx]["questions"])})
        assert r["pct"] == 100 and r["completed"] is True
        c.call("POST", "/api/lessons/b1-w1-l1/progress", {"section_idx": 5})
        les = c.call("GET", "/api/lessons/b1-w1-l1")
        assert les["progress"]["status"] == "completed" and les["progress"]["section_idx"] == 5
        path = c.call("GET", "/api/path")
        assert path["next"]["id"] != "b1-w1-l1"
        an = c.call("GET", "/api/analytics")
        cats = {g["category"] for g in an["grammar"]}
        assert "passe_compose_imparfait" in cats, cats
        assert any(x["category"] == "passe_compose_imparfait" and x["lesson_id"] for x in an["remediation"])
        drill = c.call("GET", "/api/drill?category=passe_compose_imparfait")
        assert drill["questions"] and "answer" not in drill["questions"][0]
        q0 = drill["questions"][0]
        r = c.call("POST", "/api/attempts", {"lesson_id": q0["lesson_id"], "section_idx": q0["section_idx"],
                                               "answers": {q0["id"]: "zzz"}, "question_ids": [q0["id"]]})
        assert r["max"] == 1 and r["completed"] is None

        # time, vocab, labs, tutor
        c.call("POST", "/api/study", {"activity": "speaking", "skill": "speaking", "seconds": 1800})
        c.call("POST", "/api/study", {"activity": "bogus", "seconds": 10}, expect=400)
        assert c.call("GET", "/api/dashboard")["hours"] == 0.5
        plan = c.call("GET", "/api/plan")
        assert next(i for i in plan["items"] if i["activity"] == "speaking")["done_minutes"] == 30
        vid = c.call("POST", "/api/vocab", {"word": "autrefois", "translation": "ngày xưa"})["id"]
        c.call("POST", "/api/vocab", {"word": "autrefois", "translation": ""})  # upsert keeps translation
        assert c.call("GET", "/api/vocab?filter=all")["items"][0]["translation"] == "ngày xưa"
        assert c.call("POST", f"/api/vocab/{vid}/review", {"grade": 2})["status"] == "learning"
        sp = c.call("POST", "/api/speaking", {"topic": "Test", "duration_s": 42, "transcript": "Autrefois je jouais au foot.",
                                               "audio_b64": "AAAA"})
        assert sp["feedback"]["mock"] is True and sp["feedback"]["scores"] is None
        items = c.call("GET", "/api/speaking")["items"]
        assert items[0]["has_audio"] == 1 and c.call("GET", f"/api/audio/{items[0]['id']}")
        assert c.call("GET", "/api/vocab?filter=active")["items"][0]["used_speaking"] == 1
        wr = c.call("POST", "/api/writing", {"topic": "Test", "body": "Hier je suis allé au marché et j'ai acheté des pommes."})
        assert wr["feedback"]["mock"] is True
        t = c.call("POST", "/api/tutor", {"mode": "grammar", "message": "Quand utiliser le subjonctif ?"})
        assert "MÔ PHỎNG" in t["reply"]
        assert len(c.call("GET", "/api/tutor?mode=grammar")["messages"]) == 2
        c.call("POST", "/api/tutor", {"mode": "nope", "message": "x"}, expect=400)
        # no assessment should exist for mock speaking/writing
        an = c.call("GET", "/api/analytics")
        assert an["skills"]["speaking"]["submissions"] == 1 and an["skills"]["speaking"]["last_score"] == 30

        # reports, notes, resources, exam, prompts
        wk = c.call("GET", "/api/report/weekly")
        assert wk["minutes"] == 30 and wk["lessons_completed"] == 1 and wk["top_errors"]
        c.call("GET", "/api/report/weekly?week=bad", expect=400)
        mo = c.call("GET", "/api/report/monthly")
        assert mo["lessons_completed"] == 1
        nid = c.call("PUT", "/api/notes", {"lesson_id": "b1-w1-l1", "body": "note 1"})["id"]
        c.call("PUT", "/api/notes", {"lesson_id": "b1-w1-l1", "body": "note 2"})
        notes = c.call("GET", "/api/notes")["notes"]
        assert len(notes) == 1 and notes[0]["body"] == "note 2"
        c.call("DELETE", f"/api/notes/{nid}")
        assert c.call("GET", "/api/notes")["notes"] == []
        assert c.call("GET", "/api/resources")["items"]
        assert c.call("GET", "/api/exam")["oral_tasks"]
        assert c.call("GET", "/api/prompts")["speaking"]
        cur = c.call("GET", "/api/curriculum")
        assert cur["phases"][0]["modules"][1]["completed"] == 1
        c.call("POST", "/api/logout", {})
        c.call("GET", "/api/me", expect=401)
        print("SMOKE OK")
    finally:
        srv.terminate()
        out = srv.communicate(timeout=5)[0].decode(errors="replace")
        if "Traceback" in out:
            print(out)
            raise SystemExit("server logged a traceback")


if __name__ == "__main__":
    main()
