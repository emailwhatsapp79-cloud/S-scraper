"""Data model for a SportyBet vFootball match and its odds."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

HOME = "home"
AWAY = "away"


@dataclass(frozen=True)
class Odds1X2:
    """A 1X2 market: home win / draw / away win."""

    home: float
    draw: float
    away: float

    def leg(self, side: str) -> float:
        return self.home if side == HOME else self.away

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "Odds1X2":
        return cls(float(raw["home"]), float(raw["draw"]), float(raw["away"]))


@dataclass(frozen=True)
class DoubleChance:
    """A double chance market. `estimated` is True when derived from 1X2."""

    home_draw: float  # 1X
    home_away: float  # 12
    draw_away: float  # X2
    estimated: bool = False

    def with_draw(self, side: str) -> float:
        """The double chance covering `side` plus the draw."""
        return self.home_draw if side == HOME else self.draw_away

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "DoubleChance":
        return cls(
            float(raw["home_draw"]),
            float(raw["home_away"]),
            float(raw["draw_away"]),
        )

    @classmethod
    def derive(cls, ft: Odds1X2) -> "DoubleChance":
        """Fall back to book-implied double chance when the feed omits it.

        SportyBet shades these by hand, so treat the result as approximate:
        on CRY vs NFO this lands 1X and 12 exactly but X2 about 0.06 high.
        """

        def combine(a: float, b: float) -> float:
            return round(1.0 / (1.0 / a + 1.0 / b), 2)

        return cls(
            combine(ft.home, ft.draw),
            combine(ft.home, ft.away),
            combine(ft.draw, ft.away),
            estimated=True,
        )


@dataclass(frozen=True)
class Match:
    game_id: str
    home: str
    away: str
    ft: Odds1X2
    ft_dc: DoubleChance
    ht: Optional[Odds1X2] = None
    league: str = ""
    kickoff: str = ""

    @property
    def label(self) -> str:
        return f"{self.home} vs {self.away}"

    @property
    def fav_side(self) -> str:
        """The full-time favourite: whichever of home/away is the shorter price."""
        return HOME if self.ft.home <= self.ft.away else AWAY

    @property
    def dog_side(self) -> str:
        return AWAY if self.fav_side == HOME else HOME

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "Match":
        ft = Odds1X2.from_dict(raw["ft"])
        dc_raw = raw.get("ft_dc")
        return cls(
            game_id=str(raw.get("game_id", "")),
            home=raw["home"],
            away=raw["away"],
            ft=ft,
            ft_dc=DoubleChance.from_dict(dc_raw) if dc_raw else DoubleChance.derive(ft),
            ht=Odds1X2.from_dict(raw["ht"]) if raw.get("ht") else None,
            league=raw.get("league", ""),
            kickoff=raw.get("kickoff", ""),
        )
