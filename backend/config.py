"""Configuration de l'application, surchargeable par variables d'environnement."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("SJDA_DATA_DIR", BASE_DIR / "data"))
UPLOADS_DIR = DATA_DIR / "uploads"
# cartes d'étudiant du KYI : jamais servies publiquement, accès modos uniquement
KYI_DIR = DATA_DIR / "kyi"
DB_PATH = DATA_DIR / "sjda.db"

APP_NAME = os.environ.get("SJDA_APP_NAME", "SJDA")

# Vérification école : l'inscription exige un email étudiant de l'un de
# ces domaines (SJDA_EMAIL_DOMAINS, séparés par des virgules).
EMAIL_DOMAINS = {
    d.strip().lower().lstrip("@")
    for d in os.environ.get(
        "SJDA_EMAIL_DOMAINS",
        "institutsaintjean.org,cpgesaintjean.org,universitesaintjean.org,"
        "prepavogt.org,saintjeaningenieur.org,saintjeanmanagement.org,"
        "prepasaintjean.org",
    ).split(",")
    if d.strip()
}

# Code modérateur (SJDA_MOD_CODE) : optionnel à l'inscription. Quelqu'un qui
# fournit le bon code devient modérateur (et peut s'inscrire avec n'importe
# quel email). Vide par défaut = personne ne devient modo par code.
MOD_CODE = os.environ.get("SJDA_MOD_CODE", "").strip()

# Emails administrateurs (séparés par des virgules) : ces comptes voient
# le tableau de bord de modération. Ex. SJDA_ADMIN_EMAILS="toi@gmail.com"
ADMIN_EMAILS = {
    e.strip().lower()
    for e in os.environ.get("SJDA_ADMIN_EMAILS", "").split(",")
    if e.strip()
}

MAX_PHOTO_BYTES = 5 * 1024 * 1024  # 5 Mo
SESSION_DAYS = 30

DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
KYI_DIR.mkdir(parents=True, exist_ok=True)
