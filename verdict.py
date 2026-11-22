"""Bound an integer-millisecond latency objective from per-shard cumulative buckets."""
import argparse
import csv
from fractions import Fraction
import json
from pathlib import Path
import sys


def natural(value):
    if not isinstance(value, str) or not value.isascii() or not value.isdecimal():
        raise ValueError(f"expected a nonnegative integer, received {value!r}")
    return int(value)


def intervals(source):
    reader = csv.DictReader(source)
    if reader.fieldnames != ["shard", "le_ms", "cumulative_count"]:
        raise ValueError("expected header shard,le_ms,cumulative_count")
    shards = {}
    for row in reader:
        if None in row or not row["shard"] or not row["shard"].strip():
            raise ValueError(f"invalid row {reader.line_num}")
        end = None if row["le_ms"] == "+Inf" else natural(row["le_ms"])
        bucket = shards.setdefault(row["shard"], {})
        if end in bucket:
            raise ValueError(f"duplicate boundary on row {reader.line_num}")
        bucket[end] = natural(row["cumulative_count"])
    if not shards:
        raise ValueError("expected at least one shard")
    bins = []
    for name, buckets in shards.items():
        if None not in buckets:
            raise ValueError(f"{name}: missing +Inf bucket")
        start, previous = 0, 0
        for end in [*sorted(n for n in buckets if n is not None), None]:
            count = buckets[end]
            if count < previous:
                raise ValueError(f"{name}: cumulative counts decreased")
            if count > previous:
                bins.append((start, end, count - previous))
            if end is not None:
                start = end + 1
            previous = count
    return bins


def endpoint(bins, column, rank):
    finite = sorted((row[column], row[2]) for row in bins if row[column] is not None)
    for value, count in finite:
        rank -= count
        if rank <= 0:
            return value
    return None


def evaluate(bins, threshold, target, quantile):
    if threshold < 0 or not (0 < target <= 1 and 0 < quantile <= 1):
        raise ValueError("threshold must be nonnegative and fractions must lie in (0, 1]")
    total = sum(n for _, _, n in bins)
    certain = sum(n for _, hi, n in bins if hi is not None and hi <= threshold)
    possible = sum(n for lo, _, n in bins if lo <= threshold)
    required = -(-total * target.numerator // target.denominator)
    rank = -(-total * quantile.numerator // quantile.denominator)
    if not total:
        decision = "no_data"
    elif certain >= required:
        decision = "pass"
    elif possible < required:
        decision = "fail"
    else:
        decision = "indeterminate"
    return {"requests": total, "threshold_ms": threshold, "target": str(target),
            "required": required, "within_threshold": [certain, possible], "decision": decision,
            "quantile": str(quantile), "rank": rank if total else None,
            "quantile_ms": [endpoint(bins, 0, rank), endpoint(bins, 1, rank)] if total else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("buckets", type=Path)
    parser.add_argument("--threshold-ms", type=int, required=True)
    parser.add_argument("--target", type=Fraction, default=Fraction("0.99"))
    parser.add_argument("--quantile", type=Fraction, default=Fraction("0.99"))
    args = parser.parse_args()
    try:
        with args.buckets.open(encoding="utf-8-sig", newline="") as source:
            bins = intervals(source)
        print(json.dumps(evaluate(bins, args.threshold_ms, args.target, args.quantile), indent=2))
    except (ValueError, OSError, csv.Error) as error:
        sys.exit(str(error))


if __name__ == "__main__":
    main()
