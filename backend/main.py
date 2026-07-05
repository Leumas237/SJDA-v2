"""SJDA — application de rencontre/amitié pour l'école.

Lancement : uvicorn backend.main:app --host 0.0.0.0 --port 8000
"""
import json
import secrets
from pathlib import Path

from fastapi import (
    FastAPI,
    HTTPException,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, Field

from . import auth, config
from .db import get_db, init_db

app = FastAPI(title=config.APP_NAME)
init_db()

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

VALID_INTENTS = {"amis", "couple", "les_deux"}
VALID_GENDERS = {"", "fille", "garcon", "autre"}
VALID_SEEKING = {"filles", "garcons", "tous"}


# ---------------------------------------------------------------- schémas

class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    name: str = Field(min_length=2, max_length=60)
    invite_code: str = ""


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class ProfileIn(BaseModel):
    bio: str = Field(default="", max_length=500)
    classe: str = Field(default="", max_length=40)
    interests: list[str] = Field(default_factory=list, max_length=12)
    intent: str = "les_deux"
    gender: str = ""
    seeking: str = "tous"


class SwipeIn(BaseModel):
    target_id: int
    liked: bool


class MessageIn(BaseModel):
    content: str = Field(min_length=1, max_length=2000)


# ---------------------------------------------------------------- helpers

def profile_dict(row) -> dict:
    return {
        "user_id": row["user_id"],
        "name": row["name"],
        "bio": row["bio"],
        "classe": row["classe"],
        "interests": json.loads(row["interests"]),
        "intent": row["intent"],
        "gender": row["gender"],
        "seeking": row["seeking"],
        "photo": f"/uploads/{row['photo']}" if row["photo"] else "",
    }


def school_check(email: str, invite_code: str) -> None:
    """L'inscription passe si l'email est du domaine de l'école
    OU si le code d'invitation est correct."""
    domain_ok = bool(config.EMAIL_DOMAIN) and email.lower().endswith(
        "@" + config.EMAIL_DOMAIN
    )
    code_ok = bool(config.INVITE_CODE) and secrets.compare_digest(
        invite_code.strip(), config.INVITE_CODE
    )
    if not (domain_ok or code_ok):
        detail = "Inscription réservée aux élèves de l'école"
        if config.INVITE_CODE:
            detail += " : code d'invitation invalide"
        if config.EMAIL_DOMAIN:
            detail += f" (ou utilise ton email @{config.EMAIL_DOMAIN})"
        raise HTTPException(status_code=403, detail=detail)


def get_match_or_404(db, match_id: int, user_id: int):
    match = db.execute(
        "SELECT * FROM matches WHERE id = ? AND (user_a = ? OR user_b = ?)",
        (match_id, user_id, user_id),
    ).fetchone()
    if not match:
        raise HTTPException(status_code=404, detail="Match introuvable")
    return match


# ---------------------------------------------------------------- auth

@app.post("/api/register")
def register(body: RegisterIn):
    school_check(body.email, body.invite_code)
    salt = auth.new_salt()
    pw_hash = auth.hash_password(body.password, salt)
    with get_db() as db:
        try:
            cur = db.execute(
                "INSERT INTO users (email, password_hash, salt, name) VALUES (?, ?, ?, ?)",
                (body.email.lower(), pw_hash, salt, body.name.strip()),
            )
        except Exception:
            raise HTTPException(status_code=409, detail="Cet email est déjà inscrit")
        user_id = cur.lastrowid
        db.execute("INSERT INTO profiles (user_id) VALUES (?)", (user_id,))
    return {"token": auth.create_session(user_id), "user_id": user_id}


@app.post("/api/login")
def login(body: LoginIn):
    with get_db() as db:
        user = db.execute(
            "SELECT * FROM users WHERE email = ?", (body.email.lower(),)
        ).fetchone()
    if not user or not auth.verify_password(
        body.password, user["salt"], user["password_hash"]
    ):
        raise HTTPException(status_code=401, detail="Email ou mot de passe incorrect")
    return {"token": auth.create_session(user["id"]), "user_id": user["id"]}


@app.get("/api/config")
def app_config():
    return {
        "app_name": config.APP_NAME,
        "email_domain": config.EMAIL_DOMAIN,
        "invite_required": bool(config.INVITE_CODE) or bool(config.EMAIL_DOMAIN),
    }


# ---------------------------------------------------------------- profil

@app.get("/api/me")
def me(user_id: int = auth.CurrentUser):
    with get_db() as db:
        row = db.execute(
            "SELECT p.*, u.name FROM profiles p JOIN users u ON u.id = p.user_id "
            "WHERE p.user_id = ?",
            (user_id,),
        ).fetchone()
    return profile_dict(row)


@app.put("/api/profile")
def update_profile(body: ProfileIn, user_id: int = auth.CurrentUser):
    if body.intent not in VALID_INTENTS:
        raise HTTPException(status_code=422, detail="Intention invalide")
    if body.gender not in VALID_GENDERS:
        raise HTTPException(status_code=422, detail="Genre invalide")
    if body.seeking not in VALID_SEEKING:
        raise HTTPException(status_code=422, detail="Préférence invalide")
    interests = [t.strip()[:30] for t in body.interests if t.strip()][:12]
    with get_db() as db:
        db.execute(
            "UPDATE profiles SET bio = ?, classe = ?, interests = ?, intent = ?, "
            "gender = ?, seeking = ? WHERE user_id = ?",
            (
                body.bio.strip(),
                body.classe.strip(),
                json.dumps(interests, ensure_ascii=False),
                body.intent,
                body.gender,
                body.seeking,
                user_id,
            ),
        )
    return {"ok": True}


@app.post("/api/profile/photo")
async def upload_photo(photo: UploadFile, user_id: int = auth.CurrentUser):
    ext = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}.get(
        photo.content_type
    )
    if not ext:
        raise HTTPException(status_code=415, detail="Formats acceptés : JPEG, PNG, WebP")
    data = await photo.read()
    if len(data) > config.MAX_PHOTO_BYTES:
        raise HTTPException(status_code=413, detail="Photo trop lourde (max 5 Mo)")
    filename = f"u{user_id}_{secrets.token_hex(8)}{ext}"
    (config.UPLOADS_DIR / filename).write_bytes(data)
    with get_db() as db:
        old = db.execute(
            "SELECT photo FROM profiles WHERE user_id = ?", (user_id,)
        ).fetchone()
        db.execute(
            "UPDATE profiles SET photo = ? WHERE user_id = ?", (filename, user_id)
        )
    if old and old["photo"]:
        (config.UPLOADS_DIR / old["photo"]).unlink(missing_ok=True)
    return {"photo": f"/uploads/{filename}"}


# ---------------------------------------------------------------- découverte

def intents_compatible(a: str, b: str) -> bool:
    return a == "les_deux" or b == "les_deux" or a == b


def seeking_ok(seeker_pref: str, target_gender: str) -> bool:
    if seeker_pref == "tous" or not target_gender or target_gender == "autre":
        return True
    return {"filles": "fille", "garcons": "garcon"}[seeker_pref] == target_gender


@app.get("/api/discover")
def discover(user_id: int = auth.CurrentUser):
    with get_db() as db:
        my = db.execute(
            "SELECT * FROM profiles WHERE user_id = ?", (user_id,)
        ).fetchone()
        rows = db.execute(
            "SELECT p.*, u.name FROM profiles p JOIN users u ON u.id = p.user_id "
            "WHERE p.user_id != ? "
            "AND p.user_id NOT IN (SELECT target_id FROM swipes WHERE swiper_id = ?) "
            "ORDER BY RANDOM() LIMIT 30",
            (user_id, user_id),
        ).fetchall()
    candidates = []
    for row in rows:
        if not intents_compatible(my["intent"], row["intent"]):
            continue
        # Les préférences de genre ne s'appliquent qu'en contexte "couple"
        romantic = my["intent"] != "amis" and row["intent"] != "amis"
        if romantic and not (
            seeking_ok(my["seeking"], row["gender"])
            and seeking_ok(row["seeking"], my["gender"])
        ):
            continue
        candidates.append(profile_dict(row))
    return candidates[:15]


@app.post("/api/swipe")
def swipe(body: SwipeIn, user_id: int = auth.CurrentUser):
    if body.target_id == user_id:
        raise HTTPException(status_code=422, detail="Impossible de se swiper soi-même")
    with get_db() as db:
        target = db.execute(
            "SELECT id FROM users WHERE id = ?", (body.target_id,)
        ).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="Utilisateur introuvable")
        db.execute(
            "INSERT OR REPLACE INTO swipes (swiper_id, target_id, liked) VALUES (?, ?, ?)",
            (user_id, body.target_id, int(body.liked)),
        )
        matched = False
        match_id = None
        if body.liked:
            reciprocal = db.execute(
                "SELECT 1 FROM swipes WHERE swiper_id = ? AND target_id = ? AND liked = 1",
                (body.target_id, user_id),
            ).fetchone()
            if reciprocal:
                a, b = sorted((user_id, body.target_id))
                db.execute(
                    "INSERT OR IGNORE INTO matches (user_a, user_b) VALUES (?, ?)",
                    (a, b),
                )
                match_id = db.execute(
                    "SELECT id FROM matches WHERE user_a = ? AND user_b = ?", (a, b)
                ).fetchone()["id"]
                matched = True
    if matched:
        notify_user(body.target_id, {"type": "match", "match_id": match_id})
    return {"matched": matched, "match_id": match_id}


# ---------------------------------------------------------------- matchs & chat

@app.get("/api/matches")
def list_matches(user_id: int = auth.CurrentUser):
    with get_db() as db:
        rows = db.execute(
            """
            SELECT m.id AS match_id, m.created_at,
                   p.*, u.name,
                   (SELECT content FROM messages WHERE match_id = m.id
                    ORDER BY id DESC LIMIT 1) AS last_message
            FROM matches m
            JOIN profiles p ON p.user_id = CASE WHEN m.user_a = ? THEN m.user_b ELSE m.user_a END
            JOIN users u ON u.id = p.user_id
            WHERE m.user_a = ? OR m.user_b = ?
            ORDER BY m.id DESC
            """,
            (user_id, user_id, user_id),
        ).fetchall()
    return [
        {
            "match_id": row["match_id"],
            "since": row["created_at"],
            "last_message": row["last_message"],
            "profile": profile_dict(row),
        }
        for row in rows
    ]


@app.get("/api/matches/{match_id}/messages")
def get_messages(match_id: int, after: int = 0, user_id: int = auth.CurrentUser):
    with get_db() as db:
        get_match_or_404(db, match_id, user_id)
        rows = db.execute(
            "SELECT id, sender_id, content, created_at FROM messages "
            "WHERE match_id = ? AND id > ? ORDER BY id LIMIT 200",
            (match_id, after),
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/matches/{match_id}/messages")
def send_message(match_id: int, body: MessageIn, user_id: int = auth.CurrentUser):
    with get_db() as db:
        match = get_match_or_404(db, match_id, user_id)
        cur = db.execute(
            "INSERT INTO messages (match_id, sender_id, content) VALUES (?, ?, ?)",
            (match_id, user_id, body.content.strip()),
        )
        msg = db.execute(
            "SELECT id, sender_id, content, created_at FROM messages WHERE id = ?",
            (cur.lastrowid,),
        ).fetchone()
    other = match["user_b"] if match["user_a"] == user_id else match["user_a"]
    notify_user(other, {"type": "message", "match_id": match_id, "message": dict(msg)})
    return dict(msg)


# ---------------------------------------------------------------- websocket

connections: dict[int, set[WebSocket]] = {}
pending_notifications: list[tuple[int, dict]] = []


def notify_user(target_user_id: int, payload: dict) -> None:
    """Enregistre une notification à pousser ; l'envoi effectif est async."""
    import asyncio

    for ws in list(connections.get(target_user_id, ())):
        try:
            asyncio.get_running_loop().create_task(ws.send_json(payload))
        except RuntimeError:
            pass  # pas de boucle async (tests) : le client verra via polling


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str = ""):
    user_id = auth.user_id_from_token(token)
    if user_id is None:
        await ws.close(code=4401)
        return
    await ws.accept()
    connections.setdefault(user_id, set()).add(ws)
    try:
        while True:
            await ws.receive_text()  # keep-alive ; l'envoi passe par l'API REST
    except WebSocketDisconnect:
        pass
    finally:
        connections.get(user_id, set()).discard(ws)


# ---------------------------------------------------------------- statique

app.mount("/uploads", StaticFiles(directory=config.UPLOADS_DIR), name="uploads")
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/manifest.json", include_in_schema=False)
def manifest():
    return FileResponse(FRONTEND_DIR / "manifest.json")


@app.get("/sw.js", include_in_schema=False)
def service_worker():
    return FileResponse(FRONTEND_DIR / "sw.js", media_type="application/javascript")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(FRONTEND_DIR / "index.html")
