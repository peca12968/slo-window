import csv
import io
import unittest

from latency_demo import CONFIG, ndjson, records
from test_cli import run


class HistogramTests(unittest.TestCase):
    def test_boundaries_tail_and_overlapping_requests(self):
        outputs = []
        for high in (True, False):
            raw = records(high)
            result = run("--dedupe", "--histogram", CONFIG, data=ndjson(raw + raw[:3]))
            self.assertEqual(result.returncode, 0, result.stderr)
            rows = list(csv.DictReader(io.StringIO(result.stdout.decode())))
            self.assertEqual(len(rows), 7)
            for row in rows:
                end = row["le_ms"]
                expected = sum(item["shard"] == row["shard"] and (end == "+Inf" or item["duration_ms"] <= int(end))
                               for item in raw)
                self.assertEqual(int(row["cumulative_count"]), expected)
            outputs.append(rows)
        self.assertEqual(*outputs)

    def test_bad_last_record_and_conflicting_latency(self):
        original = records()[0]
        for change in [{"duration_ms": 1}, {"shard": "south"}, {"duration_ms": -1}, {"duration_ms": 3.2},
                       {"shard": "missing"}, {"timestamp": "2026-05-02T00:00:00Z"}]:
            result = run("--dedupe", "--histogram", CONFIG, data=ndjson([original, {**original, **change}]))
            self.assertEqual((result.returncode, result.stdout), (2, b""))
            self.assertIn(b"Line 2", result.stderr)

    def test_empty_input_emits_configured_empty_shards(self):
        result = run("--histogram", CONFIG)
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = list(csv.DictReader(io.StringIO(result.stdout.decode())))
        self.assertEqual(len(rows), 7)
        self.assertTrue(all(row["cumulative_count"] == "0" for row in rows))
