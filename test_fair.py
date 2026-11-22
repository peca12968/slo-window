import json
from pathlib import Path
from random import Random
from tempfile import TemporaryDirectory
import unittest

from replay import Request, Staffing, replay, replay_staffing
from test_replay import ROOT, cli, tick_reference


class LiteralRounds:
    """Small reference: visit each tenant and grant one quantum at a time."""
    def __init__(self, policy):
        self.jobs = policy["jobs"]
        self.grants = policy["quanta"]
        self.ring = []
        self.waiting = {t: [] for t in self.grants}
        self.balance = dict.fromkeys(self.grants, 0)
        self.fresh_visit = True

    def add(self, req):
        tenant = self.jobs[req.id]["tenant"]
        if not self.waiting[tenant]:
            self.ring.append(tenant)
        self.waiting[tenant].append(req)

    def expire(self, req):
        tenant = self.jobs[req.id]["tenant"]
        self.waiting[tenant].remove(req)
        if not self.waiting[tenant]:
            if self.ring[0] == tenant:
                self.fresh_visit = True
            self.ring.remove(tenant)
            self.balance[tenant] = 0

    def pick(self):
        while self.ring:
            name = self.ring[0]
            req = self.waiting[name][0]
            if self.fresh_visit:
                self.balance[name] += self.grants[name]
            cost = self.jobs[req.id]["cost"]
            if self.balance[name] >= cost:
                self.balance[name] -= cost
                self.fresh_visit = False
                self.expire(req)
                return req
            self.ring.append(self.ring.pop(0))
            self.fresh_visit = True
        raise AssertionError("nothing to dispatch")


class FairTests(unittest.TestCase):
    def test_tick_and_literal_rounds_with_deadlines_and_staffing(self):
        rng = Random(1972)
        for case in range(400):
            trace = [Request(str(i), rng.randrange(12), rng.randint(1, 6), rng.randrange(12))
                     for i in range(rng.randrange(22))]
            slots = rng.randrange(8)
            changes = [Staffing(t, rng.randrange(4)) for t in (0, 3, 6, 11)]
            quanta = {t: rng.randint(1, 5) for t in ("a", "b", "c")}
            jobs = {r.id: {"tenant": rng.choice(list(quanta)), "cost": rng.randint(1, 17)} for r in trace}
            policy = {"quanta": quanta, "jobs": jobs}
            result = replay_staffing(trace, changes, slots, fair_policy=policy)
            rows, busy, peak, window, target, drain = tick_reference(trace, changes[0].workers, slots, changes,
                                                                     LiteralRounds(policy))
            actual = {r["id"]: (r["status"], r["start_ms"], r["end_ms"], r["wait_ms"]) for r in result["outcomes"]}
            self.assertEqual(actual, rows, case)
            self.assertEqual((result["busy_worker_ms"], result["peak_queue"], result["window_ms"],
                              result["target_worker_ms"], result["draining_worker_ms"]), (busy, peak, window, target, drain))

    def test_cli_compares_identical_inputs_and_reports_tenant_costs(self):
        proc = cli(ROOT / "examples/tenant-burst.csv", "--workers", "1", "--queue", "10",
                   "--staffing", ROOT / "examples/preview-staffing.csv", "--compare-fair",
                   ROOT / "examples/tenant-policy.json", "--details")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        fifo, fair, surge_fifo, surge_fair = json.loads(proc.stdout)
        self.assertEqual([r["discipline"] for r in (fifo, fair, surge_fifo, surge_fair)],
                         ["fifo", "deficit_round_robin"] * 2)
        self.assertEqual((fifo["served"], fair["served"]), (5, 8))
        self.assertEqual((fifo["timed_out"], fair["timed_out"]), (6, 3))
        self.assertEqual(fair["tenants"]["thumbnail"], {"served": 3, "timed_out": 3, "queue_full": 0,
                         "served_cost": 3, "busy_worker_ms": 3, "p95_served_wait_ms": 11})
        self.assertIsNone(fifo["tenants"]["thumbnail"]["p95_served_wait_ms"])
        self.assertEqual([r["start_ms"] for r in fair["outcomes"] if r["id"].startswith("thumb")],
                         [6, 7, 12, None, None, None])
        for report in (fifo, fair, surge_fifo, surge_fair):
            for metric in ("served", "timed_out", "queue_full", "busy_worker_ms"):
                self.assertEqual(sum(t[metric] for t in report["tenants"].values()), report[metric])

    def test_expiration_and_huge_estimate_are_independent_of_service_duration(self):
        trace = [Request("first", 0, 2, 0), Request("late", 1, 1, 1), Request("ok", 1, 3, 2)]
        policy = {"quanta": {"q": 1}, "jobs": {r.id: {"tenant": "q", "cost": 10**30} for r in trace}}
        report = replay(trace, 1, 2, fair_policy=policy)
        self.assertEqual([(r["status"], r["end_ms"]) for r in report["outcomes"]],
                         [("served", 2), ("timed_out", 2), ("served", 5)])

    def test_cli_rejects_broken_assignment_without_partial_output(self):
        with TemporaryDirectory() as tmp:
            policy = Path(tmp) / "policy.json"
            for text in ('null', '{"jobs":{},"jobs":{},"quanta":{"q":1}}',
                         '{"jobs":{},"quanta":{"q":1}}', '{"quanta": {"q": true},"jobs":{}}'):
                policy.write_text(text)
                proc = cli(ROOT / "examples/tenant-burst.csv", "--workers", "1", "--queue", "10",
                           "--compare-fair", policy)
                self.assertEqual(proc.returncode, 2)
                self.assertFalse(proc.stdout)
