"""AI tutor layer. Uses the Anthropic SDK when configured, otherwise a labelled mock."""
import json
import os

from store import ERROR_CATEGORIES

MODEL = os.environ.get("FA_MODEL", "claude-opus-5-5")
MOCK_NOTICE = ("[MÔ PHỎNG] AI chưa được cấu hình. Cài `pip install anthropic` và đặt "
               "ANTHROPIC_API_KEY (xem README). Nội dung này không phải đánh giá thật.")


class TutorError(Exception):
    pass


def configured():
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return False
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
                or os.path.isdir(os.path.expanduser("~/.config/anthropic")))


def status():
    return {"configured": configured(), "model": MODEL, "mock": not configured()}


ERROR_ITEM = {
    "type": "object",
    "properties": {
        "category": {"type": "string", "enum": list(ERROR_CATEGORIES)},
        "original": {"type": "string"},
        "correction": {"type": "string"},
        "explanation": {"type": "string"},
    },
    "required": ["category", "original", "correction", "explanation"],
    "additionalProperties": False,
}
VOCAB_ITEM = {
    "type": "object",
    "properties": {"fr": {"type": "string"}, "vi": {"type": "string"}, "example": {"type": "string"}},
    "required": ["fr", "vi", "example"],
    "additionalProperties": False,
}
SCORE = {"type": "integer", "minimum": 0, "maximum": 100}
LEVEL = {"type": "string", "enum": ["A2", "B1", "B2", "C1", "C2"]}

CHAT_SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {"type": "string"},
        "errors": {"type": "array", "items": ERROR_ITEM},
        "vocab": {"type": "array", "items": VOCAB_ITEM},
    },
    "required": ["reply", "errors", "vocab"],
    "additionalProperties": False,
}

SPEAKING_SCHEMA = {
    "type": "object",
    "properties": {
        "scores": {
            "type": "object",
            "properties": {"fluency": SCORE, "grammar": SCORE, "vocabulary": SCORE,
                           "argumentation": SCORE, "overall": SCORE},
            "required": ["fluency", "grammar", "vocabulary", "argumentation", "overall"],
            "additionalProperties": False,
        },
        "level_estimate": LEVEL,
        "errors": {"type": "array", "items": ERROR_ITEM},
        "better_phrasings": {
            "type": "array",
            "items": {"type": "object",
                      "properties": {"original": {"type": "string"}, "improved": {"type": "string"},
                                     "why": {"type": "string"}},
                      "required": ["original", "improved", "why"], "additionalProperties": False},
        },
        "strengths": {"type": "array", "items": {"type": "string"}},
        "weak_points": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
        "followup_question": {"type": "string"},
    },
    "required": ["scores", "level_estimate", "errors", "better_phrasings", "strengths",
                 "weak_points", "summary", "followup_question"],
    "additionalProperties": False,
}

WRITING_SCHEMA = {
    "type": "object",
    "properties": {
        "corrected_text": {"type": "string"},
        "upgraded_text": {"type": "string"},
        "errors": {"type": "array", "items": ERROR_ITEM},
        "scores": {
            "type": "object",
            "properties": {"grammar": SCORE, "lexis": SCORE, "coherence": SCORE, "cohesion": SCORE,
                           "argumentation": SCORE, "style": SCORE, "overall": SCORE},
            "required": ["grammar", "lexis", "coherence", "cohesion", "argumentation", "style",
                         "overall"],
            "additionalProperties": False,
        },
        "level_estimate": LEVEL,
        "exercises": {
            "type": "array",
            "items": {"type": "object",
                      "properties": {"instruction": {"type": "string"}, "answer": {"type": "string"}},
                      "required": ["instruction", "answer"], "additionalProperties": False},
        },
        "summary": {"type": "string"},
    },
    "required": ["corrected_text", "upgraded_text", "errors", "scores", "level_estimate",
                 "exercises", "summary"],
    "additionalProperties": False,
}

BASE = """Tu es le tuteur de French Academy, une plateforme d'apprentissage du français (FLE) de B1 vers C1.
L'apprenant est vietnamien, niveau actuel {level}, objectif {target}. Il étudie 4 à 4,5 heures par jour.
Langue des explications : {explain}. Les exemples et les exercices sont toujours en français.
Règles :
- Sois précis sur la langue française. Ne jamais inventer une règle. Si une forme est acceptable à l'oral mais pas à l'écrit, dis-le.
- Adapte la difficulté au niveau {level}, avec une marche vers le niveau suivant.
- Catégorise chaque erreur avec une seule catégorie de la liste : {cats}.
- Ne surestime pas le niveau : B2 et C1 se démontrent dans des tâches, pas dans le nombre de leçons faites.
- Réponds de façon courte et concrète. Pas de flatterie."""

MODES = {
    "grammar": """Mode : Grammar Tutor.
Explique la grammaire dans la langue des explications, avec des exemples en français. Propose un petit exercice de 3 à 5 phrases quand c'est utile, corrige les réponses de l'apprenant, compare les structures qui se confondent (passé composé / imparfait, subjonctif / indicatif, qui / que / dont, etc.).
Remplis `errors` avec les erreurs trouvées dans le message de l'apprenant quand il écrit en français.""",
    "vocab": """Mode : Vocabulary Tutor.
Enseigne le vocabulaire par thème : sens, contexte, synonymes, antonymes, collocations, registre. Vérifie que l'apprenant sait employer le mot dans une phrase. Remplis `vocab` avec les mots nouveaux importants de ta réponse (fr, vi, example) pour que la plateforme en fasse des flashcards. Remplis `errors` avec les erreurs du message de l'apprenant.""",
    "speaking": """Mode : Speaking Tutor.
Tu dialogues en français, à l'oral (l'apprenant parle, son texte est une transcription automatique : ignore la ponctuation et les majuscules manquantes, ne compte pas les fautes d'orthographe comme erreurs). Pose une question à la fois, au niveau de l'apprenant, puis une question de relance plus exigeante. Simule des situations réelles ou un entretien. Dans `reply`, mets d'abord une correction brève des erreurs importantes (une ou deux), puis ta réplique. Remplis `errors` pour chaque erreur de grammaire ou de formulation, pas de prononciation (tu n'entends pas l'audio).""",
    "writing": """Mode : Writing Tutor.
Aide à planifier, structurer et améliorer un texte : cohérence, cohésion, argumentation, style académique, reformulation. Si l'apprenant colle un texte, corrige-le et explique les erreurs dans `errors`. Pour une correction complète avec notes, l'apprenant doit utiliser le Writing Lab ; dis-le lui une fois.""",
    "examiner": """Mode : Examinateur DALF C1.
Tu joues l'examinateur de la production orale du DALF C1 : exposé à partir d'un dossier, puis débat. Tu donnes un sujet (ou tu reprends celui de l'apprenant), tu laisses parler, tu poses des questions de relance et de contradiction, tu restes neutre et exigeant. Tu évalues avec la grille officielle : respect de la consigne, organisation de l'exposé, richesse et précision du lexique, correction morphosyntaxique, interaction (défense du point de vue, réaction aux objections). Tu ne donnes pas de note pendant l'épreuve ; à la fin, sur demande, tu donnes une évaluation par critère sur 25 et un niveau estimé avec son degré de confiance.""",
}


def _call(system, messages, schema, max_tokens=8000):
    import anthropic
    try:
        client = anthropic.Anthropic()
        resp = client.beta.messages.create(
            model=MODEL,
            max_tokens=max_tokens,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=messages,
            output_config={"effort": "medium",
                           "format": {"type": "json_schema", "schema": schema}},
        )
    except anthropic.AuthenticationError:
        raise TutorError("Khoá API không hợp lệ (AuthenticationError).")
    except anthropic.RateLimitError:
        raise TutorError("API đang giới hạn tốc độ, thử lại sau một phút.")
    except anthropic.APIStatusError as e:
        raise TutorError(f"API trả lỗi {e.status_code}: {e.message}")
    except anthropic.APIConnectionError:
        raise TutorError("Không kết nối được tới API.")
    if resp.stop_reason == "refusal":
        raise TutorError("AI từ chối yêu cầu này.")
    if resp.stop_reason == "max_tokens":
        raise TutorError("Câu trả lời quá dài, bị cắt. Thử lại với nội dung ngắn hơn.")
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise TutorError("AI trả về dữ liệu không đọc được.")


def _system(mode, prof):
    explain = "vietnamien" if prof.get("explain_lang", "vi") == "vi" else "français"
    base = BASE.format(level=prof.get("current_level", "B1"), target=prof.get("target_level", "C1"),
                       explain=explain, cats=", ".join(ERROR_CATEGORIES))
    return base + "\n\n" + MODES[mode]


def chat(mode, history, user_text, prof):
    """history: list of {role, content}. Returns dict with reply, errors, vocab, mock flag."""
    if mode not in MODES:
        raise TutorError("Chế độ không tồn tại")
    if not configured():
        return {"mock": True, "errors": [], "vocab": [],
                "reply": MOCK_NOTICE + f"\n\nBạn viết ({mode}): « {user_text[:200]} »"}
    messages = [{"role": m["role"], "content": m["content"]} for m in history[-20:]]
    messages.append({"role": "user", "content": user_text})
    out = _call(_system(mode, prof), messages, CHAT_SCHEMA)
    out["mock"] = False
    return out


def assess_speaking(transcript, topic, duration_s, prof, rubric="general"):
    if not configured():
        return {"mock": True, "summary": MOCK_NOTICE, "scores": None, "errors": [],
                "better_phrasings": [], "strengths": [], "weak_points": [],
                "level_estimate": None, "followup_question": ""}
    rubric_text = ("Évalue avec la grille DALF C1 production orale (exposé puis débat)."
                   if rubric == "dalf_c1" else
                   "Évalue par rapport au niveau CECRL de l'apprenant et au niveau visé.")
    system = _system("speaking", prof) + f"""

Tâche : évaluer une production orale. {rubric_text}
Le texte est une transcription automatique (reconnaissance vocale) : ne compte ni la ponctuation, ni l'orthographe, ni la prononciation. Tu n'as pas l'audio : la prononciation n'est PAS évaluée.
Scores sur 100 : fluency (débit, hésitations visibles par les répétitions et phrases inachevées), grammar, vocabulary (richesse, précision), argumentation (structure, exemples, nuance). overall = moyenne pondérée.
level_estimate = niveau CECRL démontré dans cette production seule.
summary : 3 à 5 phrases dans la langue des explications. followup_question : une question de relance en français."""
    user = (f"Sujet : {topic}\nDurée : {duration_s} s\nNiveau déclaré : {prof.get('current_level')}\n\n"
            f"Transcription :\n{transcript}")
    out = _call(system, [{"role": "user", "content": user}], SPEAKING_SCHEMA)
    out["mock"] = False
    out["pronunciation"] = "not_assessed"
    return out


def assess_writing(body, topic, prof, criteria=None):
    if not configured():
        return {"mock": True, "summary": MOCK_NOTICE, "scores": None, "errors": [],
                "corrected_text": "", "upgraded_text": "", "exercises": [], "level_estimate": None}
    crit = ("\nCritères de la consigne : " + "; ".join(criteria)) if criteria else ""
    system = _system("writing", prof) + f"""

Tâche : corriger et évaluer une production écrite.{crit}
- corrected_text : le texte de l'apprenant avec les erreurs corrigées, sans réécrire le style.
- upgraded_text : une version améliorée au niveau supérieur (lexique plus précis, connecteurs, structure), même longueur environ.
- errors : chaque erreur avec sa catégorie, l'extrait original, la correction et une explication courte dans la langue des explications.
- scores sur 100 : grammar, lexis, coherence, cohesion, argumentation, style. overall = moyenne.
- level_estimate : niveau CECRL démontré par ce texte seul.
- exercises : 2 à 4 exercices courts ciblant les erreurs les plus fréquentes, avec la réponse.
- summary : 3 à 5 phrases dans la langue des explications."""
    user = f"Sujet : {topic}\nNiveau déclaré : {prof.get('current_level')}\n\nTexte :\n{body}"
    out = _call(system, [{"role": "user", "content": user}], WRITING_SCHEMA)
    out["mock"] = False
    return out
