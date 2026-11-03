"""French Academy B1 to C1: HTTP server and API. Standard library only."""
import base64
import json
import mimetypes
import os
import re
import sys
import time
import traceback
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import analytics
import store
import tutor
from store import ERROR_CATEGORIES, SKILLS, now

STATIC = os.path.join(store.ROOT, "static")
AUDIO_DIR = os.path.join(os.path.dirname(store.DB_PATH), "audio")
MAX_BODY = 12 * 1024 * 1024
MAX_TEXT = 20000
TUTOR_MODES = ("grammar", "vocab", "speaking", "writing", "examiner")


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def need(body, key, typ, maxlen=MAX_TEXT, optional=False):
    v = body.get(key)
    if v is None:
        if optional:
            return None
        raise ApiError(400, f"Thiếu trường {key}")
    if typ is int and isinstance(v, bool) or not isinstance(v, typ):
        raise ApiError(400, f"Trường {key} sai kiểu")
    if isinstance(v, str) and len(v) > maxlen:
        raise ApiError(400, f"Trường {key} quá dài")
    return v


# handlers: (con, user, prof, params, body, query) -> json-able

def h_register(con, user, prof, p, body, q):
    username = need(body, "username", str, 64)
    password = need(body, "password", str, 256)
    try:
        uid = store.create_user(con, username, password)
    except ValueError as e:
        raise ApiError(400, str(e))
    token = store.open_session(con, uid)
    return {"ok": True, "username": username}, token


def h_login(con, user, prof, p, body, q):
    username = need(body, "username", str, 64)
    password = need(body, "password", str, 256)
    uid = store.check_login(con, username, password)
    if not uid:
        time.sleep(0.5)
        raise ApiError(401, "Sai tên đăng nhập hoặc mật khẩu")
    return {"ok": True, "username": username}, store.open_session(con, uid)


def h_logout(con, user, prof, p, body, q):
    con.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
    return {"ok": True}, ""


def h_me(con, user, prof, p, body, q):
    return {"user": {"id": user["id"], "username": user["username"]}, "profile": prof,
            "ai": tutor.status()}


def h_profile(con, user, prof, p, body, q):
    name = need(body, "display_name", str, 80, optional=True)
    target = need(body, "target_level", str, 2, optional=True)
    level = need(body, "current_level", str, 2, optional=True)
    mins = need(body, "daily_minutes", int, optional=True)
    lang = need(body, "explain_lang", str, 2, optional=True)
    goals = need(body, "goals", str, 2000, optional=True)
    if target and target not in store.LEVELS or level and level not in store.LEVELS:
        raise ApiError(400, "Trình độ không hợp lệ")
    if mins is not None and not 30 <= mins <= 600:
        raise ApiError(400, "Thời gian học mỗi ngày: 30 đến 600 phút")
    if lang and lang not in ("vi", "fr"):
        raise ApiError(400, "Ngôn ngữ giải thích: vi hoặc fr")
    sets = {"display_name": name, "target_level": target, "current_level": level,
            "daily_minutes": mins, "explain_lang": lang, "goals": goals, "onboarded": 1}
    sets = {k: v for k, v in sets.items() if v is not None}
    con.execute("UPDATE profiles SET " + ", ".join(f"{k}=?" for k in sets) + " WHERE user_id=?",
                (*sets.values(), user["id"]))
    return {"profile": store.profile(con, user["id"])}


def h_diagnostic_get(con, user, prof, p, body, q):
    d = store.read_json("diagnostic.json")
    return {"sections": [store.strip_answers(s) for s in d["sections"]],
            "writing": d["writing"], "speaking": d["speaking"], "self_rating": d["self_rating"],
            "ai": tutor.status()}


def h_diagnostic_post(con, user, prof, p, body, q):
    d = store.read_json("diagnostic.json")
    answers = need(body, "answers", dict)
    self_rating = need(body, "self_rating", dict, optional=True) or {}
    writing = need(body, "writing", str, optional=True) or ""
    transcript = need(body, "speaking_transcript", str, optional=True) or ""
    uid = user["id"]
    scores = {}
    all_results = []
    for s in d["sections"]:
        sc, mx, res = store.grade(s["questions"], answers)
        scores[s["skill"]] = round(100 * sc / mx)
        all_results += res
    cur = con.execute("INSERT INTO attempts (user_id, lesson_id, kind, skill, score, max_score, answers, created_at)"
                      " VALUES (?,?,?,?,?,?,?,?)",
                      (uid, None, "diagnostic", None, sum(r["ok"] for r in all_results), len(all_results),
                       json.dumps(answers), now()))
    ref = cur.lastrowid
    record_errors(con, uid, all_results, "diagnostic", ref)
    skill_scores = {}
    for s in ("listening", "reading"):
        if s in scores:
            lvl = "B1" if scores[s] >= 70 else "A2"
            add_assessment(con, uid, s, scores[s], lvl, "diagnostic", ref)
            skill_scores[s] = scores[s]
    feedback = {}
    for s, text in (("writing", writing), ("speaking", transcript)):
        fb = None
        if text.strip() and tutor.configured():
            try:
                fb = (tutor.assess_writing(text, d["writing"]["prompt"], prof) if s == "writing"
                      else tutor.assess_speaking(text, d["speaking"]["prompt"], 60, prof))
            except tutor.TutorError as e:
                fb = {"error": e.message if hasattr(e, "message") else str(e)}
        if fb and fb.get("scores"):
            add_assessment(con, uid, s, fb["scores"]["overall"], fb["level_estimate"], f"ai_{s}", ref)
            record_ai_errors(con, uid, fb["errors"], f"ai_{s}", ref)
            skill_scores[s] = fb["scores"]["overall"]
        elif isinstance(self_rating.get(s), int) and 0 <= self_rating[s] <= 100:
            add_assessment(con, uid, s, self_rating[s], None, "self", ref)
            skill_scores[s] = self_rating[s]
        feedback[s] = fb
    ranked = sorted(skill_scores, key=lambda k: skill_scores[k])
    weak, strong = ranked[:2], ranked[-1:] if len(ranked) > 2 else []
    known = [scores.get("grammar"), scores.get("vocab"), scores.get("reading"), scores.get("listening")]
    known = [x for x in known if x is not None]
    level = "B1" if known and sum(known) / len(known) >= 50 else "A2"
    con.execute("UPDATE profiles SET weak_skills=?, strong_skills=?, diagnostic_at=?, current_level=?, onboarded=1"
                " WHERE user_id=?", (json.dumps(weak), json.dumps(strong), now(), level, uid))
    return {"scores": scores, "skill_scores": skill_scores, "weak_skills": weak, "level": level,
            "results": all_results, "feedback": feedback,
            "note": "Kết quả nghe và đọc đến từ bài trắc nghiệm B1. Nói và viết: do AI chấm nếu đã cấu hình,"
                    " nếu không thì lấy tự đánh giá của bạn (độ tin cậy thấp)."}


def add_assessment(con, uid, skill, score, level, source, ref):
    con.execute("INSERT INTO skill_assessments (user_id, skill, score, level_estimate, source, ref_id, created_at)"
                " VALUES (?,?,?,?,?,?,?)", (uid, skill, score, level, source, ref, now()))


def record_errors(con, uid, results, source, ref):
    for r in results:
        if not r["ok"] and r.get("error_tag"):
            con.execute("INSERT INTO grammar_errors (user_id, category, original, correction, explanation, source, ref_id, created_at)"
                        " VALUES (?,?,?,?,?,?,?,?)",
                        (uid, r["error_tag"], str(r["given"] or ""), str(r["answer"]), r["explain"], source, ref, now()))


def record_ai_errors(con, uid, errors, source, ref):
    for e in errors or []:
        cat = e.get("category") if e.get("category") in ERROR_CATEGORIES else "autre"
        con.execute("INSERT INTO grammar_errors (user_id, category, original, correction, explanation, source, ref_id, created_at)"
                    " VALUES (?,?,?,?,?,?,?,?)",
                    (uid, cat, e.get("original", "")[:500], e.get("correction", "")[:500],
                     e.get("explanation", "")[:1000], source, ref, now()))


def h_dashboard(con, user, prof, p, body, q):
    return analytics.dashboard(con, user["id"], prof)


def h_path(con, user, prof, p, body, q):
    return analytics.path(con, user["id"], prof)


def h_plan(con, user, prof, p, body, q):
    return analytics.today_plan(con, user["id"], prof)


def h_curriculum(con, user, prof, p, body, q):
    cur = store.read_json("curriculum.json")
    rows = analytics.lesson_rows(con, user["id"])
    for ph in cur["phases"]:
        for m in ph["modules"]:
            ls = [r for r in rows if r["phase"] == ph["phase"] and r["module"] == m["name"]]
            m["lessons"] = ls
            m["completed"] = sum(1 for r in ls if r["status"] == "completed")
    return cur


def h_lesson(con, user, prof, p, body, q):
    d = store.lesson(con, p["id"])
    if not d:
        raise ApiError(404, "Không có bài học này")
    uid = user["id"]
    prog = con.execute("SELECT * FROM lesson_progress WHERE user_id=? AND lesson_id=?", (uid, p["id"])).fetchone()
    if not prog:
        con.execute("INSERT INTO lesson_progress (user_id, lesson_id, started_at) VALUES (?,?,?)", (uid, p["id"], now()))
        prog = con.execute("SELECT * FROM lesson_progress WHERE user_id=? AND lesson_id=?", (uid, p["id"])).fetchone()
    out = {k: v for k, v in d.items() if k != "sections"}
    out["sections"] = [store.strip_answers(s) for s in d["sections"]]
    out["progress"] = dict(prog)
    out["attempts"] = [dict(r) for r in con.execute(
        "SELECT id, kind, skill, score, max_score, created_at FROM attempts WHERE user_id=? AND lesson_id=? ORDER BY id DESC LIMIT 20",
        (uid, p["id"])).fetchall()]
    out["note"] = (con.execute("SELECT body FROM notes WHERE user_id=? AND lesson_id=?", (uid, p["id"])).fetchone() or {"body": ""})["body"]
    return out


def h_lesson_progress(con, user, prof, p, body, q):
    idx = need(body, "section_idx", int, optional=True)
    status = need(body, "status", str, 20, optional=True)
    if status and status not in ("in_progress", "completed", "review"):
        raise ApiError(400, "status không hợp lệ")
    uid = user["id"]
    if idx is not None:
        con.execute("UPDATE lesson_progress SET section_idx=? WHERE user_id=? AND lesson_id=?", (idx, uid, p["id"]))
    if status:
        con.execute("UPDATE lesson_progress SET status=?, completed_at=COALESCE(completed_at, ?) WHERE user_id=? AND lesson_id=?",
                    (status, now() if status == "completed" else None, uid, p["id"]))
    return {"ok": True}


def h_attempt(con, user, prof, p, body, q):
    lesson_id = need(body, "lesson_id", str, 64)
    section_idx = need(body, "section_idx", int)
    answers = need(body, "answers", dict)
    d = store.lesson(con, lesson_id)
    if not d or not 0 <= section_idx < len(d["sections"]):
        raise ApiError(404, "Không có bài hoặc phần này")
    section = d["sections"][section_idx]
    if "questions" not in section:
        raise ApiError(400, "Phần này không có câu hỏi")
    uid = user["id"]
    questions = section["questions"]
    qids = need(body, "question_ids", list, optional=True)
    kind = section["type"]
    if qids:
        questions = [q for q in questions if q["id"] in qids]
        if not questions:
            raise ApiError(400, "question_ids không khớp")
        kind = "drill"
    sc, mx, results = store.grade(questions, answers)
    skill = d["skill"] if d["skill"] in SKILLS else None
    if kind in ("listening", "reading"):
        skill = kind
    cur = con.execute("INSERT INTO attempts (user_id, lesson_id, kind, skill, score, max_score, answers, created_at)"
                      " VALUES (?,?,?,?,?,?,?,?)", (uid, lesson_id, kind, skill, sc, mx, json.dumps(answers), now()))
    ref = cur.lastrowid
    pct = round(100 * sc / mx)
    record_errors(con, uid, results, f"{kind}:{d['skill']}", ref)
    if kind in ("listening", "reading") or (kind == "quiz" and skill in ("listening", "reading")):
        add_assessment(con, uid, skill, pct, d["level"] if pct >= 70 else None, f"quiz_{skill}", ref)
    completed = None
    if kind == "quiz":
        status = "completed" if pct >= analytics.PASS_SCORE else "review"
        con.execute("UPDATE lesson_progress SET status=?, best_score=MAX(COALESCE(best_score,0),?),"
                    " completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at, ?) ELSE completed_at END"
                    " WHERE user_id=? AND lesson_id=?", (status, pct, status, now(), uid, lesson_id))
        completed = status == "completed"
    return {"score": sc, "max": mx, "pct": pct, "results": results, "completed": completed}


def h_study(con, user, prof, p, body, q):
    activity = need(body, "activity", str, 20)
    seconds = need(body, "seconds", int)
    skill = need(body, "skill", str, 20, optional=True)
    lesson_id = need(body, "lesson_id", str, 64, optional=True)
    if activity not in store.ACTIVITIES:
        raise ApiError(400, "activity không hợp lệ")
    if skill and skill not in SKILLS:
        skill = None
    if not 1 <= seconds <= 3600:
        raise ApiError(400, "seconds: 1 đến 3600")
    if lesson_id:
        con.execute("UPDATE lesson_progress SET seconds=seconds+? WHERE user_id=? AND lesson_id=?", (seconds, user["id"], lesson_id))
    con.execute("INSERT INTO study_sessions (user_id, activity, skill, lesson_id, seconds, created_at) VALUES (?,?,?,?,?,?)",
                (user["id"], activity, skill, lesson_id, seconds, now()))
    return {"ok": True}


def h_notes_get(con, user, prof, p, body, q):
    rows = con.execute("SELECT n.*, l.title FROM notes n LEFT JOIN lessons l ON l.id=n.lesson_id WHERE n.user_id=? ORDER BY n.updated_at DESC",
                       (user["id"],)).fetchall()
    return {"notes": [dict(r) for r in rows]}


def h_notes_put(con, user, prof, p, body, q):
    lesson_id = need(body, "lesson_id", str, 64, optional=True)
    text = need(body, "body", str, 20000)
    uid = user["id"]
    row = con.execute("SELECT id FROM notes WHERE user_id=? AND lesson_id IS ?", (uid, lesson_id)).fetchone()
    if row:
        con.execute("UPDATE notes SET body=?, updated_at=? WHERE id=?", (text, now(), row["id"]))
        nid = row["id"]
    else:
        nid = con.execute("INSERT INTO notes (user_id, lesson_id, body, updated_at) VALUES (?,?,?,?)",
                          (uid, lesson_id, text, now())).lastrowid
    return {"id": nid}


def h_note_delete(con, user, prof, p, body, q):
    con.execute("DELETE FROM notes WHERE id=? AND user_id=?", (int(p["id"]), user["id"]))
    return {"ok": True}


def h_vocab_get(con, user, prof, p, body, q):
    f = (q.get("filter") or ["all"])[0]
    uid = user["id"]
    where = {"due": "AND due_at<=? AND status!='new'", "new": "AND status='new'", "known": "AND status='known'",
             "learning": "AND status='learning'", "active": "AND (used_speaking=1 OR used_writing=1)"}.get(f, "")
    args = [uid] + ([now()] if f == "due" else [])
    rows = con.execute(f"SELECT * FROM vocabulary WHERE user_id=? {where} ORDER BY due_at LIMIT 300", args).fetchall()
    return {"items": [dict(r) for r in rows], "stats": analytics.vocab_stats(con, uid)}


def h_vocab_post(con, user, prof, p, body, q):
    word = need(body, "word", str, 100).strip()
    if not word:
        raise ApiError(400, "Từ trống")
    tr = (need(body, "translation", str, 300, optional=True) or "").strip()
    ex = (need(body, "example", str, 500, optional=True) or "").strip()
    lesson_id = need(body, "lesson_id", str, 64, optional=True)
    vid = add_vocab(con, user["id"], word, tr, ex, lesson_id)
    return {"id": vid}


def add_vocab(con, uid, word, tr, ex, lesson_id):
    cur = con.execute("INSERT INTO vocabulary (user_id, word, translation, example, lesson_id, due_at, created_at)"
                      " VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id, word) DO UPDATE SET"
                      " translation=CASE WHEN excluded.translation!='' THEN excluded.translation ELSE translation END,"
                      " example=CASE WHEN excluded.example!='' THEN excluded.example ELSE example END",
                      (uid, word, tr, ex, lesson_id, now(), now()))
    return cur.lastrowid


def h_vocab_review(con, user, prof, p, body, q):
    grade = need(body, "grade", int)
    if not 0 <= grade <= 3:
        raise ApiError(400, "grade: 0 đến 3")
    uid, vid = user["id"], int(p["id"])
    v = con.execute("SELECT * FROM vocabulary WHERE id=? AND user_id=?", (vid, uid)).fetchone()
    if not v:
        raise ApiError(404, "Không có từ này")
    ease, interval, reps, lapses = v["ease"], v["interval_days"], v["reps"], v["lapses"]
    if grade == 0:
        reps, lapses, interval = 0, lapses + 1, 0.007
    else:
        reps += 1
        interval = 1 if reps == 1 else 3 if reps == 2 else round(interval * ease, 1)
        if grade == 1:
            interval = max(1, round(interval * 0.5, 1))
        ease = max(1.3, ease + 0.1 - (3 - grade) * (0.08 + (3 - grade) * 0.02))
    status = "known" if reps >= 3 and interval >= 7 else "learning"
    from datetime import datetime, timedelta, timezone
    due = (datetime.now(timezone.utc) + timedelta(days=interval)).isoformat(timespec="seconds")
    con.execute("UPDATE vocabulary SET ease=?, interval_days=?, reps=?, lapses=?, status=?, due_at=? WHERE id=?",
                (ease, interval, reps, lapses, status, due, vid))
    con.execute("INSERT INTO vocab_reviews (user_id, vocab_id, grade, created_at) VALUES (?,?,?,?)", (uid, vid, grade, now()))
    return {"status": status, "interval_days": interval, "due_at": due}


def h_vocab_delete(con, user, prof, p, body, q):
    con.execute("DELETE FROM vocabulary WHERE id=? AND user_id=?", (int(p["id"]), user["id"]))
    return {"ok": True}


def mark_vocab_used(con, uid, text, column):
    words = con.execute("SELECT id, word FROM vocabulary WHERE user_id=?", (uid,)).fetchall()
    low = " " + re.sub(r"[^\w' ]+", " ", text.lower()) + " "
    for w in words:
        if " " + w["word"].lower().strip() + " " in low:
            con.execute(f"UPDATE vocabulary SET {column}=1 WHERE id=?", (w["id"],))


def h_speaking_post(con, user, prof, p, body, q):
    topic = need(body, "topic", str, 500)
    transcript = need(body, "transcript", str).strip()
    duration = need(body, "duration_s", int)
    lesson_id = need(body, "lesson_id", str, 64, optional=True)
    rubric = need(body, "rubric", str, 20, optional=True) or "general"
    audio = need(body, "audio_b64", str, MAX_BODY, optional=True)
    if not transcript:
        raise ApiError(400, "Không có transcript. Hãy nói hoặc gõ nội dung bài nói.")
    if not 1 <= duration <= 3600:
        raise ApiError(400, "duration_s: 1 đến 3600")
    uid = user["id"]
    cur = con.execute("INSERT INTO speaking_submissions (user_id, lesson_id, topic, duration_s, transcript, created_at)"
                      " VALUES (?,?,?,?,?,?)", (uid, lesson_id, topic, duration, transcript, now()))
    sid = cur.lastrowid
    if audio:
        try:
            raw = base64.b64decode(audio, validate=True)
        except ValueError:
            raise ApiError(400, "audio_b64 không hợp lệ")
        os.makedirs(AUDIO_DIR, exist_ok=True)
        path = os.path.join(AUDIO_DIR, f"{sid}.webm")
        with open(path, "wb") as f:
            f.write(raw)
        con.execute("UPDATE speaking_submissions SET audio_path=? WHERE id=?", (path, sid))
    con.commit()
    fb = run_ai(lambda: tutor.assess_speaking(transcript, topic, duration, prof, rubric))
    con.execute("UPDATE speaking_submissions SET feedback=? WHERE id=?", (json.dumps(fb, ensure_ascii=False), sid))
    if fb.get("scores"):
        add_assessment(con, uid, "speaking", fb["scores"]["overall"], fb["level_estimate"], "ai_speaking", sid)
        record_ai_errors(con, uid, fb["errors"], "ai_speaking", sid)
    mark_vocab_used(con, uid, transcript, "used_speaking")
    return {"id": sid, "feedback": fb}


def run_ai(fn):
    try:
        return fn()
    except tutor.TutorError as e:
        return {"error": str(e), "scores": None, "errors": [], "mock": False}


def h_speaking_get(con, user, prof, p, body, q):
    rows = con.execute("SELECT id, lesson_id, topic, duration_s, transcript, audio_path IS NOT NULL has_audio, feedback, created_at"
                       " FROM speaking_submissions WHERE user_id=? ORDER BY id DESC LIMIT 100", (user["id"],)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["feedback"] = json.loads(d["feedback"]) if d["feedback"] else None
        out.append(d)
    return {"items": out, "timeline": analytics.speaking_timeline(con, user["id"])}


def h_writing_post(con, user, prof, p, body, q):
    topic = need(body, "topic", str, 500)
    text = need(body, "body", str).strip()
    lesson_id = need(body, "lesson_id", str, 64, optional=True)
    criteria = need(body, "criteria", list, optional=True)
    if len(text) < 20:
        raise ApiError(400, "Bài viết quá ngắn")
    uid = user["id"]
    cur = con.execute("INSERT INTO writing_submissions (user_id, lesson_id, topic, body, created_at) VALUES (?,?,?,?,?)",
                      (uid, lesson_id, topic, text, now()))
    wid = cur.lastrowid
    con.commit()
    fb = run_ai(lambda: tutor.assess_writing(text, topic, prof, [str(c)[:200] for c in criteria or []][:10]))
    con.execute("UPDATE writing_submissions SET feedback=? WHERE id=?", (json.dumps(fb, ensure_ascii=False), wid))
    if fb.get("scores"):
        add_assessment(con, uid, "writing", fb["scores"]["overall"], fb["level_estimate"], "ai_writing", wid)
        record_ai_errors(con, uid, fb["errors"], "ai_writing", wid)
    mark_vocab_used(con, uid, text, "used_writing")
    return {"id": wid, "feedback": fb}


def h_writing_get(con, user, prof, p, body, q):
    rows = con.execute("SELECT * FROM writing_submissions WHERE user_id=? ORDER BY id DESC LIMIT 100", (user["id"],)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["feedback"] = json.loads(d["feedback"]) if d["feedback"] else None
        out.append(d)
    return {"items": out}


def h_tutor_get(con, user, prof, p, body, q):
    mode = (q.get("mode") or ["grammar"])[0]
    rows = con.execute("SELECT role, content, created_at FROM tutor_messages WHERE user_id=? AND mode=? ORDER BY id DESC LIMIT 60",
                       (user["id"], mode)).fetchall()
    return {"messages": [dict(r) for r in reversed(rows)], "ai": tutor.status()}


def h_tutor_post(con, user, prof, p, body, q):
    mode = need(body, "mode", str, 20)
    text = need(body, "message", str, 8000).strip()
    if mode not in TUTOR_MODES:
        raise ApiError(400, "Chế độ không hợp lệ")
    if not text:
        raise ApiError(400, "Tin nhắn trống")
    uid = user["id"]
    hist = [dict(r) for r in reversed(con.execute(
        "SELECT role, content FROM tutor_messages WHERE user_id=? AND mode=? ORDER BY id DESC LIMIT 20", (uid, mode)).fetchall())]
    try:
        out = tutor.chat(mode, hist, text, prof)
    except tutor.TutorError as e:
        raise ApiError(502, str(e))
    con.execute("INSERT INTO tutor_messages (user_id, mode, role, content, created_at) VALUES (?,?,?,?,?)",
                (uid, mode, "user", text, now()))
    cur = con.execute("INSERT INTO tutor_messages (user_id, mode, role, content, created_at) VALUES (?,?,?,?,?)",
                      (uid, mode, "assistant", out["reply"], now()))
    if not out.get("mock"):
        record_ai_errors(con, uid, out.get("errors"), f"tutor_{mode}", cur.lastrowid)
        for v in out.get("vocab") or []:
            if v.get("fr"):
                add_vocab(con, uid, v["fr"][:100], v.get("vi", "")[:300], v.get("example", "")[:500], None)
    return out


def h_tutor_clear(con, user, prof, p, body, q):
    mode = (q.get("mode") or [""])[0]
    con.execute("DELETE FROM tutor_messages WHERE user_id=? AND mode=?", (user["id"], mode))
    return {"ok": True}


def h_analytics(con, user, prof, p, body, q):
    uid = user["id"]
    return {"skills": analytics.skill_summary(con, uid), "cefr": analytics.cefr_estimate(con, uid),
            "grammar": analytics.grammar_table(con, uid, 90), "recent_errors": analytics.recent_errors(con, uid),
            "remediation": analytics.remediation(con, uid), "vocab": analytics.vocab_stats(con, uid),
            "speaking": analytics.speaking_timeline(con, uid), "days30": analytics.minutes_by_day(con, uid, 30),
            "weeks": analytics.minutes_by_week(con, uid)}


def h_weekly(con, user, prof, p, body, q):
    week = (q.get("week") or [None])[0]
    if week and not re.match(r"^\d{4}-W\d{2}$", week):
        raise ApiError(400, "week: YYYY-Www")
    return analytics.weekly_report(con, user["id"], prof, week)


def h_monthly(con, user, prof, p, body, q):
    month = (q.get("month") or [None])[0]
    if month and not re.match(r"^\d{4}-\d{2}$", month):
        raise ApiError(400, "month: YYYY-MM")
    return analytics.monthly_report(con, user["id"], prof, month)


def h_resources(con, user, prof, p, body, q):
    return store.read_json("resources.json")


def h_exam(con, user, prof, p, body, q):
    return store.read_json("exam.json")


def h_drill(con, user, prof, p, body, q):
    cat = (q.get("category") or [None])[0]
    cats = [cat] if cat else [r["category"] for r in analytics.grammar_table(con, user["id"], 30)[:3]]
    rows = con.execute("SELECT id, title, data FROM lessons ORDER BY phase, week, ord").fetchall()
    out = []
    for row in rows:
        d = json.loads(row["data"])
        for idx, sec in enumerate(d["sections"]):
            if sec["type"] not in ("exercise", "quiz"):
                continue
            for qq in sec["questions"]:
                if qq.get("error_tag") in cats:
                    item = {k: v for k, v in qq.items() if k not in ("answer", "explain")}
                    item.update({"lesson_id": row["id"], "section_idx": idx, "lesson_title": row["title"]})
                    out.append(item)
    return {"categories": cats, "questions": out[:40]}


def h_prompts(con, user, prof, p, body, q):
    rows = con.execute("SELECT id, title, level, data FROM lessons ORDER BY phase, week, ord").fetchall()
    speaking, writing = [], []
    for row in rows:
        d = json.loads(row["data"])
        for sec in d["sections"]:
            if sec["type"] == "speaking":
                speaking.append({"lesson_id": row["id"], "lesson_title": row["title"], "level": row["level"],
                                 "title": sec.get("title"), "prompt": sec["prompt"], "minutes": sec.get("minutes", 3),
                                 "hints": sec.get("hints", [])})
            if sec["type"] == "writing":
                writing.append({"lesson_id": row["id"], "lesson_title": row["title"], "level": row["level"],
                                "title": sec.get("title"), "prompt": sec["prompt"], "words": sec.get("words", 120),
                                "criteria": sec.get("criteria", [])})
    return {"speaking": speaking, "writing": writing}


ROUTES = [
    ("POST", r"/api/register", h_register, False),
    ("POST", r"/api/login", h_login, False),
    ("POST", r"/api/logout", h_logout, True),
    ("GET", r"/api/me", h_me, True),
    ("PUT", r"/api/profile", h_profile, True),
    ("GET", r"/api/diagnostic", h_diagnostic_get, True),
    ("POST", r"/api/diagnostic", h_diagnostic_post, True),
    ("GET", r"/api/dashboard", h_dashboard, True),
    ("GET", r"/api/path", h_path, True),
    ("GET", r"/api/plan", h_plan, True),
    ("GET", r"/api/curriculum", h_curriculum, True),
    ("GET", r"/api/lessons/(?P<id>[\w-]+)", h_lesson, True),
    ("POST", r"/api/lessons/(?P<id>[\w-]+)/progress", h_lesson_progress, True),
    ("POST", r"/api/attempts", h_attempt, True),
    ("POST", r"/api/study", h_study, True),
    ("GET", r"/api/notes", h_notes_get, True),
    ("PUT", r"/api/notes", h_notes_put, True),
    ("DELETE", r"/api/notes/(?P<id>\d+)", h_note_delete, True),
    ("GET", r"/api/vocab", h_vocab_get, True),
    ("POST", r"/api/vocab", h_vocab_post, True),
    ("POST", r"/api/vocab/(?P<id>\d+)/review", h_vocab_review, True),
    ("DELETE", r"/api/vocab/(?P<id>\d+)", h_vocab_delete, True),
    ("POST", r"/api/speaking", h_speaking_post, True),
    ("GET", r"/api/speaking", h_speaking_get, True),
    ("POST", r"/api/writing", h_writing_post, True),
    ("GET", r"/api/writing", h_writing_get, True),
    ("GET", r"/api/tutor", h_tutor_get, True),
    ("POST", r"/api/tutor", h_tutor_post, True),
    ("DELETE", r"/api/tutor", h_tutor_clear, True),
    ("GET", r"/api/analytics", h_analytics, True),
    ("GET", r"/api/report/weekly", h_weekly, True),
    ("GET", r"/api/report/monthly", h_monthly, True),
    ("GET", r"/api/resources", h_resources, True),
    ("GET", r"/api/exam", h_exam, True),
    ("GET", r"/api/drill", h_drill, True),
    ("GET", r"/api/prompts", h_prompts, True),
]
COMPILED = [(m, re.compile("^" + pat + "$"), fn, auth) for m, pat, fn, auth in ROUTES]


class Handler(BaseHTTPRequestHandler):
    server_version = "FrenchAcademy/0.1"

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else "") or os.environ.get("FA_VERBOSE"):
            sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        url = urlsplit(self.path)
        if not url.path.startswith("/api/"):
            if method == "GET":
                return self.serve_static(url.path)
            return self.send_json(405, {"error": "Method not allowed"})
        if url.path.startswith("/api/audio/"):
            return self.serve_audio(url.path.rsplit("/", 1)[1])
        for m, rx, fn, auth in COMPILED:
            match = rx.match(url.path)
            if match and m == method:
                return self.run(fn, auth, match.groupdict(), parse_qs(url.query))
        self.send_json(404, {"error": "Không có endpoint này"})

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ApiError(413, "Dữ liệu quá lớn")
        if length == 0:
            return {}
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            raise ApiError(415, "Cần Content-Type application/json")
        try:
            body = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "JSON không hợp lệ")
        if not isinstance(body, dict):
            raise ApiError(400, "Body phải là object")
        return body

    def session_token(self):
        c = SimpleCookie(self.headers.get("Cookie") or "")
        return c["fa_session"].value if "fa_session" in c else None

    def run(self, fn, auth, params, query):
        con = store.connect()
        try:
            user = store.user_for_token(con, self.session_token())
            if auth and not user:
                return self.send_json(401, {"error": "Chưa đăng nhập"})
            body = self.read_body() if self.command in ("POST", "PUT") else {}
            prof = store.profile(con, user["id"]) if user else None
            out = fn(con, user, prof, params, body, query)
            cookie = None
            if isinstance(out, tuple):
                out, cookie = out
            con.commit()
            self.send_json(200, out, cookie)
        except ApiError as e:
            con.rollback()
            self.send_json(e.status, {"error": e.message})
        except Exception:
            con.rollback()
            traceback.print_exc()
            self.send_json(500, {"error": "Lỗi máy chủ, xem log"})
        finally:
            con.close()

    def send_json(self, status, obj, cookie=None):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if cookie is not None:
            age = 0 if cookie == "" else 90 * 86400
            self.send_header("Set-Cookie", f"fa_session={cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age={age}")
        self.end_headers()
        self.wfile.write(data)

    def serve_static(self, path):
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        full = os.path.realpath(os.path.join(STATIC, rel))
        if not full.startswith(STATIC + os.sep) or not os.path.isfile(full):
            full = os.path.join(STATIC, "index.html")  # SPA fallback
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") or ctype.endswith("javascript") else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def serve_audio(self, sid):
        con = store.connect()
        try:
            user = store.user_for_token(con, self.session_token())
            if not user or not sid.isdigit():
                return self.send_json(401, {"error": "Chưa đăng nhập"})
            row = con.execute("SELECT audio_path FROM speaking_submissions WHERE id=? AND user_id=?", (int(sid), user["id"])).fetchone()
        finally:
            con.close()
        if not row or not row["audio_path"] or not os.path.isfile(row["audio_path"]):
            return self.send_json(404, {"error": "Không có audio"})
        with open(row["audio_path"], "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "audio/webm")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    if "--check-content" in sys.argv:
        con = store.connect()
        con.executescript(store.SCHEMA)
        n = store.load_content(con, strict=False)
        print(f"{n} bài học hợp lệ")
        return
    store.init()
    con = store.connect()
    n = store.load_content(con)
    con.close()
    port = int(os.environ.get("FA_PORT", "8000"))
    host = os.environ.get("FA_HOST", "127.0.0.1")
    print(f"French Academy: {n} bài học, AI {'sẵn sàng' if tutor.configured() else 'MÔ PHỎNG'}, http://{host}:{port}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
