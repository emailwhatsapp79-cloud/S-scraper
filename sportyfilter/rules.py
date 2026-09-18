"""The screen itself: six checks, run in the order you described them."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from .model import HOME, Match

PASS = "pass"
FAIL = "fail"
SKIP = "skip"


@dataclass(frozen=True)
class Config:
    """Every threshold is a knob. Defaults are the numbers you gave me."""

    # Stage 1 - full-time 1X2. One side short, the other long.
    ft_fav_min: float = 1.50
    ft_fav_max: float = 2.50
    ft_dog_min: float = 3.70  # no upper limit

    # Stage 2 - full-time double chance.
    ft_dc_fav_min: float = 1.17
    ft_dc_fav_max: float = 1.30
    ft_dc_dog_min: float = 1.89

    # Stage 3 - first-half 1X2. Draw leg is not checked.
    ht_fav_min: float = 1.10
    ht_fav_max: float = 3.00
    ht_ratio_min: float = 1.70  # dog / fav; "about double, give or take"

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "Config":
        known = {f for f in cls.__dataclass_fields__}
        unknown = set(raw) - known
        if unknown:
            raise ValueError(f"unknown config key(s): {', '.join(sorted(unknown))}")
        return cls(**{k: float(v) for k, v in raw.items()})


@dataclass(frozen=True)
class Check:
    name: str
    status: str
    detail: str

    @property
    def failed(self) -> bool:
        return self.status == FAIL


@dataclass
class Result:
    match: Match
    checks: list[Check] = field(default_factory=list)

    @property
    def failure(self) -> Optional[Check]:
        return next((c for c in self.checks if c.failed), None)

    @property
    def incomplete(self) -> bool:
        """True when a check could not run — usually half-time odds not fetched yet."""
        return any(c.status == SKIP for c in self.checks) and self.failure is None

    @property
    def passed(self) -> bool:
        return self.failure is None and not self.incomplete

    @property
    def verdict(self) -> str:
        if self.failure:
            return "REJECT"
        return "SHOW" if self.passed else "NEEDS-HT"


def _band(name: str, value: float, low: float, high: float, what: str) -> Check:
    ok = low <= value <= high
    return Check(name, PASS if ok else FAIL, f"{what} {value:.2f} {'in' if ok else 'outside'} {low:.2f}-{high:.2f}")


def _floor(name: str, value: float, low: float, what: str) -> Check:
    ok = value >= low
    return Check(name, PASS if ok else FAIL, f"{what} {value:.2f} {'>=' if ok else '<'} {low:.2f}")


def evaluate(match: Match, cfg: Config = Config()) -> Result:
    """Run every check, even after one fails, so near-misses stay visible."""
    fav, dog = match.fav_side, match.dog_side
    checks = [
        _band("ft_fav", match.ft.leg(fav), cfg.ft_fav_min, cfg.ft_fav_max, f"FT {fav} (fav)"),
        _floor("ft_dog", match.ft.leg(dog), cfg.ft_dog_min, f"FT {dog} (dog)"),
        _band(
            "ft_dc_fav",
            match.ft_dc.with_draw(fav),
            cfg.ft_dc_fav_min,
            cfg.ft_dc_fav_max,
            f"FT {'1X' if fav == HOME else 'X2'}",
        ),
        _floor(
            "ft_dc_dog",
            match.ft_dc.with_draw(dog),
            cfg.ft_dc_dog_min,
            f"FT {'1X' if dog == HOME else 'X2'}",
        ),
    ]

    if match.ht is None:
        checks += [
            Check("ht_fav", SKIP, "half-time odds not loaded"),
            Check("ht_split", SKIP, "half-time odds not loaded"),
        ]
    else:
        ht_fav, ht_dog = match.ht.leg(fav), match.ht.leg(dog)
        ratio = ht_dog / ht_fav
        checks.append(_band("ht_fav", ht_fav, cfg.ht_fav_min, cfg.ht_fav_max, f"HT {fav}"))
        checks.append(
            Check(
                "ht_split",
                PASS if ratio >= cfg.ht_ratio_min else FAIL,
                f"HT {dog} {ht_dog:.2f} is {ratio:.2f}x HT {fav} {ht_fav:.2f} "
                f"({'>=' if ratio >= cfg.ht_ratio_min else '<'} {cfg.ht_ratio_min:.2f}x)",
            )
        )

    return Result(match, checks)


def screen(matches: list[Match], cfg: Config = Config()) -> list[Result]:
    return [evaluate(m, cfg) for m in matches]
