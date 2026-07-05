"""Notifications push (Web Push / VAPID).

Les clés VAPID sont générées au premier lancement et stockées dans le
dossier data ; rien à configurer.
"""
import base64
import json
import threading

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid
from pywebpush import WebPushException, webpush

from . import config
from .db import get_db

_PEM = config.DATA_DIR / "vapid_private.pem"


def _load_vapid() -> Vapid:
    if not _PEM.exists():
        v = Vapid()
        v.generate_keys()
        v.save_key(str(_PEM))
    return Vapid.from_file(str(_PEM))


_vapid = _load_vapid()
_CLAIM_SUB = "mailto:" + next(iter(config.ADMIN_EMAILS), "admin@sjda.local")


def public_key_b64() -> str:
    """Clé publique au format attendu par pushManager.subscribe()."""
    raw = _vapid.public_key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def push_to_users(user_ids, title: str, body: str, url: str = "/") -> None:
    """Envoie une notification aux appareils abonnés de ces utilisateurs.

    L'envoi réseau part dans un thread pour ne pas ralentir la requête.
    """
    user_ids = list(user_ids)
    if not user_ids:
        return
    with get_db() as db:
        marks = ",".join("?" * len(user_ids))
        subs = [
            dict(r)
            for r in db.execute(
                f"SELECT endpoint, sub FROM push_subs WHERE user_id IN ({marks})",
                user_ids,
            ).fetchall()
        ]
    if not subs:
        return
    payload = json.dumps({"title": title, "body": body, "url": url})
    threading.Thread(target=_send_all, args=(subs, payload), daemon=True).start()


def _send_all(subs, payload: str) -> None:
    dead = []
    for s in subs:
        try:
            webpush(
                json.loads(s["sub"]),
                data=payload,
                vapid_private_key=str(_PEM),
                vapid_claims={"sub": _CLAIM_SUB},
            )
        except WebPushException as exc:
            # abonnement expiré ou révoqué : on le nettoie
            if exc.response is not None and exc.response.status_code in (404, 410):
                dead.append(s["endpoint"])
        except Exception:
            pass  # le push est du confort : ne jamais casser l'app pour ça
    if dead:
        with get_db() as db:
            for endpoint in dead:
                db.execute("DELETE FROM push_subs WHERE endpoint = ?", (endpoint,))
