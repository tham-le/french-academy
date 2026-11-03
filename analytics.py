"""Learning analytics: progress (what was studied) kept apart from proficiency (what was shown)."""
import json
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from store import SKILLS, read_json

SKILL_VI = {"listening": "Compréhension orale", "reading": "Compréhension écrite",
            "speaking": "Expression orale", "writing": "Expression écrite"}
LEVEL_ORD = {"A2": 0, "B1": 1, "B2": 2, "C1": 3, "C2": 4}
ORD_LEVEL = {v: k for k, v in LEVEL_ORD.items()}
PASS_SCORE = 60


def local_now():
    return datetime.now().astimezone()


def to_local(iso):
    return datetime.fromisoformat(iso).astimezone()


def day_key(iso):
    return to_local(iso).strftime("%Y-%m-%d")


def utc_bounds(start_local_date, days):
    """UTC ISO strings for [local midnight of start, +days)."""
    tz = local_now().tzinfo
    start = datetime.combine(start_local_date, datetime.min.time()).replace(tzinfo=tz)
    end = start + timedelta(days=days)
    return (start.astimezone(timezone.utc).isoformat(timespec="seconds"),
            end.astimezone(timezone.utc).isoformat(timespec="seconds"))


def since(days):
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")


# time and streak

def minutes_by_day(con, uid, days):
    lo, _ = utc_bounds(local_now().date() - timedelta(days=days - 1), days)
    rows = con.execute("SELECT seconds, created_at FROM study_sessions WHERE user_id=? AND created_at>=?",
                       (uid, lo)).fetchall()
    acc = Counter()
    for r in rows:
        acc[day_key(r["created_at"])] += r["seconds"]
    out = []
    for i in range(days):
        d = (local_now().date() - timedelta(days=days - 1 - i)).strftime("%Y-%m-%d")
        out.append({"day": d, "minutes": round(acc[d] / 60)})
    return out


def minutes_by_week(con, uid):
    rows = con.execute("SELECT seconds, created_at FROM study_sessions WHERE user_id=?", (uid,)).fetchall()
    acc = Counter()
    for r in rows:
        y, w, _ = to_local(r["created_at"]).isocalendar()
        acc[f"{y}-W{w:02d}"] += r["seconds"]
    return [{"week": k, "minutes": round(v / 60)} for k, v in sorted(acc.items())]


def total_seconds(con, uid, lo=None, hi=None):
    q = "SELECT COALESCE(SUM(seconds),0) s FROM study_sessions WHERE user_id=?"
    args = [uid]
    if lo:
        q += " AND created_at>=?"
        args.append(lo)
    if hi:
        q += " AND created_at<?"
        args.append(hi)
    return con.execute(q, args).fetchone()["s"]


def streak(con, uid):
    rows = con.execute(
        "SELECT created_at FROM study_sessions WHERE user_id=? UNION SELECT created_at FROM attempts WHERE user_id=?",
        (uid, uid)).fetchall()
    days = {day_key(r["created_at"]) for r in rows}
    d = local_now().date()
    if d.strftime("%Y-%m-%d") not in days:
        d -= timedelta(days=1)
    n = 0
    while d.strftime("%Y-%m-%d") in days:
        n += 1
        d -= timedelta(days=1)
    return n


# proficiency

def assessments(con, uid, skill=None, lo=None, hi=None):
    q = "SELECT * FROM skill_assessments WHERE user_id=?"
    args = [uid]
    if skill:
        q += " AND skill=?"
        args.append(skill)
    if lo:
        q += " AND created_at>=?"
        args.append(lo)
    if hi:
        q += " AND created_at<?"
        args.append(hi)
    return [dict(r) for r in con.execute(q + " ORDER BY created_at", args).fetchall()]


def _avg(xs):
    return round(sum(xs) / len(xs), 1) if xs else None


def cefr_estimate(con, uid):
    """Per skill: median level of the last 60 days of level-bearing assessments, with confidence."""
    out = {}
    worst = None
    for s in SKILLS:
        rows = [a for a in assessments(con, uid, s, since(60)) if a["level_estimate"] in LEVEL_ORD]
        rows = rows[-6:]
        if not rows:
            out[s] = {"level": None, "confidence": "none", "n": 0,
                      "note": "Chưa có bài đánh giá nào cho kỹ năng này."}
            worst = -1
            continue
        ords = sorted(LEVEL_ORD[a["level_estimate"]] for a in rows)
        med = ords[len(ords) // 2]
        sources = {a["source"] for a in rows}
        productive = s in ("speaking", "writing")
        if len(rows) >= 5 and ("ai" in "".join(sources) or "evaluation" in sources):
            conf = "high"
        elif len(rows) >= 2:
            conf = "medium"
        else:
            conf = "low"
        if productive and not any(src.startswith("ai_") or src == "evaluation" for src in sources):
            conf = "low"
        out[s] = {"level": ORD_LEVEL[med], "confidence": conf, "n": len(rows),
                  "sources": sorted(sources),
                  "note": f"{len(rows)} bài đánh giá trong 60 ngày ({', '.join(sorted(sources))})."}
        worst = med if worst is None else min(worst, med)
    overall = None if worst is None or worst < 0 else ORD_LEVEL[worst]
    confs = [v["confidence"] for v in out.values()]
    overall_conf = "none" if "none" in confs else ("low" if "low" in confs else
                                                   "medium" if "medium" in confs else "high")
    return {"skills": out, "overall": overall, "confidence": overall_conf,
            "disclaimer": "Ước tính từ các bài đánh giá, không phải chứng nhận. "
                          "Mức chung lấy theo kỹ năng thấp nhất (CEFR yêu cầu cả 4 kỹ năng)."}


def skill_summary(con, uid):
    """Per skill: last score, 30 day average, trend, hours, exercise count, errors, weak points."""
    out = {}
    for s in SKILLS:
        recent = assessments(con, uid, s, since(30))
        prev = assessments(con, uid, s, since(60), since(30))
        all_rows = assessments(con, uid, s)
        last = all_rows[-1] if all_rows else None
        avg30, avg_prev = _avg([a["score"] for a in recent]), _avg([a["score"] for a in prev])
        trend = None if avg30 is None or avg_prev is None else round(avg30 - avg_prev, 1)
        secs = con.execute("SELECT COALESCE(SUM(seconds),0) s FROM study_sessions WHERE user_id=? AND skill=?",
                           (uid, s)).fetchone()["s"]
        n_ex = con.execute("SELECT COUNT(*) c FROM attempts WHERE user_id=? AND skill=?", (uid, s)).fetchone()["c"]
        n_sub = 0
        if s == "speaking":
            n_sub = con.execute("SELECT COUNT(*) c FROM speaking_submissions WHERE user_id=?", (uid,)).fetchone()["c"]
        if s == "writing":
            n_sub = con.execute("SELECT COUNT(*) c FROM writing_submissions WHERE user_id=?", (uid,)).fetchone()["c"]
        errs = con.execute(
            "SELECT category, COUNT(*) c FROM grammar_errors WHERE user_id=? AND source LIKE ? AND created_at>=?"
            " GROUP BY category ORDER BY c DESC LIMIT 5",
            (uid, f"%{s}%", since(30))).fetchall()
        out[s] = {
            "name": SKILL_VI[s], "last_score": last["score"] if last else None,
            "last_at": last["created_at"] if last else None, "avg30": avg30, "trend": trend,
            "hours": round(secs / 3600, 1), "exercises": n_ex, "submissions": n_sub,
            "errors": [{"category": r["category"], "count": r["c"]} for r in errs],
            "weak_points": weak_points(con, uid, s),
            "history": [{"at": a["created_at"], "score": a["score"], "source": a["source"]}
                        for a in all_rows[-30:]],
        }
    return out


def weak_points(con, uid, skill):
    table = {"speaking": "speaking_submissions", "writing": "writing_submissions"}.get(skill)
    if not table:
        return []
    rows = con.execute(f"SELECT feedback FROM {table} WHERE user_id=? AND feedback IS NOT NULL"
                       " ORDER BY id DESC LIMIT 10", (uid,)).fetchall()
    c = Counter()
    for r in rows:
        fb = json.loads(r["feedback"])
        for w in fb.get("weak_points") or []:
            c[w.strip()] += 1
    return [w for w, _ in c.most_common(5)]


def grammar_table(con, uid, days=90):
    rows = con.execute(
        "SELECT category, COUNT(*) c, MAX(created_at) last FROM grammar_errors WHERE user_id=? AND created_at>=?"
        " GROUP BY category ORDER BY c DESC", (uid, since(days))).fetchall()
    return [dict(r) for r in rows]


def recent_errors(con, uid, limit=50):
    rows = con.execute("SELECT * FROM grammar_errors WHERE user_id=? ORDER BY id DESC LIMIT ?",
                       (uid, limit)).fetchall()
    return [dict(r) for r in rows]


def remediation(con, uid):
    """Lessons to redo for every error category seen 3+ times in 30 days."""
    hot = [r for r in grammar_table(con, uid, 30) if r["c"] >= 3]
    if not hot:
        return []
    lessons = con.execute("SELECT id, title, data FROM lessons ORDER BY phase, week, ord").fetchall()
    out = []
    for h in hot:
        for row in lessons:
            d = json.loads(row["data"])
            tags = set(d.get("error_tags", []))
            tags |= {q.get("error_tag") for s in d["sections"] for q in s.get("questions", [])}
            if h["category"] in tags:
                out.append({"category": h["category"], "count": h["c"],
                            "lesson_id": row["id"], "title": row["title"]})
                break
        else:
            out.append({"category": h["category"], "count": h["c"], "lesson_id": None, "title": None})
    return out


# vocabulary

def vocab_stats(con, uid):
    rows = con.execute("SELECT status, due_at, used_speaking, used_writing FROM vocabulary WHERE user_id=?",
                       (uid,)).fetchall()
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    st = Counter(r["status"] for r in rows)
    return {
        "total": len(rows), "new": st["new"], "learning": st["learning"], "known": st["known"],
        "due": sum(1 for r in rows if r["due_at"] <= now_iso and r["status"] != "new"),
        "active": sum(1 for r in rows if r["used_speaking"] or r["used_writing"]),
        "used_speaking": sum(1 for r in rows if r["used_speaking"]),
        "used_writing": sum(1 for r in rows if r["used_writing"]),
    }


# progress

def lesson_rows(con, uid):
    rows = con.execute(
        "SELECT l.id, l.phase, l.module, l.week, l.ord, l.level, l.skill, l.title, l.duration_min,"
        " p.status, p.section_idx, p.best_score, p.completed_at FROM lessons l"
        " LEFT JOIN lesson_progress p ON p.lesson_id=l.id AND p.user_id=?"
        " ORDER BY l.phase, l.week, l.ord", (uid,)).fetchall()
    return [dict(r) for r in rows]


def path(con, uid, prof):
    """Lessons grouped by week. Inside the current week, weak-skill lessons and reviews come first."""
    rows = lesson_rows(con, uid)
    weak = set(prof.get("weak_skills") or [])
    hot_tags = {r["category"] for r in grammar_table(con, uid, 30) if r["c"] >= 3}
    tag_lessons = {r["lesson_id"] for r in remediation(con, uid) if r["lesson_id"]}
    weeks = defaultdict(list)
    for r in rows:
        r["status"] = r["status"] or "not_started"
        r["priority"] = (r["status"] == "review") * 2 + (r["skill"] in weak or r["id"] in tag_lessons)
        weeks[(r["phase"], r["week"])].append(r)
    current = None
    out = []
    for (phase, week), ls in sorted(weeks.items()):
        done = all(l["status"] == "completed" for l in ls)
        if not done and current is None:
            current = (phase, week)
            ls.sort(key=lambda l: (-l["priority"], l["ord"]))
        out.append({"phase": phase, "week": week, "module": ls[0]["module"], "lessons": ls,
                    "done": done, "current": (phase, week) == current})
    nxt = next((l for w in out for l in w["lessons"] if l["status"] != "completed"), None)
    return {"weeks": out, "next": nxt, "weak_skills": sorted(weak), "hot_errors": sorted(hot_tags),
            "remediation": remediation(con, uid)}


def next_lesson_for(con, uid, skill):
    for r in lesson_rows(con, uid):
        if r["skill"] == skill and (r["status"] or "") != "completed":
            return {"id": r["id"], "title": r["title"]}
    return None


def today_plan(con, uid, prof):
    template = read_json("schedule.json")
    total = sum(t["minutes"] for t in template)
    scale = (prof.get("daily_minutes") or total) / total
    today = local_now().date()
    lo, hi = utc_bounds(today, 1)
    ylo, yhi = utc_bounds(today - timedelta(days=1), 1)
    done_today = _minutes_by_activity(con, uid, lo, hi)
    done_yest = _minutes_by_activity(con, uid, ylo, yhi)
    vocab = vocab_stats(con, uid)
    items, missing = [], []
    for t in template:
        mins = max(10, round(t["minutes"] * scale))
        got = done_today.get(t["activity"], 0)
        target = _target(con, uid, t["activity"], vocab)
        items.append({**t, "minutes": mins, "done_minutes": got, "done": got >= 0.7 * mins,
                      "target": target})
        if done_yest.get(t["activity"], 0) < 0.7 * mins:
            missing.append(t["label"])
    plan_total = sum(i["minutes"] for i in items)
    yest_total = sum(done_yest.values())
    note = None
    if yest_total < 0.5 * plan_total:
        note = (f"Hôm qua bạn học {yest_total} / {plan_total} phút. Hôm nay dành 15 phút đầu để ôn lại"
                " từ vựng đến hạn và lỗi gần đây, phần còn lại giữ nguyên.")
    return {"date": today.isoformat(), "items": items, "total": plan_total,
            "done_total": sum(done_today.values()), "missing_yesterday": missing, "note": note}


def _minutes_by_activity(con, uid, lo, hi):
    rows = con.execute("SELECT activity, SUM(seconds) s FROM study_sessions WHERE user_id=? AND created_at>=?"
                       " AND created_at<? GROUP BY activity", (uid, lo, hi)).fetchall()
    return {r["activity"]: round(r["s"] / 60) for r in rows}


def _target(con, uid, activity, vocab):
    if activity == "vocab":
        return {"page": "vocab", "label": f"{vocab['due']} từ đến hạn ôn"}
    if activity == "review":
        return {"page": "grammar", "label": "Ôn lỗi lặp lại"}
    if activity == "grammar":
        les = next_lesson_for(con, uid, "grammar")
        return {"page": f"lesson/{les['id']}", "label": les["title"]} if les else {"page": "grammar", "label": "Grammar Practice"}
    les = next_lesson_for(con, uid, activity)
    lab = {"speaking": "speaking", "writing": "writing"}.get(activity)
    if les:
        return {"page": f"lesson/{les['id']}", "label": les["title"]}
    return {"page": lab or "catalog", "label": "Lab" if lab else "Catalogue"}


# dashboard and reports

def dashboard(con, uid, prof):
    rows = lesson_rows(con, uid)
    total = len(rows)
    completed = sum(1 for r in rows if r["status"] == "completed")
    last_quiz = con.execute("SELECT score, max_score, created_at, lesson_id FROM attempts WHERE user_id=?"
                            " AND kind IN ('quiz','diagnostic','evaluation') ORDER BY id DESC LIMIT 1",
                            (uid,)).fetchone()
    skills = skill_summary(con, uid)
    return {
        "current_level": prof["current_level"], "target_level": prof["target_level"],
        "completion_pct": round(100 * completed / total) if total else 0,
        "lessons_completed": completed, "lessons_total": total,
        "hours": round(total_seconds(con, uid) / 3600, 1), "streak": streak(con, uid),
        "vocab": vocab_stats(con, uid),
        "last_quiz": dict(last_quiz) if last_quiz else None,
        "skills": {s: {"name": v["name"], "last_score": v["last_score"], "avg30": v["avg30"],
                       "trend": v["trend"]} for s, v in skills.items()},
        "cefr": cefr_estimate(con, uid),
        "next": path(con, uid, prof)["next"],
        "plan": today_plan(con, uid, prof),
        "days14": minutes_by_day(con, uid, 14),
        "weeks": minutes_by_week(con, uid),
        "diagnostic_done": bool(prof.get("diagnostic_at")),
    }


def week_bounds(week_str):
    y, w = week_str.split("-W")
    start = datetime.fromisocalendar(int(y), int(w), 1).date()
    return start


def weekly_report(con, uid, prof, week_str=None):
    if not week_str:
        y, w, _ = local_now().isocalendar()
        week_str = f"{y}-W{w:02d}"
    start = week_bounds(week_str)
    lo, hi = utc_bounds(start, 7)
    plo, _ = utc_bounds(start - timedelta(days=7), 7)
    secs = total_seconds(con, uid, lo, hi)
    lessons = con.execute("SELECT COUNT(*) c FROM lesson_progress WHERE user_id=? AND completed_at>=? AND completed_at<?",
                          (uid, lo, hi)).fetchone()["c"]
    per_skill, best, worst = {}, None, None
    for s in SKILLS:
        cur = _avg([a["score"] for a in assessments(con, uid, s, lo, hi)])
        prev = _avg([a["score"] for a in assessments(con, uid, s, plo, lo)])
        delta = None if cur is None or prev is None else round(cur - prev, 1)
        per_skill[s] = {"name": SKILL_VI[s], "avg": cur, "prev": prev, "delta": delta}
        if delta is not None and (best is None or delta > per_skill[best]["delta"]):
            best = s
        if cur is not None and (worst is None or cur < per_skill[worst]["avg"]):
            worst = s
    errs = con.execute("SELECT category, COUNT(*) c FROM grammar_errors WHERE user_id=? AND created_at>=? AND created_at<?"
                       " GROUP BY category ORDER BY c DESC LIMIT 5", (uid, lo, hi)).fetchall()
    vocab_new = con.execute("SELECT COUNT(*) c FROM vocabulary WHERE user_id=? AND created_at>=? AND created_at<?",
                            (uid, lo, hi)).fetchone()["c"]
    vocab_known = con.execute("SELECT COUNT(*) c FROM vocab_reviews WHERE user_id=? AND grade>=2 AND created_at>=? AND created_at<?",
                              (uid, lo, hi)).fetchone()["c"]
    days_elapsed = min(7, max(1, (local_now().date() - start).days + 1)) if start <= local_now().date() else 0
    planned = (prof.get("daily_minutes") or 270) * days_elapsed
    goals = []
    if worst:
        goals.append(f"Ưu tiên {SKILL_VI[worst]}: thêm 2 buổi luyện trong tuần.")
    for e in errs[:2]:
        goals.append(f"Làm lại bài về « {e['category']} » ({e['c']} lỗi tuần này).")
    goals.append(f"Giữ {prof.get('daily_minutes', 270)} phút mỗi ngày, ôn từ vựng đến hạn hằng ngày.")
    return {
        "week": week_str, "start": start.isoformat(), "end": (start + timedelta(days=6)).isoformat(),
        "minutes": round(secs / 60), "lessons_completed": lessons, "per_skill": per_skill,
        "best_skill": SKILL_VI[best] if best else None, "worst_skill": SKILL_VI[worst] if worst else None,
        "top_errors": [dict(r) for r in errs], "vocab_new": vocab_new, "vocab_reviews_ok": vocab_known,
        "plan_minutes": planned, "plan_pct": round(100 * secs / 60 / planned) if planned else 0,
        "goals": goals, "days": minutes_by_day_range(con, uid, start, 7),
    }


def minutes_by_day_range(con, uid, start, days):
    lo, hi = utc_bounds(start, days)
    rows = con.execute("SELECT seconds, created_at FROM study_sessions WHERE user_id=? AND created_at>=? AND created_at<?",
                       (uid, lo, hi)).fetchall()
    acc = Counter()
    for r in rows:
        acc[day_key(r["created_at"])] += r["seconds"]
    return [{"day": (start + timedelta(days=i)).isoformat(),
             "minutes": round(acc[(start + timedelta(days=i)).isoformat()] / 60)} for i in range(days)]


def monthly_report(con, uid, prof, month=None):
    if not month:
        month = local_now().strftime("%Y-%m")
    y, m = (int(x) for x in month.split("-"))
    start = datetime(y, m, 1).date()
    end = datetime(y + (m == 12), (m % 12) + 1, 1).date()
    lo, hi = utc_bounds(start, (end - start).days)
    per_skill = {}
    for s in SKILLS:
        rows = assessments(con, uid, s, lo, hi)
        per_skill[s] = {"name": SKILL_VI[s], "avg": _avg([a["score"] for a in rows]), "n": len(rows),
                        "levels": dict(Counter(a["level_estimate"] for a in rows if a["level_estimate"]))}
    return {
        "month": month, "hours": round(total_seconds(con, uid, lo, hi) / 3600, 1),
        "lessons_completed": con.execute(
            "SELECT COUNT(*) c FROM lesson_progress WHERE user_id=? AND completed_at>=? AND completed_at<?",
            (uid, lo, hi)).fetchone()["c"],
        "per_skill": per_skill, "cefr": cefr_estimate(con, uid),
        "errors": [dict(r) for r in con.execute(
            "SELECT category, COUNT(*) c FROM grammar_errors WHERE user_id=? AND created_at>=? AND created_at<?"
            " GROUP BY category ORDER BY c DESC LIMIT 8", (uid, lo, hi)).fetchall()],
        "speaking": con.execute("SELECT COUNT(*) c FROM speaking_submissions WHERE user_id=? AND created_at>=? AND created_at<?",
                                (uid, lo, hi)).fetchone()["c"],
        "writing": con.execute("SELECT COUNT(*) c FROM writing_submissions WHERE user_id=? AND created_at>=? AND created_at<?",
                               (uid, lo, hi)).fetchone()["c"],
        "vocab": vocab_stats(con, uid),
        "disclaimer": "Báo cáo này ước tính năng lực từ các bài đánh giá trong tháng. Hoàn thành bài học"
                      " không chứng minh trình độ; chỉ bài đánh giá đủ 4 kỹ năng mới cho kết luận.",
    }


def speaking_timeline(con, uid):
    rows = con.execute("SELECT id, topic, duration_s, feedback, created_at FROM speaking_submissions"
                       " WHERE user_id=? ORDER BY id", (uid,)).fetchall()
    out = []
    for r in rows:
        fb = json.loads(r["feedback"]) if r["feedback"] else {}
        out.append({"id": r["id"], "topic": r["topic"], "duration_s": r["duration_s"],
                    "at": r["created_at"], "scores": fb.get("scores"), "level": fb.get("level_estimate")})
    return out
