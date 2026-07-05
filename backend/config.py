"""Configuration de l'application, surchargeable par variables d'environnement."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("SJDA_DATA_DIR", BASE_DIR / "data"))
UPLOADS_DIR = DATA_DIR / "uploads"
DB_PATH = DATA_DIR / "sjda.db"

APP_NAME = os.environ.get("SJDA_APP_NAME", "SJDA")

# Vérification école : au moins une des deux conditions doit être remplie
# à l'inscription (si les deux sont configurées, l'une OU l'autre suffit).
#  - SJDA_EMAIL_DOMAIN : ex. "monecole.fr" -> seuls les emails @monecole.fr passent
#  - SJDA_INVITE_CODE  : code à partager aux élèves de l'école
EMAIL_DOMAIN = os.environ.get("SJDA_EMAIL_DOMAIN", "").strip().lower()
INVITE_CODE = os.environ.get("SJDA_INVITE_CODE", "SJDA2026").strip()

MAX_PHOTO_BYTES = 5 * 1024 * 1024  # 5 Mo
SESSION_DAYS = 30

DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
