"""Accès SQLite : schéma et helpers."""
import sqlite3
from contextlib import contextmanager

from .config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    name          TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    banned        INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profiles (
    user_id   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bio       TEXT NOT NULL DEFAULT '',
    classe    TEXT NOT NULL DEFAULT '',
    interests TEXT NOT NULL DEFAULT '[]',          -- JSON: liste de tags
    intent    TEXT NOT NULL DEFAULT 'les_deux',    -- amis | couple | les_deux
    gender    TEXT NOT NULL DEFAULT '',            -- fille | garcon | autre | ''
    seeking   TEXT NOT NULL DEFAULT 'tous',        -- filles | garcons | tous
    photo     TEXT NOT NULL DEFAULT ''             -- nom de fichier dans uploads/
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS swipes (
    swiper_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    liked      INTEGER NOT NULL,                   -- 1 = like, 0 = passe
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (swiper_id, target_id)
);

CREATE TABLE IF NOT EXISTS matches (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    closed     INTEGER NOT NULL DEFAULT 0,           -- 1 = fermé après signalement
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_a, user_b)
);

CREATE TABLE IF NOT EXISTS reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reported_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    match_id    INTEGER REFERENCES matches(id) ON DELETE SET NULL,
    reason      TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'pending',     -- pending | banned | dismissed
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,                        -- signup | match | report | ban
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id   INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    sender_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_match ON messages(match_id, id);
"""


# Pour les bases créées avant l'ajout de ces colonnes ; l'échec
# "duplicate column" sur une base récente est normal et ignoré.
MIGRATIONS = [
    "ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE matches ADD COLUMN closed INTEGER NOT NULL DEFAULT 0",
]


def init_db() -> None:
    with get_db() as db:
        db.executescript(SCHEMA)
        for stmt in MIGRATIONS:
            try:
                db.execute(stmt)
            except sqlite3.OperationalError:
                pass


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
