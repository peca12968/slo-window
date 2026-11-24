from itertools import product
import json
from pathlib import Path
import random
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from clock_bracket import solve


class BracketTests(unittest.TestCase):
    def test_cli_reports_inconsistent_data_and_rejects_bad_input(self):
        root = Path(__file__).parent
        plan = json.loads((root / "examples/checkout.json").read_text())
        plan["messages"].append({"id":"late-ack","from":"worker","to":"api","send_us":1100,"receive_us":1000})
        with TemporaryDirectory() as directory:
            path = Path(directory) / "capture.json"
            path.write_text(json.dumps(plan), encoding="utf-8")
            command = [sys.executable, root / "clock_bracket.py", path, "--explain"]
            result = subprocess.run(command, capture_output=True)
            self.assertEqual(result.returncode, 1)
            report = json.loads(result.stdout)
            self.assertEqual({e["message"] for e in report["cycle"]}, {"late-ack", "enqueue"})
            self.assertEqual(report["cycle_weight_us"], -50)
            plan["messages"][-1]["min_us"] = False
            path.write_text(json.dumps(plan), encoding="utf-8")
            bad = subprocess.run(command, capture_output=True)
            self.assertEqual((bad.returncode, bad.stdout), (2, b""))
            self.assertIn(b"integer min_us", bad.stderr)

    def test_explanation_paths_reconstruct_each_bound_including_one_sided_and_unknown(self):
        plan = json.loads((Path(__file__).parent / "examples/checkout.json").read_text())
        plan["hosts"].extend(["printer", "offline"])
        plan["messages"].append({"id":"print","from":"api","to":"printer","send_us":1,"receive_us":2})
        for h in plan["hosts"]:
            plan["queries"].append({"id":"to-"+h,"from":"api","to":h,"start_us":20,"end_us":30})
        report = solve(plan, explain=True)
        for q, r in zip(plan["queries"], report["queries"], strict=True):
            for path_name, key, sign in [("upper_path","upper_us",1), ("inverse_path","lower_us",-1)]:
                path = r[path_name]
                if path is None:
                    self.assertIsNone(r[key])
                    continue
                source, dest = (q["from"], q["to"]) if sign == 1 else (q["to"], q["from"])
                for edge in path:
                    self.assertEqual(edge["from"], source)
                    source = edge["to"]
                self.assertEqual(source, dest)
                self.assertEqual(r["local_delta_us"] + sign * sum(e["upper_offset_difference_us"] for e in path), r[key])
        self.assertEqual([(r["lower_us"], r["upper_us"]) for r in report["queries"][-2:]], [(9, None), (None, None)])

    def test_roundtrip_multi_hop_and_unconnected_hosts(self):
        plan = json.loads((Path(__file__).parent / "examples/checkout.json").read_text())
        plan["hosts"].append("isolated")
        report = solve(plan)
        self.assertEqual(report["offsets"], {
            "api": {"lower_us": 0, "upper_us": 0}, "worker": {"lower_us": -50, "upper_us": -30},
            "db": {"lower_us": -36, "upper_us": -12}, "isolated": {"lower_us": None, "upper_us": None}})
        self.assertEqual(report["queries"], [{"id": "unconfirmed", "lower_us": -8, "upper_us": 12},
                                             {"id": "db-event", "lower_us": 24, "upper_us": 48}])
        # A disconnected component can still have inconsistent observations.
        plan["messages"].append({"id":"bad","from":"isolated","to":"isolated","send_us":6,"receive_us":3})
        conflict = solve(plan)
        self.assertFalse(conflict["consistent"])
        self.assertEqual((conflict["cycle"][0]["message"], conflict["cycle_weight_us"]), ("bad", -3))

    def test_shortest_paths_match_all_feasible_integer_offsets(self):
        rng = random.Random(2301)
        for _ in range(240):
            hosts = ["a", "b", "c"]
            edges = [{"id": h, "from": "a", "to": h, "send_us": 0, "receive_us": 5, "max_us": 10}
                     for h in hosts[1:]]
            for i in range(rng.randrange(1, 6)):
                a, b = rng.sample(hosts, 2)
                item = {"id": str(i), "from": a, "to": b, "send_us": rng.randrange(9),
                        "receive_us": rng.randrange(9), "min_us": rng.randrange(3)}
                if rng.randrange(2):
                    item["max_us"] = item["min_us"] + rng.randrange(9)
                edges.append(item)
            queries = [{"id": a+b, "from": a, "to": b, "start_us": 100, "end_us": 103}
                       for a, b in product(hosts, repeat=2)]
            result = solve({"hosts": hosts, "reference": "a", "messages": edges, "queries": queries}, pairs=True)
            possible = []
            for y, z in product(range(-5, 6), repeat=2):
                off = {"a": 0, "b": y, "c": z}
                if all(m.get("min_us", 0) <= m["receive_us"] - m["send_us"] + off[m["to"]] - off[m["from"]]
                       <= m.get("max_us", float("inf")) for m in edges):
                    possible.append(off)
            self.assertEqual(result["consistent"], bool(possible))
            if possible:
                for q, r in zip(queries, result["queries"], strict=True):
                    values = [3 + off[q["to"]] - off[q["from"]] for off in possible]
                    self.assertEqual((r["lower_us"], r["upper_us"]), (min(values), max(values)))
                for p in result["offset_pairs_us"]:
                    values = [off[p["to"]] - off[p["from"]] for off in possible]
                    self.assertEqual((p["lower_us"], p["upper_us"]), (min(values), max(values)))
            else:
                cycle = result["cycle"]
                for i, edge in enumerate(cycle):
                    self.assertEqual(cycle[i-1]["to"], edge["from"])
                    msg = next(m for m in edges if m["id"] == edge["message"])
                    delta = msg["receive_us"] - msg["send_us"]
                    expected = ((msg["to"], msg["from"], delta-msg.get("min_us", 0)) if edge["bound"] == "min_us"
                                else (msg["from"], msg["to"], msg["max_us"]-delta))
                    self.assertEqual((edge["from"], edge["to"], edge["upper_offset_difference_us"]), expected)
                self.assertLess(sum(e["upper_offset_difference_us"] for e in cycle), 0)
