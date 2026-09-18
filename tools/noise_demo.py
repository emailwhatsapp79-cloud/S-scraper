"""Why 'day and night behave differently' needs checking before it is believed.

Simulates picks from a generator with NO pattern at all - every pick is a coin
weighted to exactly the break-even rate, independent of the clock - then slices
the log by hour the way you would if you were hunting a time-of-day effect.

Run: python3 tools/noise_demo.py [seed]
"""

import pathlib
import random
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from sportyfilter.report import summarise, wilson, z_for

PRICE = 1.29
BREAK_EVEN = 1 / PRICE
DAYS = 90
PICKS_PER_DAY = 25


def main(seed: int = 7) -> None:
    rng = random.Random(seed)
    by_hour: dict[int, list[dict]] = {h: [] for h in range(24)}
    for _ in range(DAYS * PICKS_PER_DAY):
        hour = rng.randrange(24)
        won = rng.random() < BREAK_EVEN  # the clock is ignored on purpose
        by_hour[hour].append(
            {"outcome": "won" if won else "lost", "stake": 1.0,
             "returned": PRICE if won else 0.0, "price": PRICE}
        )

    rows = sorted(
        (summarise(p, f"{h:02d}:00", comparisons=24) for h, p in by_hour.items()),
        key=lambda s: s.hit_rate,
        reverse=True,
    )
    total = sum(len(p) for p in by_hour.values())
    print(f"{DAYS} days x {PICKS_PER_DAY} picks = {total:,} picks at {PRICE}")
    print(f"true rate {BREAK_EVEN:.2%} at every hour - there is no pattern in this data\n")
    print(f"{'hour':>6} {'n':>5} {'hit rate':>9} {'ROI':>8}")
    for s in rows[:3] + rows[-3:]:
        print(f"{s.label:>6} {s.n:>5} {s.hit_rate:>9.2%} {s.roi:>+8.2%}")
        if s is rows[2]:
            print(f"{'...':>6}")

    best, worst = rows[0], rows[-1]
    print(f"\nbest hour beats worst hour by {(best.hit_rate - worst.hit_rate)*100:.1f} points "
          f"({best.label} vs {worst.label}) - purely by chance.")

    naive_lo, _ = wilson(best.wins, best.n, 1.96)
    print(f"\n{best.label} judged alone:   CI starts at {naive_lo:.2%} vs break-even {BREAK_EVEN:.2%} "
          f"-> {'looks like an edge' if naive_lo > BREAK_EVEN else 'no edge'}")
    print(f"{best.label} judged as 1 of 24: CI starts at {best.lo:.2%} "
          f"-> {'still an edge' if best.beats_prices else 'no edge'}  (z={z_for(24):.3f})")
    print("\nThe correction is what stops you backing 'the 3am pattern'.")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 7)
