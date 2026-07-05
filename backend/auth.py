"""Mots de passe (PBKDF2) et sessions par jeton opaque."""
import hashlib
import hmac
import secrets

from fastapi import Depends, HTTPException, Request

from .db import get_db

PBKDF2_ITERATIONS = 200_000


def hash_password(password: str, salt: str) -> str:
    dk = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), PBKDF2_ITERATIONS
    )
    return dk.hex()


def new_salt() -> str:
    return secrets.token_hex(16)


def verify_password(password: str, salt: str, expected_hash: str) -> bool:
    return hmac.compare_digest(hash_password(password, salt), expected_hash)


def create_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    with get_db() as db:
        db.execute(
            "INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user_id)
        )
    return token


def user_id_from_token(token: str) -> int | None:
    if not token:
        return None
    with get_db() as db:
        row = db.execute(
            "SELECT user_id FROM sessions WHERE token = ?", (token,)
        ).fetchone()
    return row["user_id"] if row else None


def current_user_id(request: Request) -> int:
    auth = request.headers.get("Authorization", "")
    token = auth.removeprefix("Bearer ").strip()
    user_id = user_id_from_token(token)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Non connecté")
    return user_id


CurrentUser = Depends(current_user_id)
