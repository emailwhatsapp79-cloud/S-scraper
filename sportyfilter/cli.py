"""Command line front end: feed it match odds as JSON, get a shortlist back."""

from __future__ import annotations

import argparse
import dataclasses
import json
import sys
from typing import Any

from .model import Match
from .rules import Config, Result, screen

VERDICT_ORDER = {"SHOW": 0, "NEEDS-HT": 1, "REJECT": 2}


def _load_matches(path: str) -> list[Match]:
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    if isinstance(raw, dict):
        raw = raw.get("matches", [])
    return [Match.from_dict(m) for m in raw]


def _load_config(path: str | None) -> Config:
    if not path:
        return Config()
    with open(path, encoding="utf-8") as fh:
        return Config.from_dict(json.load(fh))


def _as_dict(result: Result) -> dict[str, Any]:
    m = result.match
    return {
        "game_id": m.game_id,
        "match": m.label,
        "league": m.league,
        "kickoff": m.kickoff,
        "verdict": result.verdict,
        "favourite": m.fav_side,
        "ft": dataclasses.asdict(m.ft),
        "ft_dc": dataclasses.asdict(m.ft_dc),
        "ht": dataclasses.asdict(m.ht) if m.ht else None,
        "checks": [dataclasses.asdict(c) for c in result.checks],
    }


def _print_text(results: list[Result], show_all: bool) -> None:
    for r in results:
        if not show_all and r.verdict == "REJECT":
            continue
        m = r.match
        head = f"[{r.verdict:9}] {m.label:14} {m.game_id or '-':>7}  {m.league}"
        print(head)
        print(
            f"            FT {m.ft.home:5.2f} / {m.ft.draw:5.2f} / {m.ft.away:5.2f}"
            f"   DC {m.ft_dc.home_draw:5.2f} / {m.ft_dc.home_away:5.2f} / {m.ft_dc.draw_away:5.2f}"
            f"{'  (dc estimated)' if m.ft_dc.estimated else ''}"
        )
        if m.ht:
            print(f"            HT {m.ht.home:5.2f} / {m.ht.draw:5.2f} / {m.ht.away:5.2f}")
        for c in r.checks:
            mark = {"pass": "ok  ", "fail": "FAIL", "skip": "--  "}[c.status]
            print(f"              {mark} {c.name:10} {c.detail}")
        print()

    counts: dict[str, int] = {}
    for r in results:
        counts[r.verdict] = counts.get(r.verdict, 0) + 1
    summary = ", ".join(f"{v} {k}" for k, v in sorted(counts.items(), key=lambda kv: VERDICT_ORDER[kv[0]]))
    print(f"{len(results)} match(es) screened: {summary or 'nothing'}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="sportyfilter", description=__doc__)
    ap.add_argument("input", help="JSON file of matches (see samples/)")
    ap.add_argument("-c", "--config", help="JSON file of threshold overrides")
    ap.add_argument("-a", "--all", action="store_true", help="also print rejected matches and why")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args(argv)

    try:
        cfg = _load_config(args.config)
        results = screen(_load_matches(args.input), cfg)
    except (OSError, ValueError, KeyError) as exc:
        print(f"sportyfilter: {exc}", file=sys.stderr)
        return 2

    results.sort(key=lambda r: (VERDICT_ORDER[r.verdict], r.match.game_id))

    if args.json:
        keep = results if args.all else [r for r in results if r.verdict != "REJECT"]
        json.dump([_as_dict(r) for r in keep], sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        _print_text(results, args.all)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
