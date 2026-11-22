import json
from pathlib import Path
import random
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

from examples.capture import capture
from trace_time import Span, timing


ROOT = Path(__file__).resolve().parent
EXAMPLES = ROOT / "examples"


class TraceTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name)

    def cli(self, *paths, success=True):
        result = subprocess.run([sys.executable, str(ROOT / "trace_time.py"), *map(str, paths)],
                                cwd=self.path, capture_output=True)
        self.assertEqual(result.returncode, 0 if success else 2, result.stderr)
        if success:
            return json.loads(result.stdout)
        self.assertEqual(result.stdout, b"")
        self.assertNotIn(b"Traceback", result.stderr)
        return result.stderr

    def batch(self, name, rows):
        request = ExportTraceServiceRequest()
        spans = request.resource_spans.add().scope_spans.add().spans
        for trace, key, parent, start, end in rows:
            spans.add(trace_id=trace.to_bytes(16, "big"), span_id=key.to_bytes(8, "big"),
                      parent_span_id=parent.to_bytes(8, "big") if parent else b"",
                      name=str(key), start_time_unix_nano=start, end_time_unix_nano=end)
        path = self.path / name
        path.write_bytes(request.SerializeToString())
        return path

    def test_fresh_sdk_http_capture_and_retried_batch(self):
        capture(self.path)
        root, services = self.path / "checkout.otlp", self.path / "services.otlp"
        report = self.cli(root, services)
        self.assertEqual(self.cli(services, root), report)
        retried = self.cli(services, root, services)
        self.assertEqual(retried["duplicate_spans"], 3)
        self.assertEqual(retried["traces"], report["traces"])
        trace, = report["traces"]
        self.assertEqual(trace["missing_parent_ids"], [])
        checkout, stock, pay, bank = trace["spans"]
        self.assertEqual([s["service"] for s in trace["spans"]], ["checkout", "inventory", "payments", "payments"])
        self.assertEqual(trace["root_ids"], [checkout["span_id"]])
        self.assertEqual(stock["parent_span_id"], checkout["span_id"])
        self.assertEqual(pay["parent_span_id"], checkout["span_id"])
        self.assertEqual(bank["parent_span_id"], pay["span_id"])
        self.assertEqual([checkout[k] for k in ("duration_ns", "covered_ns", "uncovered_ns", "overlap_ns")],
                         [120_000_000, 90_000_000, 30_000_000, 30_000_000])
        self.assertEqual(checkout["peak_children"], 2)
        self.assertEqual(pay["covered_ns"], 30_000_000)

    def test_missing_parent_is_reported_without_guessing_a_root(self):
        trace, = self.cli(EXAMPLES / "services.otlp")["traces"]
        self.assertEqual(trace["root_ids"], [])
        stock, pay, bank = trace["spans"]
        self.assertEqual(trace["missing_parent_ids"], [stock["parent_span_id"]])
        self.assertEqual(stock["parent_span_id"], pay["parent_span_id"])
        self.assertEqual(pay["span_id"], bank["parent_span_id"])

    def test_trace_id_scopes_span_id_and_parent_lookup(self):
        batch = self.batch("mixed", [(2, 1, 0, 20, 23), (1, 1, 0, 10, 20), (1, 2, 1, 12, 17)])
        first, second = self.cli(batch)["traces"]
        self.assertEqual(first["spans"][0]["covered_ns"], 5)
        self.assertEqual(second["spans"][0]["covered_ns"], 0)

    def test_conflicts_malformed_ids_time_and_cycles_emit_no_partial_report(self):
        valid = self.batch("first", [(1, 1, 0, 10, 30)])
        for rows, message in [
            ([(1, 1, 0, 10, 31)], b"conflicting span"),
            ([(2, 0, 0, 1, 2)], b"invalid span_id"),
            ([(0, 2, 0, 1, 2)], b"invalid trace_id"),
            ([(2, 2, 0, 10, 9)], b"ends before"),
            ([(2, 2, 3, 10, 20), (2, 3, 2, 11, 19)], b"parent cycle"),
        ]:
            with self.subTest(message=message):
                self.assertIn(message, self.cli(valid, self.batch("bad", rows), success=False))
        invalid = self.path / "corrupt.otlp"
        invalid.write_bytes(b"\x0a\xff")
        self.assertIn(b"corrupt.otlp", self.cli(valid, invalid, success=False))

    def test_three_way_overlap_clipping_and_touching_endpoints(self):
        spans = [(1, 1, 0, 10, 20), (1, 2, 1, 7, 16), (1, 3, 1, 12, 18),
                 (1, 4, 1, 13, 16), (1, 5, 1, 18, 21), (1, 6, 1, 22, 24), (1, 7, 1, 15, 15)]
        trace, = self.cli(self.batch("crossing", spans))["traces"]
        root = next(s for s in trace["spans"] if s["parent_span_id"] is None)
        self.assertEqual([root[k] for k in ("covered_ns", "uncovered_ns", "overlap_ns", "peak_children",
                                            "child_time_outside_ns")], [10, 0, 4, 3, 6])

    def test_sweep_matches_500_discrete_timelines(self):
        rng = random.Random(104729)
        for case in range(500):
            start, end = sorted(rng.choices(range(24), k=2))
            parent = Span("p", None, None, "parent", start, end)
            intervals = [sorted(rng.choices(range(30), k=2)) for _ in range(rng.randrange(10))]
            children = [Span(str(i), "p", None, "child", a, b) for i, (a, b) in enumerate(intervals)]
            loads = [sum(a <= tick < b for a, b in intervals) for tick in range(start, end)]
            expected = {"duration_ns": end - start, "covered_ns": sum(n > 0 for n in loads),
                        "uncovered_ns": loads.count(0), "peak_children": max(loads, default=0),
                        "overlap_ns": sum(n >= 2 for n in loads),
                        "child_time_outside_ns": sum(b - a for a, b in intervals) - sum(loads)}
            self.assertEqual(timing(parent, children), expected, case)


if __name__ == "__main__":
    unittest.main()
