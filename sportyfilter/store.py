"""SQLite store: every match, every odds capture, every pick, every result.

Odds are stored as snapshots rather than overwritten, so a match seen at 01:00
and again at 01:20 keeps both rows and you can see drift.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

from .model import Match, Odds1X2

SCHEMA = """
CREATE TABLE IF NOT EXISTS matches (
    game_id    TEXT PRIMARY KEY,
    league     TEXT,
    kickoff    TEXT,
    home       TEXT,
    away       TEXT,
    first_seen TEXT NOT NULL,
    last_seen  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS odds (
    game_id      TEXT NOT NULL REFERENCES matches(game_id),
    captured_at  TEXT NOT NULL,
    ft_home REAL, ft_draw REAL, ft_away REAL,
    dc_1x REAL, dc_12 REAL, dc_x2 REAL, dc_estimated INTEGER NOT NULL DEFAULT 0,
    ht_home REAL, ht_draw REAL, ht_away REAL,
    PRIMARY KEY (game_id, captured_at)
);
CREATE TABLE IF NOT EXISTS results (
    game_id       TEXT PRIMARY KEY REFERENCES matches(game_id),
    recorded_at   TEXT NOT NULL,
    ht_home_goals INTEGER NOT NULL, ht_away_goals INTEGER NOT NULL,
    ft_home_goals INTEGER NOT NULL, ft_away_goals INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS picks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id    TEXT NOT NULL REFERENCES matches(game_id),
    strategy   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    market     TEXT NOT NULL,
    selection  TEXT NOT NULL,
    price      REAL NOT NULL,
    stake      REAL NOT NULL,
    settled_at TEXT,
    outcome    TEXT,
    returned   REAL,
    UNIQUE (game_id, strategy, market, selection)
);
CREATE INDEX IF NOT EXISTS picks_open ON picks(settled_at) WHERE settled_at IS NULL;
"""


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: str = "sportyfilter.db"):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        self.db.close()

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.db.commit()
        self.db.close()

    # -- writes ---------------------------------------------------------

    def record_match(self, match: Match, seen_at: Optional[str] = None) -> None:
        """Upsert the match and append an odds snapshot. Safe to call repeatedly."""
        now = seen_at or utcnow()
        self.db.execute(
            """INSERT INTO matches (game_id, league, kickoff, home, away, first_seen, last_seen)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(game_id) DO UPDATE SET last_seen = excluded.last_seen""",
            (match.game_id, match.league, match.kickoff, match.home, match.away, now, now),
        )
        ht = match.ht
        self.db.execute(
            """INSERT OR REPLACE INTO odds
               (game_id, captured_at, ft_home, ft_draw, ft_away,
                dc_1x, dc_12, dc_x2, dc_estimated, ht_home, ht_draw, ht_away)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                match.game_id, now,
                match.ft.home, match.ft.draw, match.ft.away,
                match.ft_dc.home_draw, match.ft_dc.home_away, match.ft_dc.draw_away,
                int(match.ft_dc.estimated),
                ht.home if ht else None, ht.draw if ht else None, ht.away if ht else None,
            ),
        )

    def record_result(self, game_id: str, ht: tuple[int, int], ft: tuple[int, int]) -> None:
        self.db.execute(
            """INSERT OR REPLACE INTO results
               (game_id, recorded_at, ht_home_goals, ht_away_goals, ft_home_goals, ft_away_goals)
               VALUES (?,?,?,?,?,?)""",
            (game_id, utcnow(), ht[0], ht[1], ft[0], ft[1]),
        )

    def commit(self) -> None:
        self.db.commit()

    # -- reads ----------------------------------------------------------

    def latest_odds(self, game_id: str) -> Optional[sqlite3.Row]:
        return self.db.execute(
            "SELECT * FROM odds WHERE game_id = ? ORDER BY captured_at DESC LIMIT 1", (game_id,)
        ).fetchone()

    def match_count(self) -> int:
        return self.db.execute("SELECT COUNT(*) FROM matches").fetchone()[0]

    def unsettled_picks(self) -> Iterable[sqlite3.Row]:
        return self.db.execute(
            """SELECT p.*, r.ht_home_goals, r.ht_away_goals, r.ft_home_goals, r.ft_away_goals
               FROM picks p JOIN results r ON r.game_id = p.game_id
               WHERE p.settled_at IS NULL"""
        ).fetchall()

    def settled_picks(self, strategy: Optional[str] = None) -> list[sqlite3.Row]:
        sql = """SELECT p.*, m.kickoff, m.league FROM picks p
                 JOIN matches m ON m.game_id = p.game_id
                 WHERE p.settled_at IS NOT NULL"""
        args: tuple = ()
        if strategy:
            sql += " AND p.strategy = ?"
            args = (strategy,)
        return self.db.execute(sql + " ORDER BY p.created_at", args).fetchall()


def odds_from_row(row: sqlite3.Row, which: str) -> Optional[Odds1X2]:
    p = "ft_" if which == "ft" else "ht_"
    if row[p + "home"] is None:
        return None
    return Odds1X2(row[p + "home"], row[p + "draw"], row[p + "away"])
