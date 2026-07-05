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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_a, user_b)
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


def init_db() -> None:
    with get_db() as db:
        db.executescript(SCHEMA)


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
