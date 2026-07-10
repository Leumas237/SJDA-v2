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

from . import push  # noqa: E402  (génère les clés VAPID, a besoin du dossier data)

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
    instagram: str = Field(default="", max_length=60)
    snapchat: str = Field(default="", max_length=60)
    whatsapp: str = Field(default="", max_length=25)
    age: int = Field(default=0, ge=0, le=99)


class SwipeIn(BaseModel):
    target_id: int
    liked: bool


class ReportIn(BaseModel):
    match_id: int
    reason: str = Field(default="", max_length=500)


class ReportActionIn(BaseModel):
    action: str  # ban | dismiss


class ApproveIn(BaseModel):
    approve: bool


class BanIn(BaseModel):
    banned: bool


# ---------------------------------------------------------------- helpers

def profile_dict(row, socials: bool = False, photos: list[str] | None = None) -> dict:
    """Fiche profil. Les réseaux sociaux (`socials=True`) ne sont exposés
    qu'au propriétaire du profil et aux personnes matchées avec lui."""
    photos = photos or []
    if not photos and row["photo"]:  # compat anciens comptes à photo unique
        photos = [f"/uploads/{row['photo']}"]
    d = {
        "user_id": row["user_id"],
        "name": row["name"],
        "bio": row["bio"],
        "classe": row["classe"],
        "interests": json.loads(row["interests"]),
        "intent": row["intent"],
        "gender": row["gender"],
        "seeking": row["seeking"],
        "photos": photos,
        "photo": photos[0] if photos else "",
        "age": row["age"] or None,
    }
    if socials:
        d["instagram"] = row["instagram"]
        d["snapchat"] = row["snapchat"]
        d["whatsapp"] = row["whatsapp"]
    return d


def photos_map(db, user_ids: list[int]) -> dict[int, list[str]]:
    """URLs des photos de chaque utilisateur, dans l'ordre."""
    if not user_ids:
        return {}
    marks = ",".join("?" * len(user_ids))
    rows = db.execute(
        f"SELECT user_id, filename FROM photos WHERE user_id IN ({marks}) "
        "ORDER BY position, id",
        user_ids,
    ).fetchall()
    result: dict[int, list[str]] = {}
    for r in rows:
        result.setdefault(r["user_id"], []).append(f"/uploads/{r['filename']}")
    return result


def mod_code_ok(invite_code: str) -> bool:
    return bool(config.MOD_CODE) and secrets.compare_digest(
        invite_code.strip(), config.MOD_CODE
    )


def student_email_ok(email: str) -> bool:
    return any(email.endswith("@" + d) for d in config.EMAIL_DOMAINS)


def get_match_or_404(db, match_id: int, user_id: int):
    match = db.execute(
        "SELECT * FROM matches WHERE id = ? AND closed = 0 AND (user_a = ? OR user_b = ?)",
        (match_id, user_id, user_id),
    ).fetchone()
    if not match:
        raise HTTPException(status_code=404, detail="Match introuvable")
    return match


def log_activity(db, type_: str, text: str) -> dict:
    """Journalise un événement et le pousse en direct aux admins connectés."""
    cur = db.execute(
        "INSERT INTO activity (type, text) VALUES (?, ?)", (type_, text)
    )
    event = db.execute(
        "SELECT id, type, text, created_at FROM activity WHERE id = ?",
        (cur.lastrowid,),
    ).fetchone()
    notify_admins({"type": "activity", "event": dict(event)})
    return dict(event)


# ---------------------------------------------------------------- auth

@app.post("/api/register")
def register(body: RegisterIn):
    email = body.email.lower()
    # le bon code (optionnel) fait de toi un modérateur ; sinon il faut
    # un email étudiant de l'école
    code_ok = mod_code_ok(body.invite_code)
    admin_listed = email in config.ADMIN_EMAILS
    if not (student_email_ok(email) or code_ok or admin_listed):
        domains = ", ".join("@" + d for d in sorted(config.EMAIL_DOMAINS))
        raise HTTPException(
            status_code=403,
            detail=f"Inscris-toi avec ton email étudiant ({domains})",
        )
    salt = auth.new_salt()
    pw_hash = auth.hash_password(body.password, salt)
    is_admin = int(admin_listed or code_ok)
    name = body.name.strip()
    with get_db() as db:
        try:
            cur = db.execute(
                "INSERT INTO users (email, password_hash, salt, name, is_admin, approved) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                # les admins sont validés d'office ; les élèves attendent
                (email, pw_hash, salt, name, is_admin, is_admin),
            )
        except Exception:
            raise HTTPException(status_code=409, detail="Cet email est déjà inscrit")
        user_id = cur.lastrowid
        db.execute("INSERT INTO profiles (user_id) VALUES (?)", (user_id,))
        if is_admin:
            log_activity(db, "signup", f"{name} s'est inscrit·e")
        else:
            log_activity(db, "signup_request", f"⏳ {name} demande à s'inscrire")
            push.push_to_users(
                admin_ids(db), "Nouvelle demande d'inscription",
                f"{name} veut rejoindre {config.APP_NAME}",
            )
    return {"token": auth.create_session(user_id), "user_id": user_id}


def admin_ids(db) -> list[int]:
    return [r["id"] for r in db.execute(
        "SELECT id FROM users WHERE is_admin = 1"
    ).fetchall()]


@app.post("/api/login")
def login(body: LoginIn):
    email = body.email.lower()
    with get_db() as db:
        user = db.execute(
            "SELECT * FROM users WHERE email = ?", (email,)
        ).fetchone()
        if not user or not auth.verify_password(
            body.password, user["salt"], user["password_hash"]
        ):
            raise HTTPException(status_code=401, detail="Email ou mot de passe incorrect")
        if user["banned"]:
            raise HTTPException(status_code=403, detail="Ce compte a été suspendu")
        # promotion automatique si l'email est ajouté à SJDA_ADMIN_EMAILS
        # (jamais de rétrogradation ici : les modos par code le restent)
        if not user["is_admin"] and email in config.ADMIN_EMAILS:
            db.execute(
                "UPDATE users SET is_admin = 1, approved = 1 WHERE id = ?",
                (user["id"],),
            )
    return {"token": auth.create_session(user["id"]), "user_id": user["id"]}


@app.get("/api/config")
def app_config():
    return {
        "app_name": config.APP_NAME,
        "email_domains": sorted(config.EMAIL_DOMAINS),
    }


# ---------------------------------------------------------------- profil

@app.get("/api/me")
def me(user_id: int = auth.CurrentUser):
    with get_db() as db:
        row = db.execute(
            "SELECT p.*, u.name, u.is_admin, u.approved FROM profiles p "
            "JOIN users u ON u.id = p.user_id WHERE p.user_id = ?",
            (user_id,),
        ).fetchone()
        my_photos = [
            {"id": r["id"], "url": f"/uploads/{r['filename']}"}
            for r in db.execute(
                "SELECT id, filename FROM photos WHERE user_id = ? "
                "ORDER BY position, id",
                (user_id,),
            ).fetchall()
        ]
    return {
        **profile_dict(row, socials=True, photos=[p["url"] for p in my_photos]),
        "my_photos": my_photos,
        "is_admin": bool(row["is_admin"]),
        "approved": bool(row["approved"]),
    }


@app.put("/api/profile")
def update_profile(body: ProfileIn, user_id: int = auth.CurrentUser):
    if body.intent not in VALID_INTENTS:
        raise HTTPException(status_code=422, detail="Intention invalide")
    if body.gender not in VALID_GENDERS:
        raise HTTPException(status_code=422, detail="Genre invalide")
    if body.seeking not in VALID_SEEKING:
        raise HTTPException(status_code=422, detail="Préférence invalide")
    if body.age and not (15 <= body.age <= 30):
        raise HTTPException(status_code=422, detail="Âge entre 15 et 30 ans")
    interests = [t.strip()[:30] for t in body.interests if t.strip()][:12]
    instagram = body.instagram.strip().lstrip("@")
    snapchat = body.snapchat.strip().lstrip("@")
    whatsapp = "".join(c for c in body.whatsapp if c.isdigit() or c == "+")
    with get_db() as db:
        db.execute(
            "UPDATE profiles SET bio = ?, classe = ?, interests = ?, intent = ?, "
            "gender = ?, seeking = ?, instagram = ?, snapchat = ?, whatsapp = ?, "
            "age = ? WHERE user_id = ?",
            (
                body.bio.strip(),
                body.classe.strip(),
                json.dumps(interests, ensure_ascii=False),
                body.intent,
                body.gender,
                body.seeking,
                instagram,
                snapchat,
                whatsapp,
                body.age,
                user_id,
            ),
        )
    return {"ok": True}


MAX_PHOTOS = 6


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
    with get_db() as db:
        count = db.execute(
            "SELECT COUNT(*) c FROM photos WHERE user_id = ?", (user_id,)
        ).fetchone()["c"]
        if count >= MAX_PHOTOS:
            raise HTTPException(
                status_code=409, detail=f"Maximum {MAX_PHOTOS} photos"
            )
        (config.UPLOADS_DIR / filename).write_bytes(data)
        cur = db.execute(
            "INSERT INTO photos (user_id, filename, position) VALUES (?, ?, ?)",
            (user_id, filename, count),
        )
    return {"id": cur.lastrowid, "url": f"/uploads/{filename}"}


@app.delete("/api/profile/photos/{photo_id}")
def delete_photo(photo_id: int, user_id: int = auth.CurrentUser):
    with get_db() as db:
        row = db.execute(
            "SELECT filename FROM photos WHERE id = ? AND user_id = ?",
            (photo_id, user_id),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Photo introuvable")
        db.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
    (config.UPLOADS_DIR / row["filename"]).unlink(missing_ok=True)
    return {"ok": True}


# ---------------------------------------------------------------- découverte

def intents_compatible(a: str, b: str) -> bool:
    return a == "les_deux" or b == "les_deux" or a == b


def seeking_ok(seeker_pref: str, target_gender: str) -> bool:
    if seeker_pref == "tous" or not target_gender or target_gender == "autre":
        return True
    return {"filles": "fille", "garcons": "garcon"}[seeker_pref] == target_gender


@app.get("/api/discover")
def discover(
    age_min: int = 0,
    age_max: int = 0,
    classe: str = "",
    user_id: int = auth.CurrentApproved,
):
    """Candidats compatibles, filtrables par âge et classe.

    Les filtres d'âge n'excluent pas les profils sans âge renseigné."""
    with get_db() as db:
        my = db.execute(
            "SELECT * FROM profiles WHERE user_id = ?", (user_id,)
        ).fetchone()
        rows = db.execute(
            "SELECT p.*, u.name FROM profiles p JOIN users u ON u.id = p.user_id "
            "WHERE p.user_id != ? AND u.banned = 0 AND u.approved = 1 "
            "AND p.user_id NOT IN (SELECT target_id FROM swipes WHERE swiper_id = ?) "
            "ORDER BY RANDOM() LIMIT 60",
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
            if row["age"]:
                if age_min and row["age"] < age_min:
                    continue
                if age_max and row["age"] > age_max:
                    continue
            if classe.strip() and classe.strip().lower() not in row["classe"].lower():
                continue
            candidates.append(row)
        candidates = candidates[:15]
        pmap = photos_map(db, [r["user_id"] for r in candidates])
    return [profile_dict(r, photos=pmap.get(r["user_id"], [])) for r in candidates]


@app.post("/api/swipe")
def swipe(body: SwipeIn, user_id: int = auth.CurrentApproved):
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
                names = {
                    r["id"]: r["name"]
                    for r in db.execute(
                        "SELECT id, name FROM users WHERE id IN (?, ?)", (a, b)
                    ).fetchall()
                }
                log_activity(db, "match", f"Match entre {names[a]} et {names[b]}")
    if matched:
        notify_user(body.target_id, {"type": "match", "match_id": match_id})
        push.push_to_users(
            [body.target_id],
            "C'est un match ! 🎉",
            f"{names[user_id]} et toi vous êtes likés mutuellement. "
            "Ses réseaux sont débloqués !",
        )
    return {"matched": matched, "match_id": match_id}


@app.post("/api/rewind")
def rewind(user_id: int = auth.CurrentApproved):
    """Annule le dernier swipe (façon Tinder) et rend la carte."""
    with get_db() as db:
        last = db.execute(
            "SELECT * FROM swipes WHERE swiper_id = ? "
            "ORDER BY created_at DESC, rowid DESC LIMIT 1",
            (user_id,),
        ).fetchone()
        if not last:
            raise HTTPException(status_code=404, detail="Rien à annuler")
        db.execute(
            "DELETE FROM swipes WHERE swiper_id = ? AND target_id = ?",
            (user_id, last["target_id"]),
        )
        # si ce swipe avait créé un match, on le retire aussi
        a, b = sorted((user_id, last["target_id"]))
        db.execute("DELETE FROM matches WHERE user_a = ? AND user_b = ?", (a, b))
        row = db.execute(
            "SELECT p.*, u.name FROM profiles p JOIN users u ON u.id = p.user_id "
            "WHERE p.user_id = ?",
            (last["target_id"],),
        ).fetchone()
        pmap = photos_map(db, [last["target_id"]])
    return {"profile": profile_dict(row, photos=pmap.get(last["target_id"], []))}


# ---------------------------------------------------------------- matchs

@app.get("/api/matches")
def list_matches(user_id: int = auth.CurrentApproved):
    """Un match débloque les réseaux sociaux de l'autre (Insta, Snap, WhatsApp)."""
    with get_db() as db:
        rows = db.execute(
            """
            SELECT m.id AS match_id, m.created_at, p.*, u.name
            FROM matches m
            JOIN profiles p ON p.user_id = CASE WHEN m.user_a = ? THEN m.user_b ELSE m.user_a END
            JOIN users u ON u.id = p.user_id
            WHERE m.closed = 0 AND (m.user_a = ? OR m.user_b = ?)
            ORDER BY m.id DESC
            """,
            (user_id, user_id, user_id),
        ).fetchall()
        pmap = photos_map(db, [r["user_id"] for r in rows])
    return [
        {
            "match_id": row["match_id"],
            "since": row["created_at"],
            "profile": profile_dict(
                row, socials=True, photos=pmap.get(row["user_id"], [])
            ),
        }
        for row in rows
    ]


# ---------------------------------------------------------------- push

@app.get("/api/push/key")
def push_key():
    return {"key": push.public_key_b64()}


@app.post("/api/push/subscribe")
def push_subscribe(sub: dict, user_id: int = auth.CurrentUser):
    endpoint = sub.get("endpoint", "")
    if not endpoint or "keys" not in sub:
        raise HTTPException(status_code=422, detail="Abonnement invalide")
    with get_db() as db:
        db.execute(
            "INSERT OR REPLACE INTO push_subs (endpoint, user_id, sub) VALUES (?, ?, ?)",
            (endpoint, user_id, json.dumps(sub)),
        )
    return {"ok": True}


@app.post("/api/push/unsubscribe")
def push_unsubscribe(sub: dict, user_id: int = auth.CurrentUser):
    with get_db() as db:
        db.execute(
            "DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?",
            (sub.get("endpoint", ""), user_id),
        )
    return {"ok": True}


# ---------------------------------------------------------------- signalement

@app.post("/api/report")
def report(body: ReportIn, user_id: int = auth.CurrentApproved):
    """Signale l'autre membre d'un match : ferme la conversation, empêche
    de se recroiser dans la découverte, et alerte les admins."""
    with get_db() as db:
        match = get_match_or_404(db, body.match_id, user_id)
        reported = match["user_b"] if match["user_a"] == user_id else match["user_a"]
        db.execute(
            "INSERT INTO reports (reporter_id, reported_id, match_id, reason) "
            "VALUES (?, ?, ?, ?)",
            (user_id, reported, body.match_id, body.reason.strip()),
        )
        db.execute("UPDATE matches SET closed = 1 WHERE id = ?", (body.match_id,))
        for a, b in ((user_id, reported), (reported, user_id)):
            db.execute(
                "INSERT OR REPLACE INTO swipes (swiper_id, target_id, liked) "
                "VALUES (?, ?, 0)",
                (a, b),
            )
        names = {
            r["id"]: r["name"]
            for r in db.execute(
                "SELECT id, name FROM users WHERE id IN (?, ?)", (user_id, reported)
            ).fetchall()
        }
        log_activity(
            db, "report", f"⚠️ {names[user_id]} a signalé {names[reported]}"
        )
        push.push_to_users(
            admin_ids(db), "⚠️ Nouveau signalement",
            f"{names[user_id]} a signalé {names[reported]}",
        )
    return {"ok": True}


# ---------------------------------------------------------------- admin

@app.get("/api/admin/overview")
def admin_overview(admin_id: int = auth.CurrentAdmin):
    with get_db() as db:
        stats = {
            "users": db.execute(
                "SELECT COUNT(*) c FROM users WHERE approved = 1"
            ).fetchone()["c"],
            "pending_signups": db.execute(
                "SELECT COUNT(*) c FROM users WHERE approved = 0 AND banned = 0"
            ).fetchone()["c"],
            "banned": db.execute(
                "SELECT COUNT(*) c FROM users WHERE banned = 1"
            ).fetchone()["c"],
            "matches": db.execute(
                "SELECT COUNT(*) c FROM matches WHERE closed = 0"
            ).fetchone()["c"],
            "pending_reports": db.execute(
                "SELECT COUNT(*) c FROM reports WHERE status = 'pending'"
            ).fetchone()["c"],
        }
        feed = [
            dict(r)
            for r in db.execute(
                "SELECT id, type, text, created_at FROM activity "
                "ORDER BY id DESC LIMIT 40"
            ).fetchall()
        ]
    return {"stats": stats, "feed": feed}


@app.get("/api/admin/reports")
def admin_reports(admin_id: int = auth.CurrentAdmin):
    with get_db() as db:
        rows = db.execute(
            """
            SELECT r.*, ur.name AS reporter_name, ud.name AS reported_name,
                   ud.banned AS reported_banned
            FROM reports r
            JOIN users ur ON ur.id = r.reporter_id
            JOIN users ud ON ud.id = r.reported_id
            ORDER BY (r.status = 'pending') DESC, r.id DESC LIMIT 100
            """
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/api/admin/reports/{report_id}")
def admin_handle_report(
    report_id: int, body: ReportActionIn, admin_id: int = auth.CurrentAdmin
):
    if body.action not in ("ban", "dismiss"):
        raise HTTPException(status_code=422, detail="Action invalide")
    with get_db() as db:
        rep = db.execute(
            "SELECT * FROM reports WHERE id = ?", (report_id,)
        ).fetchone()
        if not rep:
            raise HTTPException(status_code=404, detail="Signalement introuvable")
        db.execute(
            "UPDATE reports SET status = ? WHERE id = ?",
            ("banned" if body.action == "ban" else "dismissed", report_id),
        )
        if body.action == "ban":
            ban_user(db, rep["reported_id"])
    return {"ok": True}


@app.get("/api/admin/pending")
def admin_pending(admin_id: int = auth.CurrentAdmin):
    """Demandes d'inscription en attente de validation."""
    with get_db() as db:
        rows = db.execute(
            "SELECT u.id, u.name, u.email, u.created_at, p.classe, p.bio "
            "FROM users u JOIN profiles p ON p.user_id = u.id "
            "WHERE u.approved = 0 AND u.banned = 0 ORDER BY u.id"
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/api/admin/users/{target_id}/approve")
def admin_approve(target_id: int, body: ApproveIn, admin_id: int = auth.CurrentAdmin):
    with get_db() as db:
        user = db.execute(
            "SELECT * FROM users WHERE id = ? AND approved = 0", (target_id,)
        ).fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="Demande introuvable")
        if body.approve:
            db.execute("UPDATE users SET approved = 1 WHERE id = ?", (target_id,))
            log_activity(db, "approve", f"✅ {user['name']} a été accepté·e")
            push.push_to_users(
                [target_id], "Inscription acceptée ✅",
                f"Bienvenue sur {config.APP_NAME} ! Tu peux commencer à swiper.",
            )
        else:
            # refus : le compte et son profil sont supprimés
            db.execute("DELETE FROM users WHERE id = ?", (target_id,))
            log_activity(db, "approve", f"❌ La demande de {user['name']} a été refusée")
    return {"ok": True}


@app.get("/api/admin/users")
def admin_users(admin_id: int = auth.CurrentAdmin):
    with get_db() as db:
        rows = db.execute(
            "SELECT u.id, u.name, u.email, u.is_admin, u.banned, u.created_at, "
            "p.classe FROM users u JOIN profiles p ON p.user_id = u.id "
            "WHERE u.approved = 1 ORDER BY u.id DESC LIMIT 500"
        ).fetchall()
    return [dict(r) for r in rows]


class ModIn(BaseModel):
    is_admin: bool


@app.post("/api/admin/users/{target_id}/mod")
def admin_mod(target_id: int, body: ModIn, admin_id: int = auth.CurrentAdmin):
    """Promeut ou rétrograde un modérateur."""
    if target_id == admin_id:
        raise HTTPException(status_code=422, detail="Impossible de se modifier soi-même")
    with get_db() as db:
        user = db.execute(
            "SELECT * FROM users WHERE id = ?", (target_id,)
        ).fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="Utilisateur introuvable")
        db.execute(
            "UPDATE users SET is_admin = ? WHERE id = ?",
            (int(body.is_admin), target_id),
        )
        verb = "promu·e modérateur·rice" if body.is_admin else "retiré·e des modérateurs"
        log_activity(db, "mod", f"🛡️ {user['name']} a été {verb}")
    return {"ok": True}


@app.post("/api/admin/users/{target_id}/ban")
def admin_ban(target_id: int, body: BanIn, admin_id: int = auth.CurrentAdmin):
    if target_id == admin_id:
        raise HTTPException(status_code=422, detail="Impossible de se bannir soi-même")
    with get_db() as db:
        user = db.execute(
            "SELECT * FROM users WHERE id = ?", (target_id,)
        ).fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="Utilisateur introuvable")
        if body.banned:
            ban_user(db, target_id)
        else:
            db.execute("UPDATE users SET banned = 0 WHERE id = ?", (target_id,))
            log_activity(db, "ban", f"{user['name']} a été rétabli·e")
    return {"ok": True}


def ban_user(db, target_id: int) -> None:
    """Suspend le compte : plus de connexion, sessions coupées,
    invisible dans la découverte."""
    user = db.execute("SELECT name FROM users WHERE id = ?", (target_id,)).fetchone()
    db.execute("UPDATE users SET banned = 1 WHERE id = ?", (target_id,))
    db.execute("DELETE FROM sessions WHERE user_id = ?", (target_id,))
    log_activity(db, "ban", f"🚫 {user['name']} a été banni·e")


# ---------------------------------------------------------------- websocket

connections: dict[int, set[WebSocket]] = {}
admin_connections: set[WebSocket] = set()
_main_loop = None  # boucle asyncio du serveur, capturée au démarrage


@app.on_event("startup")
async def _capture_loop():
    global _main_loop
    import asyncio

    _main_loop = asyncio.get_running_loop()


def _send_async(ws: WebSocket, payload: dict) -> None:
    """Planifie un envoi WebSocket depuis n'importe quel thread.

    Les routes REST synchrones tournent dans un threadpool sans boucle
    asyncio : on repasse par la boucle principale du serveur.
    """
    import asyncio

    if _main_loop is None or _main_loop.is_closed():
        return  # serveur pas démarré (tests) : le client verra via polling
    asyncio.run_coroutine_threadsafe(ws.send_json(payload), _main_loop)


def notify_user(target_user_id: int, payload: dict) -> None:
    for ws in list(connections.get(target_user_id, ())):
        _send_async(ws, payload)


def notify_admins(payload: dict) -> None:
    """Pousse un événement en direct à tous les admins connectés."""
    for ws in list(admin_connections):
        _send_async(ws, payload)


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str = ""):
    user_id = auth.user_id_from_token(token)
    if user_id is None:
        await ws.close(code=4401)
        return
    with get_db() as db:
        row = db.execute(
            "SELECT is_admin FROM users WHERE id = ?", (user_id,)
        ).fetchone()
    is_admin = bool(row and row["is_admin"])
    await ws.accept()
    connections.setdefault(user_id, set()).add(ws)
    if is_admin:
        admin_connections.add(ws)
    try:
        while True:
            await ws.receive_text()  # keep-alive ; l'envoi passe par l'API REST
    except WebSocketDisconnect:
        pass
    finally:
        connections.get(user_id, set()).discard(ws)
        admin_connections.discard(ws)


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
