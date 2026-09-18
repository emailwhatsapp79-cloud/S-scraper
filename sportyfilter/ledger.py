"""Paper betting. Nothing here touches a real account or real money.

A pick is a recorded prediction with the price that was showing when the screen
fired. Settlement joins it to the result SportyBet later published.
"""

from __future__ import annotations

from typing import Optional

from .model import HOME
from .rules import Result
from .store import Store, utcnow

# Which 1X2 outcome each selection covers.
COVERS = {
    "1": {"H"}, "X": {"D"}, "2": {"A"},
    "1X": {"H", "D"}, "12": {"H", "A"}, "X2": {"D", "A"},
}
FT_MARKETS = {"FT_1X2", "FT_DC"}
HT_MARKETS = {"HT_1X2", "HT_DC"}


def outcome(home_goals: int, away_goals: int) -> str:
    if home_goals > away_goals:
        return "H"
    return "A" if away_goals > home_goals else "D"


def place(store: Store, result: Result, strategy: str, stake: float = 1.0) -> Optional[int]:
    """Record the natural bet for a passing screen: FT double chance on the favourite.

    Returns the pick id, or None if the screen did not pass or this game was
    already picked by this strategy (the poller re-sees the same match a lot).
    """
    if not result.passed:
        return None
    match = result.match
    selection = "1X" if match.fav_side == HOME else "X2"
    cur = store.db.execute(
        """INSERT OR IGNORE INTO picks
           (game_id, strategy, created_at, market, selection, price, stake)
           VALUES (?,?,?,?,?,?,?)""",
        (
            match.game_id, strategy, utcnow(), "FT_DC", selection,
            match.ft_dc.with_draw(match.fav_side), stake,
        ),
    )
    return cur.lastrowid if cur.rowcount else None


def settle(store: Store) -> dict[str, int]:
    """Settle every open pick that now has a result. Returns a tally."""
    tally = {"won": 0, "lost": 0}
    for pick in store.unsettled_picks():
        if pick["market"] in FT_MARKETS:
            res = outcome(pick["ft_home_goals"], pick["ft_away_goals"])
        elif pick["market"] in HT_MARKETS:
            res = outcome(pick["ht_home_goals"], pick["ht_away_goals"])
        else:
            raise ValueError(f"unknown market on pick {pick['id']}: {pick['market']}")

        won = res in COVERS[pick["selection"]]
        returned = pick["stake"] * pick["price"] if won else 0.0
        store.db.execute(
            "UPDATE picks SET settled_at = ?, outcome = ?, returned = ? WHERE id = ?",
            (utcnow(), "won" if won else "lost", returned, pick["id"]),
        )
        tally["won" if won else "lost"] += 1
    store.commit()
    return tally
