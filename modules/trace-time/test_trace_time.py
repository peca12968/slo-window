import json
from pathlib import Path
import random
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

from examples.capture import capture
from trace_time import Span, corrected_delta, timing


ROOT = Path(__file__).resolve().parent
EXAMPLES = ROOT / "examples"


class TraceTests(unittest.TestCase):
    def test_calibrated_links_and_missing_inputs(self):
        paths = [EXAMPLES / name for name in ("batch.otlp", "enqueue-a.otlp", "enqueue-b.otlp")]
        bounds = EXAMPLES / "clock-bounds.json"
        r = self.cli("--clock-bounds", bounds, *paths)
        values = {e["linked_name"]: e["clock_adjusted"] for e in r["links"]["edges"]}
        self.assertEqual((values["enqueue A"]["lower_ns"], values["enqueue A"]["upper_ns"]), (20_000_000, 30_000_000))
        self.assertEqual((values["enqueue B"]["lower_ns"], values["enqueue B"]["upper_ns"]), (-5_000_000, 5_000_000))
        incomplete = self.cli("--clock-bounds", bounds, *paths[:-1])
        unresolved, = [e for e in incomplete["links"]["edges"] if e["state"] == "missing"]
        self.assertEqual(unresolved["clock_adjusted"]["state"], "missing_span")
        self.assertIsNone(unresolved["clock_adjusted"]["lower_ns"])
        self.assertEqual(r["traces"], self.cli(*paths)["traces"])
        for content in [{"consistent": False}, {"consistent": True}, {"consistent": True, "offset_pairs_us":
                        [{"from":"a","to":"b","lower_us":True,"upper_us":1}]}]:
            bad = self.path / "bad.json"
            bad.write_text(json.dumps(content))
            self.assertIn(b"clock", self.cli("--clock-bounds", bad, *paths, success=False).lower())

    def test_submicrosecond_delta_and_one_sided_calibration(self):
        source = Span("s", None, "svc", "", 1006, 2000, host="b")
        target = Span("t", None, "svc", "", 0, 1001, host="a")
        result = corrected_delta(source, target, {("a","b"): (None, -1)})
        self.assertEqual((result["state"], result["lower_ns"], result["upper_ns"]), ("one_sided", None, -995))
        self.assertEqual(corrected_delta(source, target, {})["state"], "unknown_pair")
        no_host = Span("t", None, "svc", "", 0, 1001)
        self.assertEqual(corrected_delta(source, no_host, {})["state"], "missing_host")

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

    def test_linked_batch_resolves_two_roots_and_keeps_partial_evidence(self):
        capture(self.path, batch=True)
        a, b, batch = (self.path / name for name in ("enqueue-a.otlp", "enqueue-b.otlp", "batch.otlp"))
        report = self.cli("--links", batch, b, a)
        self.assertEqual(report, self.cli("--links", a, b, batch))
        retry = self.cli("--links", batch, a, batch, b)
        self.assertEqual((retry["duplicate_spans"], retry["links"]), (1, report["links"]))
        self.assertEqual(report["traces"], self.cli(a, b, batch)["traces"])
        self.assertTrue(all(len(t["root_ids"]) == 1 and t["spans"][0]["covered_ns"] == 0 for t in report["traces"]))
        edges = report["links"]["edges"]
        self.assertEqual(sorted((e["linked_name"], e["start_minus_linked_end_ns"]) for e in edges),
                         [("enqueue A", 40_000_000), ("enqueue B", 15_000_000)])
        self.assertTrue(all(e["state"] == "resolved" and e["name"] == "flush batch" for e in edges))
        partial = self.cli("--links", a, batch)["links"]["edges"]
        self.assertEqual(sorted(e["state"] for e in partial), ["missing", "resolved"])
        missing, = [e for e in partial if e["state"] == "missing"]
        self.assertIsNone(missing["start_minus_linked_end_ns"])

    def test_link_multiplicity_dropped_and_unaddressable_context(self):
        path = self.batch("input", [(1, 1, 0, 0, 20), (2, 1, 0, 3, 18)])
        request = ExportTraceServiceRequest.FromString(path.read_bytes())
        src, target = request.resource_spans[0].scope_spans[0].spans
        for _ in range(2):
            src.links.add(trace_id=target.trace_id, span_id=target.span_id)
        src.links.add().attributes.add(key="note").value.string_value = "context only"
        src.dropped_links_count = 3
        path.write_bytes(request.SerializeToString())
        report = self.cli("--links", path)["links"]
        self.assertEqual(report["dropped_links"], 3)
        self.assertEqual([(e["state"], e["count"], e["start_minus_linked_end_ns"]) for e in report["edges"]],
                         [("unaddressable", 1, None), ("resolved", 2, -18)])
        src.links.pop()
        conflict = self.path / "conflict"
        conflict.write_bytes(request.SerializeToString())
        self.assertIn(b"conflicting span", self.cli("--links", path, conflict, success=False))

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
