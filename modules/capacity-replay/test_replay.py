import json
import math
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import unittest

from replay import Request, Staffing, replay, replay_staffing


ROOT = Path(__file__).resolve().parent


def tick_reference(trace, workers, queue_limit, changes=(), selector=None):
    """Tiny traces only. Check every worker and every waiting request once per millisecond."""
    waiting, active, result = [], {}, {}
    peak = busy = target_time = drain_time = 0
    now = min(r.arrival_ms for r in trace) if trace else 0
    first = now
    while len(result) < len(trace):
        for change in changes:
            if change.at_ms <= now:
                workers = change.workers
        for name in list(active):
            req, start = active[name]
            if now == start + req.service_ms:
                result[name] = ("served", start, now, start - req.arrival_ms)
                del active[name]
        for req in waiting[:]:
            if now - req.arrival_ms >= req.patience_ms:
                result[req.id] = ("timed_out", None, now, now - req.arrival_ms)
                waiting.remove(req)
                if selector is not None:
                    selector.expire(req)
        while waiting and len(active) < workers:
            req = waiting[0] if selector is None else selector.pick()
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
                if selector is not None:
                    selector.add(req)
        peak = max(peak, len(waiting))
        busy += len(active)
        if len(result) < len(trace):
            target_time += workers
            drain_time += max(0, len(active) - workers)
        now += 1
    return result, busy, peak, now - 1 - first if trace else 0, target_time, drain_time


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
                expect, busy, peak, window, target_time, drain_time = tick_reference(trace, workers, slots)
                report = replay(trace, workers, slots)
                rows = report["outcomes"]
                self.assertEqual([r["id"] for r in rows], [r.id for r in sorted(trace, key=lambda r: r.arrival_ms)])
                self.assertEqual({r["id"]: (r["status"], r["start_ms"], r["end_ms"], r["wait_ms"])
                                  for r in rows}, expect)
                self.assertEqual((report["busy_worker_ms"], report["peak_queue"], report["window_ms"]),
                                 (busy, peak, window))
                self.assertEqual((report["target_worker_ms"], report["draining_worker_ms"]), (target_time, drain_time))
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

    def test_variable_capacity_matches_tick_oracle(self):
        rng = random.Random(9216)
        for case in range(400):
            with self.subTest(case=case):
                changes = [Staffing(t, rng.randrange(5)) for t in
                           [0, *sorted(rng.sample(range(1, 36), rng.randrange(7)))]]
                trace = [Request(str(j), rng.randrange(1, 24), rng.randint(1, 12), rng.randrange(9))
                         for j in range(rng.randrange(20))]
                slots = rng.randrange(5)
                result = replay_staffing(trace, changes, slots)
                expected, busy, peak, window, target, drain = tick_reference(trace, 0, slots, changes)
                self.assertEqual({r["id"]: (r["status"], r["start_ms"], r["end_ms"], r["wait_ms"])
                                  for r in result["outcomes"]}, expected)
                self.assertEqual((result["busy_worker_ms"], result["peak_queue"], result["window_ms"],
                                  result["target_worker_ms"], result["draining_worker_ms"]),
                                 (busy, peak, window, target, drain))
                self.assertEqual(result["allocated_worker_ms"], target + drain)

    def test_simultaneous_expiry_completion_restaffing_and_arrival(self):
        trace = [Request("first", 0, 5, 1), Request("expires", 1, 2, 4), Request("waits", 1, 3, 10),
                 Request("new", 5, 1, 2), Request("instant", 5, 1, 0)]
        changes = [Staffing(0, 1), Staffing(5, 0), Staffing(7, 1), Staffing(8, 0)]
        result = replay_staffing(trace, changes, 2)
        self.assertEqual([(r["id"], r["status"], r["start_ms"], r["end_ms"]) for r in result["outcomes"]],
                         [("first", "served", 0, 5), ("expires", "timed_out", None, 5),
                          ("waits", "served", 7, 10), ("new", "timed_out", None, 7),
                          ("instant", "timed_out", None, 5)])
        self.assertEqual((result["target_worker_ms"], result["draining_worker_ms"]), (6, 2))

    def test_staffing_cli_compares_fixed_and_surge(self):
        proc = cli(ROOT / "examples/preview-burst.csv", "--workers", "4",
                   "--staffing", ROOT / "examples/preview-staffing.csv", "--queue", "3")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        fixed, surge = json.loads(proc.stdout)
        self.assertEqual([(r["served"], r["target_worker_ms"], r["draining_worker_ms"],
                           r["p95_served_wait_ms"]) for r in (fixed, surge)], [(12, 124, 0, 5), (12, 80, 2, 6)])
        self.assertEqual(surge["staffing"], [{"at_ms": 0, "workers": 2}, {"at_ms": 3, "workers": 4},
                                            {"at_ms": 12, "workers": 2}])
        self.assertNotIn("outcomes", surge)
        self.assertEqual((fixed["allocated_worker_ms"], surge["allocated_worker_ms"]), (124, 82))

    def test_staffing_validation_and_sparse_window(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "staff.csv"
            for body in ("", "1,3", "0,2\n0,1", "0,2\n5,2\n4,1", "0,-1", "0,", "0,3,4"):
                path.write_text("at_ms,workers\n" + body)
                proc = cli(ROOT / "examples/preview-burst.csv", "--staffing", path, "--queue", "1")
                self.assertEqual(proc.returncode, 2, body)
                self.assertFalse(proc.stdout)
        late = 10**12
        staffing = [Staffing(0, 3), Staffing(5, 0), Staffing(late, 1), Staffing(late + 1, 0)]
        sparse = replay_staffing([Request("late", late-1, 3, 4)], staffing, 1)
        self.assertEqual((sparse["window_ms"], sparse["target_worker_ms"], sparse["draining_worker_ms"]),
                         (4, 1, 2))

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
