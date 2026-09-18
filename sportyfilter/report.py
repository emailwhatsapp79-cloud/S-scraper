"""Does the screen actually beat its own prices? Reported honestly.

Two things keep this from flattering the strategy: a Wilson interval on the hit
rate rather than a bare percentage, and a Bonferroni-adjusted interval whenever
the picks are sliced into groups, because slicing 10 ways and keeping the best
slice finds "patterns" in pure noise.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional, Sequence

# Two-sided normal quantiles, by number of simultaneous comparisons.
_Z = {1: 1.960, 2: 2.241, 3: 2.394, 4: 2.498, 6: 2.638, 8: 2.734, 12: 2.859, 24: 3.023}


def z_for(comparisons: int) -> float:
    """Bonferroni-widened z. Falls back to the next tabulated step up."""
    for k in sorted(_Z):
        if comparisons <= k:
            return _Z[k]
    return 3.2


def wilson(wins: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson score interval. Behaves at small n, unlike the textbook formula."""
    if n == 0:
        return (0.0, 1.0)
    p = wins / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, centre - half), min(1.0, centre + half))


def picks_needed(break_even: float, target: float, power: float = 0.80) -> int:
    """How many settled picks to distinguish `target` from `break_even`."""
    if target <= break_even:
        return 0
    z_a, z_b = 1.645, 0.842 if power >= 0.8 else 0.524
    num = z_a * math.sqrt(break_even * (1 - break_even)) + z_b * math.sqrt(target * (1 - target))
    return math.ceil(num * num / ((target - break_even) ** 2))


@dataclass
class Summary:
    label: str
    n: int
    wins: int
    staked: float
    returned: float
    break_even: float
    lo: float
    hi: float

    @property
    def hit_rate(self) -> float:
        return self.wins / self.n if self.n else 0.0

    @property
    def roi(self) -> float:
        return (self.returned - self.staked) / self.staked if self.staked else 0.0

    @property
    def beats_prices(self) -> bool:
        """True only if the whole interval clears break-even."""
        return self.lo > self.break_even

    @property
    def verdict(self) -> str:
        if self.n < 30:
            return "too few picks to say anything"
        if self.beats_prices:
            return "clears break-even across the whole interval"
        if self.hi < self.break_even:
            return "losing to the prices"
        return "indistinguishable from the prices"


def summarise(picks: Sequence, label: str = "all", comparisons: int = 1) -> Summary:
    n = len(picks)
    wins = sum(1 for p in picks if p["outcome"] == "won")
    staked = sum(p["stake"] for p in picks)
    returned = sum(p["returned"] or 0.0 for p in picks)
    # Flat-stake break-even: the average implied probability of the prices taken.
    break_even = sum(1.0 / p["price"] for p in picks) / n if n else 0.0
    lo, hi = wilson(wins, n, z_for(comparisons))
    return Summary(label, n, wins, staked, returned, break_even, lo, hi)


def render(summaries: Sequence[Summary], comparisons: int = 1) -> str:
    out = []
    if comparisons > 1:
        out.append(
            f"Intervals widened for {comparisons} simultaneous comparisons "
            f"(z={z_for(comparisons):.3f}). Slicing the data costs confidence.\n"
        )
    for s in summaries:
        out.append(f"{s.label}")
        if s.n == 0:
            out.append("  no settled picks\n")
            continue
        out.append(f"  picks        {s.n} settled, {s.wins} won")
        out.append(f"  hit rate     {s.hit_rate:6.2%}   CI [{s.lo:.2%}, {s.hi:.2%}]")
        out.append(f"  break-even   {s.break_even:6.2%}   (avg price {1/s.break_even:.3f})")
        out.append(f"  P&L          {s.returned - s.staked:+8.2f} units on {s.staked:.0f} staked  ({s.roi:+.2%})")
        out.append(f"  verdict      {s.verdict}")
        if not s.beats_prices and s.n >= 30:
            need = picks_needed(s.break_even, s.break_even + 0.025)
            out.append(f"  to prove a +2.5pt edge you would need ~{need:,} settled picks")
        out.append("")
    return "\n".join(out)
