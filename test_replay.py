import json
import math
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import unittest

from replay import Request, replay


ROOT = Path(__file__).resolve().parent


def tick_reference(trace, workers, queue_limit):
    """Tiny traces only. Check every worker and every waiting request once per millisecond."""
    waiting, active, result = [], {}, {}
    peak = busy = 0
    now = min(r.arrival_ms for r in trace) if trace else 0
    first = now
    while len(result) < len(trace):
        for name in list(active):
            req, start = active[name]
            if now == start + req.service_ms:
                result[name] = ("served", start, now, start - req.arrival_ms)
                del active[name]
        for req in waiting[:]:
            if now - req.arrival_ms >= req.patience_ms:
                result[req.id] = ("timed_out", None, now, now - req.arrival_ms)
                waiting.remove(req)
        for req in waiting[:]:
            if len(active) == workers:
                break
            waiting.remove(req)
            active[req.id] = (req, now)
        for req in trace:
            if req.arrival_ms != now:
                continue
            if len(active) < workers:
                active[req.id] = (req, now)
            elif req.patience_ms == 0:
                result[req.id] = ("timed_out", None, now, 0)
            elif len(waiting) >= queue_limit:
                result[req.id] = ("queue_full", None, now, 0)
            else:
                waiting.append(req)
        peak = max(peak, len(waiting))
        busy += len(active)
        now += 1
    return result, busy, peak, now - 1 - first if trace else 0


def cli(*args, timeout=10):
    return subprocess.run([sys.executable, ROOT / "replay.py", *args], capture_output=True, timeout=timeout)


class CapacityTests(unittest.TestCase):
    def test_random_traces_match_per_millisecond_oracle(self):
        rng = random.Random(7003)
        for i in range(300):
            with self.subTest(case=i):
                trace = [Request(str(j), rng.randrange(13), rng.randint(1, 8), rng.randrange(9))
                         for j in range(rng.randrange(20))]
                workers, slots = rng.randint(1, 4), rng.randrange(5)
                expect, busy, peak, window = tick_reference(trace, workers, slots)
                report = replay(trace, workers, slots)
                rows = report["outcomes"]
                self.assertEqual([r["id"] for r in rows], [r.id for r in sorted(trace, key=lambda r: r.arrival_ms)])
                self.assertEqual({r["id"]: (r["status"], r["start_ms"], r["end_ms"], r["wait_ms"])
                                  for r in rows}, expect)
                self.assertEqual((report["busy_worker_ms"], report["peak_queue"], report["window_ms"]),
                                 (busy, peak, window))
                for status in ("served", "timed_out", "queue_full"):
                    self.assertEqual(report[status], sum(r[0] == status for r in expect.values()))
                waits = sorted(r[-1] for r in expect.values() if r[0] == "served")
                self.assertEqual(report["p95_served_wait_ms"], waits[math.ceil(.95 * len(waits)) - 1] if waits else None)

    def test_timeout_wins_boundary_then_older_waiter_precedes_newcomer(self):
        trace = [Request("active", 0, 5, 0), Request("expires", 1, 1, 4),
                 Request("waiting", 1, 1, 5), Request("arrival", 5, 1, 0)]
        report = replay(trace, 1, 2)
        self.assertEqual([(r["id"], r["status"], r["end_ms"]) for r in report["outcomes"]],
                         [("active", "served", 5), ("expires", "timed_out", 5),
                          ("waiting", "served", 6), ("arrival", "timed_out", 5)])

    def test_cli_compares_fixture_and_skips_large_time_gaps(self):
        proc = cli(ROOT / "examples/preview-burst.csv", "--workers", "1", "2", "3", "--queue", "3")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        reports = json.loads(proc.stdout)
        self.assertEqual([(r["served"], r["timed_out"], r["queue_full"], r["p95_served_wait_ms"])
                          for r in reports], [(5, 5, 2, 16), (8, 2, 2, 12), (11, 0, 1, 10)])
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "trace.csv"
            path.write_text("id,arrival_ms,service_ms,patience_ms\nz,1000000000000,3,0\na,0,2,4\n")
            proc = cli(path, "--workers", "1", "--queue", "0", "--details", timeout=5)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            report, = json.loads(proc.stdout)
            self.assertEqual((report["busy_worker_ms"], report["window_ms"]), (5, 1000000000003))
            self.assertEqual([r["id"] for r in report["outcomes"]], ["a", "z"])

    def test_cli_diagnoses_bad_traces_and_capacity(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "bad.csv"
            for rows in ("a,1,0,1", "a,1,2,1\na,3,2,1", "a,0,1", "a,0,1,1,extra"):
                path.write_text("id,arrival_ms,service_ms,patience_ms\n" + rows)
                self.assertEqual(cli(path, "--workers", "1", "--queue", "0").returncode, 2)
        proc = cli(ROOT / "examples/preview-burst.csv", "--workers", "2", "0", "--queue", "3")
        self.assertEqual(proc.returncode, 2)
        self.assertFalse(proc.stdout)
