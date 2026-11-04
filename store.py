"""SQLite storage, auth helpers and content loading for French Academy."""
import glob
import hashlib
import json
import os
import re
import secrets
import sqlite3
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("FA_DB", os.path.join(ROOT, "data", "academy.db"))
CONTENT_DIR = os.path.join(ROOT, "content")

SKILLS = ("listening", "reading", "speaking", "writing")
LEVELS = ("A2", "B1", "B2", "C1", "C2")
ACTIVITIES = ("grammar", "vocab", "listening", "reading", "speaking", "writing", "review")
ERROR_CATEGORIES = (
    "subjonctif", "accord_participe_passe", "pronoms_relatifs", "conditionnel",
    "passe_compose_imparfait", "futur", "articles", "prepositions", "pronoms_cod_coi",
    "negation", "genre_nombre", "concordance_temps", "connecteurs", "lexique",
    "orthographe", "syntaxe", "registre", "autre",
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pw_hash BLOB NOT NULL,
  salt BLOB NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '', current_level TEXT NOT NULL DEFAULT 'B1',
  target_level TEXT NOT NULL DEFAULT 'C1', daily_minutes INTEGER NOT NULL DEFAULT 270,
  explain_lang TEXT NOT NULL DEFAULT 'vi', goals TEXT NOT NULL DEFAULT '',
  weak_skills TEXT NOT NULL DEFAULT '[]', strong_skills TEXT NOT NULL DEFAULT '[]',
  diagnostic_at TEXT, onboarded INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY, phase INTEGER NOT NULL, module TEXT NOT NULL, week INTEGER NOT NULL,
  ord INTEGER NOT NULL, level TEXT NOT NULL, skill TEXT NOT NULL, title TEXT NOT NULL,
  duration_min INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lesson_progress (
  user_id INTEGER NOT NULL, lesson_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'in_progress',
  section_idx INTEGER NOT NULL DEFAULT 0, seconds INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL, completed_at TEXT, best_score REAL,
  PRIMARY KEY (user_id, lesson_id));
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, lesson_id TEXT, body TEXT NOT NULL,
  updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, lesson_id TEXT, kind TEXT NOT NULL,
  skill TEXT, score REAL NOT NULL, max_score REAL NOT NULL, answers TEXT NOT NULL,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS study_sessions (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, activity TEXT NOT NULL, skill TEXT,
  lesson_id TEXT, seconds INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS skill_assessments (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, skill TEXT NOT NULL, score REAL NOT NULL,
  level_estimate TEXT, source TEXT NOT NULL, ref_id INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS grammar_errors (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, category TEXT NOT NULL,
  original TEXT NOT NULL DEFAULT '', correction TEXT NOT NULL DEFAULT '',
  explanation TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, ref_id INTEGER,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vocabulary (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, word TEXT NOT NULL,
  translation TEXT NOT NULL DEFAULT '', example TEXT NOT NULL DEFAULT '', lesson_id TEXT,
  status TEXT NOT NULL DEFAULT 'new', ease REAL NOT NULL DEFAULT 2.5,
  interval_days REAL NOT NULL DEFAULT 0, reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0, due_at TEXT NOT NULL,
  used_speaking INTEGER NOT NULL DEFAULT 0, used_writing INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, UNIQUE (user_id, word));
CREATE TABLE IF NOT EXISTS vocab_reviews (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, vocab_id INTEGER NOT NULL,
  grade INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS speaking_submissions (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, lesson_id TEXT, topic TEXT NOT NULL,
  duration_s INTEGER NOT NULL, transcript TEXT NOT NULL, audio_path TEXT, feedback TEXT,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS writing_submissions (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, lesson_id TEXT, topic TEXT NOT NULL,
  body TEXT NOT NULL, feedback TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tutor_messages (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, mode TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_study ON study_sessions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_assess ON skill_assessments(user_id, skill, created_at);
CREATE INDEX IF NOT EXISTS idx_errors ON grammar_errors(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attempts ON attempts(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_vocab_due ON vocabulary(user_id, due_at);
CREATE INDEX IF NOT EXISTS idx_tutor ON tutor_messages(user_id, mode, id);
"""


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    return con


def init():
    con = connect()
    con.executescript(SCHEMA)
    con.commit()
    con.close()


# auth

USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,32}$")


def hash_password(password, salt):
    return hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)


def create_user(con, username, password):
    if not USERNAME_RE.match(username):
        raise ValueError("Tên đăng nhập: 3 đến 32 ký tự, chữ, số hoặc _")
    if len(password) < 8:
        raise ValueError("Mật khẩu cần ít nhất 8 ký tự")
    salt = secrets.token_bytes(16)
    try:
        cur = con.execute(
            "INSERT INTO users (username, pw_hash, salt, created_at) VALUES (?,?,?,?)",
            (username, hash_password(password, salt), salt, now()))
    except sqlite3.IntegrityError:
        raise ValueError("Tên đăng nhập đã tồn tại")
    con.execute("INSERT INTO profiles (user_id) VALUES (?)", (cur.lastrowid,))
    return cur.lastrowid


def check_login(con, username, password):
    row = con.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    if not row:
        hash_password(password, b"x" * 16)  # same cost on unknown user
        return None
    if secrets.compare_digest(hash_password(password, row["salt"]), row["pw_hash"]):
        return row["id"]
    return None


def open_session(con, user_id):
    token = secrets.token_hex(32)
    con.execute("INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)",
                (token, user_id, now()))
    return token


def user_for_token(con, token):
    if not token:
        return None
    return con.execute(
        "SELECT u.id, u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?",
        (token,)).fetchone()


def profile(con, user_id):
    row = dict(con.execute("SELECT * FROM profiles WHERE user_id=?", (user_id,)).fetchone())
    row["weak_skills"] = json.loads(row["weak_skills"])
    row["strong_skills"] = json.loads(row["strong_skills"])
    return row


# content

QUESTION_TYPES = ("mcq", "gap", "order", "truefalse")
SECTION_TYPES = ("text", "vocab", "grammar", "exercise", "listening", "reading",
                 "speaking", "writing", "quiz", "summary", "homework", "resources")


def validate_question(q, where):
    problems = []
    t = q.get("type")
    if t not in QUESTION_TYPES:
        problems.append(f"{where}: type lạ {t!r}")
        return problems
    if not q.get("id"):
        problems.append(f"{where}: thiếu id")
    if not q.get("q"):
        problems.append(f"{where}: thiếu q")
    if t == "mcq":
        opts = q.get("options")
        if not isinstance(opts, list) or len(opts) < 2:
            problems.append(f"{where}: mcq cần options")
        elif not isinstance(q.get("answer"), int) or not 0 <= q["answer"] < len(opts):
            problems.append(f"{where}: answer phải là chỉ số option")
    elif t == "gap":
        ans = q.get("answer")
        if not isinstance(ans, list) or not all(isinstance(a, str) and a for a in ans):
            problems.append(f"{where}: gap answer phải là danh sách chuỗi")
        if "___" not in q.get("q", ""):
            problems.append(f"{where}: gap q cần ___")
    elif t == "truefalse":
        if not isinstance(q.get("answer"), bool):
            problems.append(f"{where}: truefalse answer phải là bool")
    elif t == "order":
        if not isinstance(q.get("items"), list) or not isinstance(q.get("answer"), list):
            problems.append(f"{where}: order cần items và answer")
    if not q.get("explain"):
        problems.append(f"{where}: thiếu explain")
    tag = q.get("error_tag")
    if tag and tag not in ERROR_CATEGORIES:
        problems.append(f"{where}: error_tag lạ {tag!r}")
    return problems


def validate_lesson(d):
    problems = []
    for key in ("id", "phase", "module", "week", "order", "level", "skill", "title",
                "duration_min", "objectives", "intro", "sections"):
        if key not in d:
            problems.append(f"thiếu trường {key}")
    if problems:
        return problems
    if d["level"] not in LEVELS:
        problems.append(f"level lạ {d['level']!r}")
    if d["skill"] not in ACTIVITIES + ("culture",):
        problems.append(f"skill lạ {d['skill']!r}")
    if not isinstance(d["sections"], list) or not d["sections"]:
        problems.append("sections rỗng")
        return problems
    types = [s.get("type") for s in d["sections"]]
    for s_idx, s in enumerate(d["sections"]):
        where = f"section {s_idx} ({s.get('type')})"
        if s.get("type") not in SECTION_TYPES:
            problems.append(f"{where}: type lạ")
            continue
        if s["type"] in ("exercise", "quiz", "listening", "reading"):
            qs = s.get("questions", [])
            if not qs:
                problems.append(f"{where}: không có câu hỏi")
            for q in qs:
                problems += validate_question(q, f"{where} câu {q.get('id')}")
        src = s.get("source") or {}
        if src and (not src.get("name") or not str(src.get("url", "")).startswith("http")
                    or not str(src.get("audio", "http")).startswith("http")):
            problems.append(f"{where}: source cần name, url http và audio http nếu có")
        if s["type"] == "listening" and not s.get("text") and not src:
            problems.append(f"{where}: thiếu text hoặc source")
        if s["type"] == "reading" and not s.get("text"):
            problems.append(f"{where}: thiếu text")
        if s["type"] == "vocab":
            for item in s.get("items", []):
                if not item.get("fr") or not item.get("vi"):
                    problems.append(f"{where}: từ thiếu fr hoặc vi")
        if s["type"] in ("speaking", "writing") and not s.get("prompt"):
            problems.append(f"{where}: thiếu prompt")
    for required in ("quiz", "summary", "homework"):
        if required not in types:
            problems.append(f"thiếu section {required}")
    ids = [q.get("id") for s in d["sections"] for q in s.get("questions", [])]
    if len(ids) != len(set(ids)):
        problems.append("id câu hỏi trùng nhau")
    return problems


def load_content(con, strict=True):
    """Upsert every content/lessons/*.json into the lessons table."""
    count = 0
    for path in sorted(glob.glob(os.path.join(CONTENT_DIR, "lessons", "*.json"))):
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        problems = validate_lesson(d)
        if problems:
            msg = f"{os.path.basename(path)}: " + "; ".join(problems)
            if strict:
                raise ValueError(msg)
            print("WARN", msg)
            continue
        con.execute(
            "INSERT INTO lessons (id, phase, module, week, ord, level, skill, title, duration_min, data)"
            " VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,"
            " module=excluded.module, week=excluded.week, ord=excluded.ord, level=excluded.level,"
            " skill=excluded.skill, title=excluded.title, duration_min=excluded.duration_min,"
            " data=excluded.data",
            (d["id"], d["phase"], d["module"], d["week"], d["order"], d["level"], d["skill"],
             d["title"], d["duration_min"], json.dumps(d, ensure_ascii=False)))
        count += 1
    con.commit()
    return count


def read_json(name):
    with open(os.path.join(CONTENT_DIR, name), encoding="utf-8") as f:
        return json.load(f)


def lesson(con, lesson_id):
    row = con.execute("SELECT data FROM lessons WHERE id=?", (lesson_id,)).fetchone()
    return json.loads(row["data"]) if row else None


def strip_answers(section):
    """Copy of a section without answer keys, for the client."""
    s = dict(section)
    if "questions" in s:
        s["questions"] = [{k: v for k, v in q.items() if k not in ("answer", "explain")}
                          for q in s["questions"]]
    return s


def grade(questions, answers):
    """Grade answers {qid: value}. Returns (score, max, per-question results)."""
    results = []
    score = 0
    for q in questions:
        given = answers.get(q["id"])
        ok = False
        if q["type"] == "mcq":
            ok = isinstance(given, int) and given == q["answer"]
        elif q["type"] == "gap":
            norm = _norm(given) if isinstance(given, str) else ""
            ok = norm in {_norm(a) for a in q["answer"]}
        elif q["type"] == "truefalse":
            ok = isinstance(given, bool) and given == q["answer"]
        elif q["type"] == "order":
            ok = isinstance(given, list) and given == q["answer"]
        score += 1 if ok else 0
        results.append({"id": q["id"], "ok": ok, "given": given, "answer": q["answer"],
                        "explain": q.get("explain", ""), "error_tag": q.get("error_tag")})
    return score, len(questions), results


def _norm(s):
    """Lowercase, unify apostrophes, treat ' / ' and ', ' between parts as one space."""
    s = s.strip().lower().replace("’", "'").replace("œ", "oe")
    s = re.sub(r"\s*[,/]\s*", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s.rstrip(".!?")
