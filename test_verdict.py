from fractions import Fraction
from io import StringIO
from itertools import combinations_with_replacement, product
from pathlib import Path
import random
import unittest

from verdict import evaluate, intervals


HEADER = "shard,le_ms,cumulative_count\n"


class LatencyBounds(unittest.TestCase):
    def test_checkout_and_open_tail(self):
        with (Path(__file__).parent / "examples/checkout.csv").open() as source:
            bins = intervals(source)
        report = evaluate(bins, 120, Fraction(4, 5), Fraction(9, 10))
        self.assertEqual(report["within_threshold"], [10, 17])
        self.assertEqual(report["quantile_ms"], [151, 300])
        self.assertEqual(report["decision"], "indeterminate")
        self.assertEqual(evaluate(bins, 120, Fraction(1, 2), Fraction(1))["decision"], "pass")
        last = evaluate(bins, 120, Fraction(9, 10), Fraction(1))
        self.assertEqual(last["decision"], "fail")
        self.assertEqual(last["quantile_ms"], [201, None])

    def test_many_possible_raw_logs_sharing_each_histogram(self):
        rng = random.Random(75644)
        # 7 stands for any arbitrarily large latency. All finite boundaries and
        # thresholds are below 6, so this distinguishes unbounded upper answers.
        for case in range(160):
            rows, candidates = [], []
            for shard in ["a", "b"]:
                limits = sorted(rng.sample(range(5), rng.randrange(1, 4)))
                size = rng.randrange(1, 3)
                observed = [rng.randrange(8) for _ in range(size)]
                def counts(values):
                    return [sum(v <= limit for v in values) for limit in limits]
                wanted = counts(observed)
                for boundary, count in zip(limits + ["+Inf"], wanted + [size]):
                    rows.append(f"{shard},{boundary},{count}\n")
                candidates.append([raw for raw in combinations_with_replacement(range(8), size)
                                   if counts(raw) == wanted])
            rng.shuffle(rows)
            threshold = rng.randrange(6)
            q = Fraction(rng.randint(1, 4), 4)
            report = evaluate(intervals(StringIO(HEADER + "".join(rows))), threshold, Fraction(3, 4), q)
            hits, quantiles = [], []
            for a, b in product(*candidates):
                raw = sorted(a + b)
                hits.append(sum(v <= threshold for v in raw))
                position = next(i for i in range(1, len(raw) + 1) if Fraction(i, len(raw)) >= q)
                quantiles.append(raw[position - 1])
            self.assertEqual(report["within_threshold"], [min(hits), max(hits)], case)
            self.assertEqual(report["quantile_ms"], [min(quantiles), None if max(quantiles) == 7 else max(quantiles)], case)

    def test_counts_above_double_precision_zero_traffic_and_invalid_buckets(self):
        huge = 2 ** 60 + 1
        bins = intervals(StringIO(HEADER + f"x,+Inf,{huge}\nx,0,{huge - 1}\n"))
        report = evaluate(bins, 0, Fraction(1), Fraction(huge - 1, huge))
        self.assertEqual(report["rank"], huge - 1)
        self.assertEqual(report["quantile_ms"], [0, 0])
        self.assertEqual(report["decision"], "fail")
        empty = evaluate(intervals(StringIO(HEADER + "x,+Inf,0\n")), 0, Fraction(1), Fraction(1))
        self.assertEqual((empty["decision"], empty["quantile_ms"]), ("no_data", None))
        for rows in ["", "a,3,1\n", "a,1,2\na,+Inf,1\n", "a,1,0\na,01,0\na,+Inf,0\n",
                     "a,1,-1\na,+Inf,4\n", "a,1.5,0\na,+Inf,0\n"]:
            with self.assertRaises(ValueError):
                intervals(StringIO(HEADER + rows))
